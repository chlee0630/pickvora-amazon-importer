import { classifyFailure } from "../../utils/failure-classifier.server.js";
import { recordApiMetric } from "./monitoring-service.server.js";

export async function trackApiCall(provider, operation, handler, details = {}) {
  const startedAt = Date.now();
  try {
    const result = await handler();
    recordApiMetric(provider, "success", {
      operation,
      durationMs: Date.now() - startedAt,
      ...details,
    });
    return result;
  } catch (err) {
    const failure = classifyFailure(err);
    recordApiMetric(provider, "failure", {
      operation,
      durationMs: Date.now() - startedAt,
      timedOut: failure.code === "TIMEOUT" || /timed out|timeout/i.test(failure.reason),
      failureCategory: failure.category,
      retryable: failure.retryable,
      failureReason: failure.reason,
      status: failure.status,
      ...details,
    });
    throw err;
  }
}
