import { maskSensitivePayload } from "../../utils/failure-audit-log.server.js";

export function logAnalyticsEvent(event, details = {}) {
  try {
    console.log(JSON.stringify(maskSensitivePayload(normalizeAnalyticsPayload({
      event,
      layer: "analytics",
      timestamp: new Date().toISOString(),
      ...details,
    }))));
  } catch (err) {
    console.error("Analytics logging failed:", err?.message || err);
  }
}

function normalizeAnalyticsPayload(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (Array.isArray(value)) return value.map(normalizeAnalyticsPayload);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeAnalyticsPayload(item)])
  );
}
