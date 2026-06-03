import prisma from "../db.server.js";
import {
  claimNextOrderJob,
  completeOrderJob,
  enqueueTrackingPollJob,
  failOrderJob,
} from "../queues/order-queue.server.js";
import { getOrderProvider } from "../services/order-providers/index.server.js";
import { recordMonitoringEvent } from "../services/monitoring/monitoring-service.server.js";
import { classifyFailure } from "../utils/failure-classifier.server.js";
import { getScalingConfig } from "../utils/scaling-config.server.js";
import { trackWorkerJob } from "../services/monitoring/worker-latency.server.js";
import { recordWorkerHeartbeat } from "../services/monitoring/health-monitor.service.js";
import { processTrackingReceipt } from "../services/tracking/tracking-receipt.server.js";

const JOB_TIMEOUT_MS = 30000;
const TRACKING_LOCK_TTL_MS = 10 * 60 * 1000;
const ELIGIBLE_POLLING_STATES = new Set(["ZINC_SUBMITTED", "ORDERED"]);

let workerRunning = false;

class PermanentTrackingError extends Error {}

export async function runTrackingPollingWorkerOnce() {
  if (workerRunning) return;
  workerRunning = true;
  recordWorkerHeartbeat("tracking_polling_worker").catch((err) =>
    console.error("Tracking polling worker heartbeat error:", err?.message || err)
  );

  try {
    const { trackingWorkerConcurrency } = getScalingConfig();
    // Safe default is intentionally low to avoid provider/API bursts.
    await Promise.all(
      Array.from({ length: trackingWorkerConcurrency }, () => drainTrackingJobs())
    );
  } finally {
    workerRunning = false;
  }
}

async function drainTrackingJobs() {
  let job = await claimNextOrderJob({ types: ["tracking.poll"] });
  while (job) {
    recordWorkerHeartbeat("tracking_polling_worker", { shop: job.shop }).catch((err) =>
      console.error("Tracking polling worker heartbeat error:", err?.message || err)
    );
    try {
      await trackWorkerJob("tracking_polling_worker", job, async () => {
        const shouldComplete = await withTimeout(processTrackingPollJob(job), JOB_TIMEOUT_MS);
        if (shouldComplete !== false) {
          await completeOrderJob(job.id);
        }
      }, { timeoutMs: JOB_TIMEOUT_MS });
    } catch (err) {
      logTrackingEvent("tracking_poll_error", job, {
        error: err.message,
        retryable: isRetryableError(err),
      });

      await releaseTrackingLock(job, err);
      await failOrderJob(job, err, { retryable: isRetryableError(err) });
    }

    job = await claimNextOrderJob({ types: ["tracking.poll"] });
  }
}

export function initTrackingPollingWorkers() {
  // eslint-disable-next-line no-undef
  const g = globalThis;
  if (g.__trackingPollingWorkerInterval) return;

  g.__trackingPollingWorkerInterval = setInterval(() => {
    runTrackingPollingWorkerOnce().catch((err) =>
      console.error("Tracking polling worker interval error:", err)
    );
  }, 60 * 1000);

  runTrackingPollingWorkerOnce().catch((err) =>
    console.error("Tracking polling worker init error:", err)
  );
}

async function processTrackingPollJob(job) {
  const existingProviderOrder = await getProviderOrder(job);
  if (!existingProviderOrder) {
    logTrackingEvent("tracking_poll_skipped", job, { reason: "provider_order_missing" });
    throw new PermanentTrackingError("Provider order id is missing");
  }
  if (!isEligibleForAutomaticPolling(existingProviderOrder)) {
    logTrackingEvent("tracking_poll_skipped", job, {
      reason: "ineligible_provider_status",
      providerStatus: existingProviderOrder.status,
    });
    return;
  }

  const providerOrder = await acquireTrackingLock(job);
  if (!providerOrder) {
    throw retryableError("Tracking polling lock is held by another worker", "LOCKED");
  }

  if (providerOrder.trackingNumber && providerOrder.trackingCarrier) {
    logTrackingEvent("tracking_duplicate_skipped", job, {
      providerOrderId: providerOrder.providerOrderId,
      trackingNumber: providerOrder.trackingNumber,
      carrier: providerOrder.trackingCarrier,
    });
    return;
  }

  validateProviderOrder(providerOrder);

  const provider = getOrderProvider(job.provider);
  const tracking = sanitizeTracking(await provider.getTracking(providerOrder.providerOrderId));
  const providerState = normalizeProviderState(tracking.status);

  await prisma.providerOrder.update({
    where: { id: providerOrder.id },
    data: {
      responsePayload: JSON.stringify(tracking.responsePayload || {}),
      status: providerState,
      processingLockedAt: null,
      lastError: null,
    },
  });

  if (providerState === "FAILED") {
    throw new PermanentTrackingError("Zinc order failed before tracking was available");
  }

  if (!tracking.trackingNumber) {
    return handleTrackingNotReady(job, providerOrder, tracking);
  }

  validateTracking(tracking);

  await processTrackingReceipt({
    job,
    providerOrder,
    tracking,
    providerState,
    source: "tracking.poll",
  });
}

export async function handleTrackingNotReady(job, providerOrder, tracking, deps = {}) {
  const exhaustionMessage = "Tracking not received after max polling attempts";
  const {
    updateProviderOrder = async (data) => prisma.providerOrder.update({
      where: { id: providerOrder.id },
      data,
    }),
    enqueueTrackingPollJobFn = enqueueTrackingPollJob,
    recordMonitoringEventFn = recordMonitoringEvent,
    logTrackingEventFn = logTrackingEvent,
  } = deps;

  if (isTrackingPollingExhausted(job)) {
    await updateProviderOrder({
      status: "MANUAL_REVIEW",
      providerFailureCode: "TRACKING_NOT_RECEIVED",
      providerFailureMessage: exhaustionMessage,
      lastError: exhaustionMessage,
      processingLockedAt: null,
    });

    logTrackingEventFn("tracking_polling_exhausted", job, {
      providerOrderId: providerOrder.providerOrderId,
      providerStatus: tracking.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    });
    recordMonitoringEventFn("tracking_polling_exhausted", {
      jobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      providerOrderId: providerOrder.providerOrderId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      failureCategory: "TRACKING_TIMEOUT",
      failureReason: exhaustionMessage,
    });

    throw new PermanentTrackingError(exhaustionMessage);
  }

  logTrackingEventFn("tracking_not_ready", job, {
    providerOrderId: providerOrder.providerOrderId,
    providerStatus: tracking.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
  });
  await enqueueTrackingPollJobFn({
    shop: job.shop,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    delayMs: getTrackingPollIntervalMs(),
    rescheduleExisting: true,
  });
  return false;
}

async function acquireTrackingLock(job) {
  const now = new Date();
  const staleLock = new Date(Date.now() - TRACKING_LOCK_TTL_MS);
  const providerOrder = await getProviderOrder(job);

  if (!providerOrder) return null;

  const claimed = await prisma.providerOrder.updateMany({
    where: {
      id: providerOrder.id,
      providerOrderId: { not: null },
      status: { in: Array.from(ELIGIBLE_POLLING_STATES) },
      OR: [
        { processingLockedAt: null },
        { processingLockedAt: { lt: staleLock } },
      ],
    },
    data: {
      processingLockedAt: now,
      status: "PROCESSING",
      lastError: null,
    },
  });

  if (claimed.count !== 1) return null;
  return prisma.providerOrder.findUnique({ where: { id: providerOrder.id } });
}

function getProviderOrder(job) {
  return prisma.providerOrder.findUnique({
    where: {
      shop_shopifyOrderId_provider: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
      },
    },
  });
}

function isEligibleForAutomaticPolling(providerOrder) {
  if (providerOrder.fulfillmentSyncedAt || providerOrder.status === "FULFILLED") return false;
  if (providerOrder.status === "MANUAL_REVIEW" || providerOrder.status === "FAILED") return false;
  return ELIGIBLE_POLLING_STATES.has(providerOrder.status);
}

export function isTrackingPollingExhausted(job) {
  return Number(job?.attempts || 0) >= Number(job?.maxAttempts || 0);
}

function getTrackingPollIntervalMs() {
  return getScalingConfig().trackingPollIntervalMinutes * 60 * 1000;
}

async function releaseTrackingLock(job, error) {
  const message = error?.message || String(error);
  const retryable = isRetryableError(error);
  await prisma.providerOrder.updateMany({
    where: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      trackingReceivedAt: null,
    },
    data: {
      status: retryable ? "ZINC_SUBMITTED" : "MANUAL_REVIEW",
      processingLockedAt: null,
      lastError: message.slice(0, 1000),
    },
  });
}

function validateProviderOrder(providerOrder) {
  if (!providerOrder.providerOrderId) {
    throw new PermanentTrackingError("Provider order id is missing");
  }
  if (["TRACKING_RECEIVED", "FULFILLED"].includes(providerOrder.status)) {
    throw new PermanentTrackingError(`Tracking already finalized for state ${providerOrder.status}`);
  }
  if (providerOrder.status === "FAILED") {
    throw new PermanentTrackingError("Provider order is failed");
  }
}

function sanitizeTracking(tracking) {
  return {
    status: tracking.status ? String(tracking.status).trim() : null,
    trackingNumber: tracking.trackingNumber ? String(tracking.trackingNumber).trim().toUpperCase() : null,
    trackingCompany: tracking.trackingCompany ? String(tracking.trackingCompany).trim() : null,
    trackingUrl: tracking.trackingUrl ? String(tracking.trackingUrl).trim() : null,
    responsePayload: tracking.responsePayload || {},
  };
}

function validateTracking(tracking) {
  if (!/^[A-Z0-9][A-Z0-9 -]{5,63}$/.test(tracking.trackingNumber || "")) {
    throw new PermanentTrackingError("Malformed tracking number");
  }
  if (!/^[A-Za-z0-9 .&'-]{2,60}$/.test(tracking.trackingCompany || "")) {
    throw new PermanentTrackingError("Invalid tracking carrier");
  }
  if (tracking.trackingUrl && !/^https?:\/\//i.test(tracking.trackingUrl)) {
    throw new PermanentTrackingError("Invalid tracking URL");
  }
}

function normalizeProviderState(status) {
  const normalized = String(status || "").toLowerCase();
  if (["failed", "cancelled", "canceled"].includes(normalized)) return "FAILED";
  if (["ordered", "submitted", "processing", "shipped"].includes(normalized)) return "ORDERED";
  return "ZINC_SUBMITTED";
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(retryableError("Tracking poll timed out", "TIMEOUT")), timeoutMs);
    }),
  ]);
}

function retryableError(message, code = "RETRYABLE") {
  const error = new Error(message);
  error.retryable = true;
  error.code = code;
  return error;
}

function isRetryableError(error) {
  if (error instanceof PermanentTrackingError) return false;
  return classifyFailure(error).retryable;
}

function logTrackingEvent(event, job, details = {}) {
  const sanitizedDetails = { ...details };
  if (sanitizedDetails.trackingNumber) {
    sanitizedDetails.trackingNumber = maskTrackingNumber(sanitizedDetails.trackingNumber);
  }
  console.log(JSON.stringify({
    event,
    layer: "tracking_polling_worker",
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    ...sanitizedDetails,
  }));
}

function maskTrackingNumber(value) {
  const text = String(value || "");
  if (text.length <= 4) return "[masked]";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}
