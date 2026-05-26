import { maskSensitivePayload } from "./failure-audit-log.server.js";
import { getScalingConfig } from "./scaling-config.server.js";

const DEFAULT_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30000,
};

export async function withApiRetry(operation, {
  provider,
  operationName,
  maxAttempts = DEFAULT_POLICY.maxAttempts,
  baseDelayMs = DEFAULT_POLICY.baseDelayMs,
  maxDelayMs = DEFAULT_POLICY.maxDelayMs,
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!isRetryableApiError(err) || attempt >= maxAttempts) {
        throw err;
      }

      const retryAfterMs = getRetryAfterMs(err);
      const delayMs = retryAfterMs ?? getBackoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      logApiRetry("api_retry_scheduled", {
        provider,
        operationName,
        attempt,
        maxAttempts,
        delayMs,
        statusCode: err.statusCode || err.status,
        code: err.code,
        message: err.message,
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function truncateLogPayload(value) {
  const { logPayloadMaxChars } = getScalingConfig();
  const serialized = typeof value === "string" ? value : JSON.stringify(maskSensitivePayload(value));
  if (serialized.length <= logPayloadMaxChars) return serialized;
  return `${serialized.slice(0, logPayloadMaxChars)}...[truncated]`;
}

export function isRetryableApiError(err) {
  const status = Number(err?.status || err?.statusCode);
  return (
    err?.retryable === true ||
    err?.code === "TIMEOUT" ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(err?.code) ||
    [429, 500, 502, 503, 504].includes(status)
  );
}

function getRetryAfterMs(err) {
  const retryAfter = err?.retryAfter;
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);
  const dateMs = new Date(retryAfter).getTime();
  return Number.isFinite(dateMs) ? Math.max(dateMs - Date.now(), 0) : null;
}

function getBackoffDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(baseDelayMs * (2 ** (attempt - 1)) + jitter, maxDelayMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logApiRetry(event, details) {
  console.log(JSON.stringify(maskSensitivePayload({
    event,
    layer: "api_retry",
    ...details,
  })));
}
