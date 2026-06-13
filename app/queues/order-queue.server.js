import prisma from "../db.server.js";
import { moveJobToDeadLetterQueue, appendRetryHistory } from "./dead-letter-queue.server.js";
import { classifyFailure, getFailureMessage } from "../utils/failure-classifier.server.js";
import { logFailureAudit } from "../utils/failure-audit-log.server.js";
import { sanitizeOrderCreateQueuePayload } from "../utils/order-queue-job-payload.server.js";
import { scheduleQueueHealthCheck } from "../services/monitoring/queue-health.server.js";
import { recordMonitoringEvent, recordRetryMetric } from "../services/monitoring/monitoring-service.server.js";
import { getScalingConfig } from "../utils/scaling-config.server.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 10 * 60 * 1000;

export async function enqueueOrderProcessingJob({ shop, shopifyOrderId, payload, provider = "zinc" }) {
  const safePayload = sanitizeOrderCreateQueuePayload(payload || {});
  const job = await prisma.orderQueueJob.upsert({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "order.create",
        shopifyOrderId,
      },
    },
    create: {
      shop,
      type: "order.create",
      shopifyOrderId,
      provider,
      payload: JSON.stringify(safePayload),
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    },
    update: {
      status: "pending",
      payload: JSON.stringify(safePayload),
      attempts: 0,
      lastError: null,
      retryHistory: null,
      failureReason: null,
      failureCategory: null,
      dlqStatus: null,
      lastFailureAt: null,
      runAt: new Date(),
    },
  });

  scheduleOrderWorkerRun();
  scheduleQueueHealthCheck();
  return job;
}

export async function enqueueTrackingPollJob({
  shop,
  shopifyOrderId,
  provider = "zinc",
  delayMs,
  rescheduleExisting = false,
}) {
  const { trackingPollIntervalMinutes, trackingPollMaxAttempts } = getScalingConfig();
  const effectiveDelayMs = Number.isFinite(delayMs) ? delayMs : trackingPollIntervalMinutes * 60 * 1000;
  const runAt = new Date(Date.now() + effectiveDelayMs);
  const existingJob = await prisma.orderQueueJob.findUnique({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "tracking.poll",
        shopifyOrderId,
      },
    },
  });

  if (
    existingJob &&
    (existingJob.status === "pending" || (existingJob.status === "processing" && !rescheduleExisting))
  ) {
    logQueueEvent("tracking_poll_duplicate_skipped", {
      jobId: existingJob.id,
      shop,
      type: "tracking.poll",
      shopifyOrderId,
      provider,
      status: existingJob.status,
    });
    return existingJob;
  }

  const job = await prisma.orderQueueJob.upsert({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "tracking.poll",
        shopifyOrderId,
      },
    },
    create: {
      shop,
      type: "tracking.poll",
      shopifyOrderId,
      provider,
      runAt,
      maxAttempts: trackingPollMaxAttempts,
    },
    update: {
      status: "pending",
      runAt,
      lockedAt: null,
      completedAt: null,
      lastError: null,
      failureReason: null,
      failureCategory: null,
      dlqStatus: null,
      lastFailureAt: null,
    },
  });

  scheduleTrackingWorkerRun(effectiveDelayMs);
  scheduleQueueHealthCheck();
  return job;
}

export async function enqueueFraudCancelPollJob({
  shop,
  shopifyOrderId,
  provider = "zinc",
  cancelJobId,
  requestedAt,
  delayMs = 30 * 1000,
  rescheduleExisting = false,
}) {
  const runAt = new Date(Date.now() + delayMs);
  const payload = {
    cancelJobId: cancelJobId || null,
    requestedAt: requestedAt || new Date().toISOString(),
    source: "fraud_order_cancel",
  };
  const existingJob = await prisma.orderQueueJob.findUnique({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "fraud.cancel.poll",
        shopifyOrderId,
      },
    },
  });

  if (
    existingJob &&
    (existingJob.status === "pending" || (existingJob.status === "processing" && !rescheduleExisting))
  ) {
    logQueueEvent("fraud_cancel_poll_duplicate_skipped", {
      jobId: existingJob.id,
      shop,
      type: "fraud.cancel.poll",
      shopifyOrderId,
      provider,
      status: existingJob.status,
    });
    return existingJob;
  }

  const job = await prisma.orderQueueJob.upsert({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "fraud.cancel.poll",
        shopifyOrderId,
      },
    },
    create: {
      shop,
      type: "fraud.cancel.poll",
      shopifyOrderId,
      provider,
      payload: JSON.stringify(payload),
      runAt,
      maxAttempts: 8,
    },
    update: {
      status: "pending",
      payload: JSON.stringify(payload),
      runAt,
      lockedAt: null,
      completedAt: null,
      lastError: null,
      failureReason: null,
      failureCategory: null,
      dlqStatus: null,
      lastFailureAt: null,
    },
  });

  logQueueEvent("fraud_cancel_poll_job_enqueued", {
    jobId: job.id,
    shop,
    type: job.type,
    shopifyOrderId,
    provider,
  });
  scheduleOrderWorkerRun(delayMs);
  scheduleQueueHealthCheck();
  return job;
}

export async function enqueueFulfillmentUpdateJob({ shop, shopifyOrderId, provider = "zinc", payload }) {
  const job = await prisma.orderQueueJob.upsert({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "fulfillment.update",
        shopifyOrderId,
      },
    },
    create: {
      shop,
      type: "fulfillment.update",
      shopifyOrderId,
      provider,
      payload: JSON.stringify(payload || {}),
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    },
    update: {
      status: "pending",
      payload: JSON.stringify(payload || {}),
      attempts: 0,
      lockedAt: null,
      completedAt: null,
      lastError: null,
      retryHistory: null,
      failureReason: null,
      failureCategory: null,
      dlqStatus: null,
      lastFailureAt: null,
    },
  });

  logQueueEvent("fulfillment_update_job_enqueued", {
    jobId: job.id,
    shop,
    type: job.type,
    shopifyOrderId,
    provider,
  });
  scheduleFulfillmentWorkerRun();
  scheduleQueueHealthCheck();
  return job;
}

export async function claimNextOrderJob({ types = ["order.create"] } = {}) {
  const now = new Date();
  const staleLock = new Date(Date.now() - STALE_LOCK_MS);
  const job = await prisma.orderQueueJob.findFirst({
    where: {
      type: { in: types },
      OR: [
        { status: "pending", runAt: { lte: now } },
        { status: "processing", lockedAt: { lt: staleLock } },
      ],
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
  });

  if (!job) return null;

  const recoveringStaleJob = job.status === "processing" && job.lockedAt && job.lockedAt < staleLock;

  const claimed = await prisma.orderQueueJob.updateMany({
    where: {
      id: job.id,
      type: { in: types },
      OR: [
        { status: "pending" },
        { status: "processing", lockedAt: { lt: staleLock } },
      ],
    },
    data: {
      status: "processing",
      lockedAt: now,
      attempts: { increment: 1 },
    },
  });

  if (claimed.count !== 1) return null;

  if (recoveringStaleJob) {
    logFailureAudit("worker_crash_recovery_claimed", {
      jobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      lockedAt: job.lockedAt,
    });
    recordMonitoringEvent("worker_crash_recovery", {
      jobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      lockedAt: job.lockedAt,
    });
  }

  return prisma.orderQueueJob.findUnique({ where: { id: job.id } });
}

export async function completeOrderJob(jobId) {
  await prisma.orderQueueJob.update({
    where: { id: jobId },
    data: {
      status: "complete",
      completedAt: new Date(),
      lockedAt: null,
      lastError: null,
      failureReason: null,
      failureCategory: null,
      dlqStatus: null,
    },
  });
}

export async function failOrderJob(job, error, { retryable = true } = {}) {
  const failure = classifyFailure(error, { retryable });
  const message = getFailureMessage(error);
  const attempts = job.attempts;
  const exhausted = !failure.retryable || attempts >= job.maxAttempts;
  const delayMs = getBackoffDelayMs(attempts);
  const retryHistory = appendRetryHistory(job.retryHistory, {
    attempt: attempts,
    maxAttempts: job.maxAttempts,
    category: failure.category,
    retryable: failure.retryable,
    reason: failure.reason,
    code: failure.code,
    status: failure.status,
    failedAt: new Date().toISOString(),
    nextRunAt: exhausted ? null : new Date(Date.now() + delayMs).toISOString(),
  });

  const jobUpdate = {
    status: exhausted ? "failed" : "pending",
    lockedAt: null,
    runAt: exhausted ? job.runAt : new Date(Date.now() + delayMs),
    lastError: message.slice(0, 1000),
    failureReason: failure.reason,
    failureCategory: failure.category,
    retryHistory: JSON.stringify(retryHistory),
    lastFailureAt: new Date(),
    dlqStatus: exhausted ? "open" : null,
  };

  if (exhausted) {
    await prisma.$transaction(async (tx) => {
      await tx.orderQueueJob.update({
        where: { id: job.id },
        data: jobUpdate,
      });
      await moveJobToDeadLetterQueue({ ...job, retryHistory: JSON.stringify(retryHistory) }, failure, tx);
    });
  } else {
    await prisma.orderQueueJob.update({
      where: { id: job.id },
      data: jobUpdate,
    });
  }

  logFailureAudit("failure_classified", {
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts,
    maxAttempts: job.maxAttempts,
    failureCategory: failure.category,
    retryable: failure.retryable,
    failureReason: failure.reason,
  });

  if (exhausted) {
    recordMonitoringEvent("retry_exhausted", {
      jobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      attempts,
      maxAttempts: job.maxAttempts,
      retryable: failure.retryable,
      failureCategory: failure.category,
      failureReason: failure.reason,
    });
  } else {
    recordRetryMetric({
      jobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      attempts,
      maxAttempts: job.maxAttempts,
      failureCategory: failure.category,
      retryable: failure.retryable,
      delayMs,
    });
  }

  logQueueEvent(exhausted ? "order_job_retry_exhausted" : "order_job_retry_scheduled", {
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    attempts,
    maxAttempts: job.maxAttempts,
    retryable: failure.retryable,
    failureCategory: failure.category,
    delayMs: exhausted ? 0 : delayMs,
    error: message,
  });

  if (!exhausted) scheduleWorkerForJobType(job.type, delayMs);
  scheduleQueueHealthCheck();
}

export function scheduleOrderWorkerRun(delayMs = 0) {
  const run = () => {
    import("../workers/order-worker.server.js")
      .then(({ runOrderWorkerOnce }) => runOrderWorkerOnce())
      .catch((err) => console.error("Order worker schedule error:", err));
  };

  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    setTimeout(run, 0);
  }
}

export function scheduleTrackingWorkerRun(delayMs = 0) {
  const run = () => {
    import("../workers/tracking-polling-worker.server.js")
      .then(({ runTrackingPollingWorkerOnce }) => runTrackingPollingWorkerOnce())
      .catch((err) => console.error("Tracking worker schedule error:", err));
  };

  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    setTimeout(run, 0);
  }
}

export function scheduleFulfillmentWorkerRun(delayMs = 0) {
  const run = () => {
    import("../workers/fulfillment-update-worker.server.js")
      .then(({ runFulfillmentUpdateWorkerOnce }) => runFulfillmentUpdateWorkerOnce())
      .catch((err) => console.error("Fulfillment worker schedule error:", err));
  };

  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    setTimeout(run, 0);
  }
}

export function scheduleWorkerForJobType(type, delayMs = 0) {
  if (type === "tracking.poll") {
    scheduleTrackingWorkerRun(delayMs);
  } else if (type === "fulfillment.update") {
    scheduleFulfillmentWorkerRun(delayMs);
  } else {
    scheduleOrderWorkerRun(delayMs);
  }
}

function getBackoffDelayMs(attempts) {
  const delays = [0, 30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
  return delays[Math.min(Math.max(attempts, 1), delays.length - 1)];
}

function logQueueEvent(event, details) {
  console.log(JSON.stringify({
    event,
    layer: "order_queue",
    ...details,
  }));
}
