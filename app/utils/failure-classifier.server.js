const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503]);
const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "TIMEOUT",
  "REDIS_RECONNECT",
  "RETRYABLE",
  "LOCKED",
]);

const PERMANENT_PATTERNS = [
  /invalid address/i,
  /shipping address is incomplete/i,
  /invalid asin/i,
  /no imported amazon asin/i,
  /restricted product/i,
  /invalid tracking number/i,
  /malformed tracking number/i,
  /malformed .*payload/i,
  /unsupported destination/i,
  /shopify validation/i,
  /shopify order not found/i,
  /shopify order is cancelled/i,
  /already fulfilled/i,
  /provider order id is missing/i,
  /tracking has not been received/i,
  /payload does not match/i,
  /invalid carrier/i,
  /invalid tracking carrier/i,
  /invalid tracking url/i,
];

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /temporary network/i,
  /network failure/i,
  /socket hang up/i,
  /redis reconnect/i,
  /rate limit/i,
];

export function classifyFailure(error, { retryable } = {}) {
  const message = getFailureMessage(error);
  const status = Number(error?.status || error?.statusCode);
  const code = error?.code ? String(error.code) : null;

  if (retryable === false || PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      category: "permanent",
      retryable: false,
      reason: message,
      code,
      status: Number.isFinite(status) ? status : null,
    };
  }

  const isRetryable =
    retryable === true ||
    error?.retryable === true ||
    ["AbortError", "TimeoutError"].includes(error?.name) ||
    RETRYABLE_ERROR_CODES.has(code) ||
    RETRYABLE_HTTP_STATUSES.has(status) ||
    RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));

  return {
    category: isRetryable ? "retryable" : "permanent",
    retryable: isRetryable,
    reason: message,
    code,
    status: Number.isFinite(status) ? status : null,
  };
}

export function getFailureMessage(error) {
  return (error?.message || String(error || "Unknown queue failure")).slice(0, 1000);
}
