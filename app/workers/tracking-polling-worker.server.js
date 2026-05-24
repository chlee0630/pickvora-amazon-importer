import prisma from "../db.server.js";
import {
  claimNextOrderJob,
  completeOrderJob,
  enqueueFulfillmentUpdateJob,
  enqueueTrackingPollJob,
  failOrderJob,
} from "../queues/order-queue.server.js";
import { getOrderProvider } from "../services/order-providers/index.server.js";

const JOB_TIMEOUT_MS = 30000;
const POLLING_INTERVAL_MS = 30 * 60 * 1000;
const TRACKING_LOCK_TTL_MS = 10 * 60 * 1000;

let workerRunning = false;

class PermanentTrackingError extends Error {}

export async function runTrackingPollingWorkerOnce() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    let job = await claimNextOrderJob({ types: ["tracking.poll"] });
    while (job) {
      try {
        const shouldComplete = await withTimeout(processTrackingPollJob(job), JOB_TIMEOUT_MS);
        if (shouldComplete !== false) {
          await completeOrderJob(job.id);
        }
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
  } finally {
    workerRunning = false;
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
    logTrackingEvent("tracking_not_ready", job, {
      providerOrderId: providerOrder.providerOrderId,
      providerStatus: tracking.status,
    });
    await enqueueTrackingPollJob({
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      delayMs: POLLING_INTERVAL_MS,
    });
    return false;
  }

  validateTracking(tracking);

  const existingTracking = await findExistingTracking(job, tracking);
  if (existingTracking) {
    logTrackingEvent("tracking_log_duplicate_skipped", job, {
      providerOrderId: providerOrder.providerOrderId,
      trackingNumber: tracking.trackingNumber,
      carrier: tracking.trackingCompany,
    });
    return;
  }

  await prisma.trackingLog.create({
    data: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      providerOrderId: providerOrder.providerOrderId,
      trackingNumber: tracking.trackingNumber,
      carrier: tracking.trackingCompany,
      trackingUrl: tracking.trackingUrl,
      status: "TRACKING_RECEIVED",
      payload: JSON.stringify(tracking.responsePayload || {}),
    },
  });

  await prisma.providerOrder.update({
    where: { id: providerOrder.id },
    data: {
      status: "TRACKING_RECEIVED",
      trackingNumber: tracking.trackingNumber,
      trackingCarrier: tracking.trackingCompany,
      trackingUrl: tracking.trackingUrl,
      trackingReceivedAt: new Date(),
      processingLockedAt: null,
      lastError: null,
    },
  });

  await enqueueFulfillmentUpdateJob({
    shop: job.shop,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    payload: {
      providerOrderId: providerOrder.providerOrderId,
      trackingNumber: tracking.trackingNumber,
      carrier: tracking.trackingCompany,
      trackingUrl: tracking.trackingUrl,
    },
  });

  logTrackingEvent("tracking_received", job, {
    providerOrderId: providerOrder.providerOrderId,
    trackingNumber: tracking.trackingNumber,
    carrier: tracking.trackingCompany,
  });
}

async function acquireTrackingLock(job) {
  const now = new Date();
  const staleLock = new Date(Date.now() - TRACKING_LOCK_TTL_MS);
  const providerOrder = await prisma.providerOrder.findUnique({
    where: {
      shop_shopifyOrderId_provider: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
      },
    },
  });

  if (!providerOrder) return null;

  const claimed = await prisma.providerOrder.updateMany({
    where: {
      id: providerOrder.id,
      providerOrderId: { not: null },
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

async function findExistingTracking(job, tracking) {
  const existingProviderOrder = await prisma.providerOrder.findFirst({
    where: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      trackingNumber: tracking.trackingNumber,
      trackingCarrier: tracking.trackingCompany,
    },
  });
  if (existingProviderOrder?.trackingReceivedAt) return existingProviderOrder;

  return prisma.trackingLog.findUnique({
    where: {
      shop_shopifyOrderId_provider_trackingNumber_carrier: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        trackingNumber: tracking.trackingNumber,
        carrier: tracking.trackingCompany,
      },
    },
  });
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
  if (error?.retryable) return true;
  if (["AbortError", "TimeoutError"].includes(error?.name)) return true;
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "TIMEOUT"].includes(error?.code)) return true;
  return [429, 500, 502, 503].includes(Number(error?.status || error?.statusCode));
}

function logTrackingEvent(event, job, details = {}) {
  console.log(JSON.stringify({
    event,
    layer: "tracking_polling_worker",
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    ...details,
  }));
}
