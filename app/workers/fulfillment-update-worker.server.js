import {
  claimNextOrderJob,
  completeOrderJob,
  failOrderJob,
} from "../queues/order-queue.server.js";
import { classifyFailure } from "../utils/failure-classifier.server.js";
import { getScalingConfig } from "../utils/scaling-config.server.js";
import { trackWorkerJob } from "../services/monitoring/worker-latency.server.js";
import { recordFulfillmentMetric } from "../services/monitoring/monitoring-service.server.js";
import { recordWorkerHeartbeat } from "../services/monitoring/health-monitor.service.js";
import { processFulfillmentJob as processFulfillmentJobFromService } from "../services/fulfillment/fulfillment-sync.server.js";

const JOB_TIMEOUT_MS = 30000;

let workerRunning = false;

export async function runFulfillmentUpdateWorkerOnce() {
  if (workerRunning) return;
  workerRunning = true;
  recordWorkerHeartbeat("fulfillment_update_worker").catch((err) =>
    console.error("Fulfillment update worker heartbeat error:", err?.message || err)
  );

  try {
    const { fulfillmentWorkerConcurrency } = getScalingConfig();
    // Safe default is intentionally low; fulfillment duplicate checks remain authoritative.
    await Promise.all(
      Array.from({ length: fulfillmentWorkerConcurrency }, () => drainFulfillmentJobs())
    );
  } finally {
    workerRunning = false;
  }
}

async function drainFulfillmentJobs() {
  let job = await claimNextOrderJob({ types: ["fulfillment.update"] });
  while (job) {
    recordWorkerHeartbeat("fulfillment_update_worker", { shop: job.shop }).catch((err) =>
      console.error("Fulfillment update worker heartbeat error:", err?.message || err)
    );
    try {
      await trackWorkerJob("fulfillment_update_worker", job, async () => {
        await withTimeout(processFulfillmentJobFromService(job), JOB_TIMEOUT_MS);
        await completeOrderJob(job.id);
      }, { timeoutMs: JOB_TIMEOUT_MS });
    } catch (err) {
      recordFulfillmentMetric("fulfillment_failure", {
        jobId: job.id,
        shop: job.shop,
        type: job.type,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        attempts: job.attempts,
        error: err.message,
        retryable: isRetryableError(err),
      });
      logFulfillmentEvent("fulfillment_job_error", job, {
        error: err.message,
        retryable: isRetryableError(err),
      });

      await failOrderJob(job, err, { retryable: isRetryableError(err) });
    }

    job = await claimNextOrderJob({ types: ["fulfillment.update"] });
  }
}

export function initFulfillmentUpdateWorkers() {
  // eslint-disable-next-line no-undef
  const g = globalThis;
  if (g.__fulfillmentUpdateWorkerInterval) return;

  g.__fulfillmentUpdateWorkerInterval = setInterval(() => {
    runFulfillmentUpdateWorkerOnce().catch((err) =>
      console.error("Fulfillment update worker interval error:", err)
    );
  }, 60 * 1000);

  runFulfillmentUpdateWorkerOnce().catch((err) =>
    console.error("Fulfillment update worker init error:", err)
  );
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(retryableError("Fulfillment update timed out", "TIMEOUT")), timeoutMs);
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
  return classifyFailure(error).retryable;
}

function logFulfillmentEvent(event, job, details = {}) {
  const sanitizedDetails = { ...details };
  if (sanitizedDetails.trackingNumber) {
    sanitizedDetails.trackingNumber = maskTrackingNumber(sanitizedDetails.trackingNumber);
  }
  console.log(JSON.stringify({
    event,
    layer: "fulfillment_update_worker",
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
