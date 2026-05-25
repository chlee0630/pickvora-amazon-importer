import { classifyFailure } from "../../utils/failure-classifier.server.js";
import { recordWorkerMetric } from "./monitoring-service.server.js";

export async function trackWorkerJob(workerName, job, handler, { timeoutMs } = {}) {
  const startedAt = Date.now();
  try {
    const result = await handler();
    recordWorkerMetric(workerName, "success", buildDetails(job, {
      durationMs: Date.now() - startedAt,
      timeoutMs,
    }));
    return result;
  } catch (err) {
    const failure = classifyFailure(err);
    const durationMs = Date.now() - startedAt;
    recordWorkerMetric(workerName, "failure", buildDetails(job, {
      durationMs,
      timeoutMs,
      timedOut: failure.code === "TIMEOUT" || /timed out|timeout/i.test(failure.reason),
      failureCategory: failure.category,
      retryable: failure.retryable,
      failureReason: failure.reason,
    }));
    throw err;
  }
}

function buildDetails(job, details) {
  return {
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    ...details,
  };
}
