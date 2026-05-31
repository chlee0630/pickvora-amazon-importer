import { initTrackingPollingWorkers } from "../workers/tracking-polling-worker.server.js";
import { redactDashboardText } from "./dashboard-filters.server.js";
import { maskSensitivePayload } from "./failure-audit-log.server.js";
import { recordMonitoringEvent } from "../services/monitoring/monitoring-service.server.js";

const TRACKING_BOOTSTRAP_KEY = "__trackingPollingWorkerBootstrapState";
const TRACKING_INTERVAL_KEY = "__trackingPollingWorkerInterval";

function getBootstrapState() {
  // eslint-disable-next-line no-undef
  const g = globalThis;
  if (!g[TRACKING_BOOTSTRAP_KEY]) {
    g[TRACKING_BOOTSTRAP_KEY] = { status: "idle", attempts: 0 };
  }
  return g[TRACKING_BOOTSTRAP_KEY];
}

function clearTrackingPollingWorkerInterval() {
  // eslint-disable-next-line no-undef
  const g = globalThis;
  const interval = g[TRACKING_INTERVAL_KEY];
  if (!interval) return false;
  clearInterval(interval);
  delete g[TRACKING_INTERVAL_KEY];
  return true;
}

export function bootstrapTrackingPollingWorker(deps = {}) {
  const state = getBootstrapState();
  const {
    initTrackingPollingWorkersFn = initTrackingPollingWorkers,
    recordMonitoringEventFn = recordMonitoringEvent,
    logger = console,
    source = "unknown",
    enableBootstrap = false,
  } = deps;

  if (!enableBootstrap) {
    return { started: false, skipped: true, reason: "disabled" };
  }

  if (state.status === "starting" || state.status === "started") {
    const result = { started: false, skipped: true, reason: state.status };
    logger.debug?.(JSON.stringify(maskSensitivePayload({
      event: "tracking_polling_worker_bootstrap_skipped",
      source,
      reason: state.status,
    })));
    return result;
  }

  if (state.status === "failed") {
    const result = { started: false, skipped: true, reason: "failed" };
    logger.debug?.(JSON.stringify(maskSensitivePayload({
      event: "tracking_polling_worker_bootstrap_skipped",
      source,
      reason: "failed",
    })));
    return result;
  }

  state.status = "starting";
  state.attempts += 1;
  recordMonitoringEventFn("tracking_polling_worker_bootstrap_started", {
    source,
    attempts: state.attempts,
  }, { persist: true });

  try {
    initTrackingPollingWorkersFn();
    state.status = "started";
    recordMonitoringEventFn("tracking_polling_worker_bootstrap_success", {
      source,
      attempts: state.attempts,
    }, { persist: true });
    return { started: true, skipped: false, success: true };
  } catch (error) {
    clearTrackingPollingWorkerInterval();
    state.status = "failed";
    const safeError = sanitizeBootstrapError(error);
    state.lastError = safeError;
    recordMonitoringEventFn("tracking_polling_worker_bootstrap_failed", {
      source,
      attempts: state.attempts,
      error: safeError,
    }, { persist: true });
    logger.error?.(JSON.stringify(maskSensitivePayload({
      event: "tracking_polling_worker_bootstrap_failed",
      source,
      error: safeError,
    })));
    return { started: false, skipped: false, error: true, message: safeError.message };
  }
}

export function stopTrackingPollingWorkerBootstrap(deps = {}) {
  const state = getBootstrapState();
  const {
    logger = console,
    source = "unknown",
  } = deps;

  if (!clearTrackingPollingWorkerInterval()) {
    return { stopped: false, skipped: true, reason: "idle" };
  }

  state.status = "idle";
  state.attempts = 0;
  delete state.lastError;
  logger.info?.(JSON.stringify(maskSensitivePayload({
    event: "tracking_polling_worker_bootstrap_stopped",
    source,
  })));
  return { stopped: true, skipped: false };
}

export function resetTrackingPollingWorkerBootstrapForTests() {
  stopTrackingPollingWorkerBootstrap({ logger: { info() {}, debug() {} } });
  const state = getBootstrapState();
  state.status = "idle";
  state.attempts = 0;
  delete state.lastError;
}

export function clearTrackingPollingWorkerIntervalForTests() {
  clearTrackingPollingWorkerInterval();
}

function sanitizeBootstrapError(error) {
  const message = error?.message ? String(error.message) : String(error || "Unknown bootstrap error");
  return maskSensitivePayload({
    name: error?.name || "Error",
    code: error?.code || null,
    message: redactDashboardText(message).slice(0, 500),
  });
}
