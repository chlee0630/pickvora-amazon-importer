const SENSITIVE_KEYS = new Set([
  "accessToken",
  "apiKey",
  "api_key",
  "authorization",
  "email",
  "phone",
  "phoneNumber",
  "phone_number",
  "address",
  "address1",
  "address2",
  "address_line1",
  "address_line2",
  "shippingAddress",
  "shipping_address",
  "token",
]);

const DEFAULT_LOG_PAYLOAD_MAX_CHARS = 5000;

export function maskSensitivePayload(value) {
  if (Array.isArray(value)) return value.map(maskSensitivePayload);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key) ? "[masked]" : maskSensitivePayload(item),
    ])
  );
}

export function parseStoredPayload(payload) {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return { rawPayload: "[unparseable]" };
  }
}

export function logFailureAudit(event, details = {}) {
  console.log(truncateLogLine(JSON.stringify(maskSensitivePayload({
    event,
    layer: "queue_failure_audit",
    timestamp: new Date().toISOString(),
    ...details,
  }))));
}

function truncateLogLine(value) {
  // eslint-disable-next-line no-undef
  const maxChars = Number.parseInt(process.env.LOG_PAYLOAD_MAX_CHARS || "", 10) || DEFAULT_LOG_PAYLOAD_MAX_CHARS;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...[truncated]` : value;
}
