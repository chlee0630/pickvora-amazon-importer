import prisma from "../../db.server.js";
import { maskSensitivePayload } from "../../utils/failure-audit-log.server.js";

const counters = new Map();
const rollingWindows = new Map();

const RETRY_SPIKE_WINDOW_MS = 5 * 60 * 1000;
const RETRY_SPIKE_THRESHOLD = 10;
const PERSISTENT_EVENT_TYPES = new Set([
  "api_failure",
  "api_timeout",
  "dlq_inserted",
  "dlq_replay_attempt",
  "queue_congestion",
  "retry_exhausted",
  "retry_spike",
  "worker_failure",
  "worker_timeout",
  "worker_crash_recovery",
  "fulfillment_failure",
]);

export function recordMonitoringEvent(eventType, details = {}, options = {}) {
  try {
    const payload = normalizePayload({
      event: eventType,
      layer: "monitoring",
      timestamp: new Date().toISOString(),
      ...details,
    });

    incrementCounter(eventType);
    console.log(JSON.stringify(payload));

    if (options.persist || PERSISTENT_EVENT_TYPES.has(eventType)) {
      persistMonitoringEvent(eventType, payload);
    }
  } catch (err) {
    console.error("Monitoring event failed:", err?.message || err);
  }
}

export function recordRetryMetric(details = {}) {
  recordMonitoringEvent("retry_attempt", details);
  const count = recordRollingEvent(`retry:${details.type || "unknown"}`, RETRY_SPIKE_WINDOW_MS);
  if (count >= RETRY_SPIKE_THRESHOLD) {
    recordMonitoringEvent("retry_spike", {
      ...details,
      retryCountInWindow: count,
      windowMs: RETRY_SPIKE_WINDOW_MS,
      threshold: RETRY_SPIKE_THRESHOLD,
    }, { persist: true });
  }
}

export function recordWorkerMetric(workerName, status, details = {}) {
  const eventType = status === "success" ? "worker_success" : "worker_failure";
  recordMonitoringEvent(eventType, {
    workerName,
    status,
    ...details,
  });

  if (details.timedOut) {
    recordMonitoringEvent("worker_timeout", {
      workerName,
      ...details,
    }, { persist: true });
  }
}

export function recordApiMetric(provider, status, details = {}) {
  const eventType = status === "success"
    ? "api_success"
    : details.timedOut ? "api_timeout" : "api_failure";

  recordMonitoringEvent(eventType, {
    provider,
    status,
    ...details,
  });
}

export function recordDlqMetric(eventType, details = {}) {
  recordMonitoringEvent(eventType, details, { persist: true });
}

export function recordFulfillmentMetric(eventType, details = {}) {
  recordMonitoringEvent(eventType, details, {
    persist: eventType.includes("failure") || eventType.includes("retry"),
  });
}

export function getInMemoryMonitoringSnapshot() {
  return Object.fromEntries(counters.entries());
}

function incrementCounter(name) {
  counters.set(name, (counters.get(name) || 0) + 1);
}

function recordRollingEvent(key, windowMs) {
  const now = Date.now();
  const events = (rollingWindows.get(key) || []).filter((time) => now - time <= windowMs);
  events.push(now);
  rollingWindows.set(key, events);
  return events.length;
}

function persistMonitoringEvent(eventType, payload) {
  prisma.monitoringEvent.create({
    data: {
      eventType,
      severity: payload.severity || inferSeverity(eventType),
      shop: payload.shop || null,
      jobType: payload.type || payload.jobType || null,
      workerName: payload.workerName || null,
      provider: payload.provider || null,
      shopifyOrderId: payload.shopifyOrderId || null,
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
      count: Number.isFinite(payload.count) ? payload.count : null,
      payload: JSON.stringify(payload),
    },
  }).catch((err) => {
    console.error("Monitoring persist failed:", err?.message || err);
  });
}

function normalizePayload(value) {
  return maskSensitivePayload(value);
}

function inferSeverity(eventType) {
  if (eventType.includes("timeout") || eventType.includes("spike") || eventType.includes("congestion")) {
    return "warning";
  }
  if (eventType.includes("failure") || eventType.includes("exhausted") || eventType.includes("dlq")) {
    return "error";
  }
  return "info";
}
