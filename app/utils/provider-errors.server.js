import { classifyFailure, getFailureMessage } from "./failure-classifier.server.js";
import { maskSensitivePayload } from "./failure-audit-log.server.js";

export class NormalizedProviderError extends Error {
  constructor(normalized) {
    super(normalized.message);
    this.name = "NormalizedProviderError";
    Object.assign(this, normalized);
    this.retryable = normalized.retryable;
    this.permanent = normalized.permanent;
    this.manualReviewRequired = normalized.manual_review_required;
  }
}

export function normalizeProviderError(error, provider = "unknown") {
  if (error instanceof NormalizedProviderError) return error;

  const failure = classifyFailure(error);
  const rawStatus = Number(error?.status || error?.statusCode);
  const retryable = Boolean(error?.retryable ?? failure.retryable);
  const normalized = {
    provider,
    provider_order_id: error?.providerOrderId || null,
    code: String(error?.code || error?.errorCode || error?.statusCode || failure.code || "PROVIDER_ERROR"),
    message: getFailureMessage(error),
    retryable,
    permanent: !retryable,
    manual_review_required: Boolean(error?.manualReviewRequired || !retryable),
    raw_status: Number.isFinite(rawStatus) ? rawStatus : failure.status,
    raw_response: maskSensitivePayload(error?.rawResponse || error?.responsePayload || null),
    occurred_at: new Date().toISOString(),
  };

  return new NormalizedProviderError(normalized);
}

export function logProviderEvent(event, details = {}) {
  console.log(JSON.stringify(maskSensitivePayload({
    event,
    layer: "provider_failover",
    timestamp: new Date().toISOString(),
    ...details,
  })));
}
