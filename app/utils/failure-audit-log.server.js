const SENSITIVE_KEYS = new Set([
  "accessToken",
  "apiKey",
  "api_key",
  "authorization",
  "email",
  "phone",
  "phoneNumber",
  "phone_number",
  "token",
]);

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
  console.log(JSON.stringify(maskSensitivePayload({
    event,
    layer: "queue_failure_audit",
    timestamp: new Date().toISOString(),
    ...details,
  })));
}
