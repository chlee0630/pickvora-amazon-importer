import {
  bootstrapTrackingPollingWorker,
  stopTrackingPollingWorkerBootstrap,
} from "../app/utils/worker-bootstrap.server.js";

const SOURCE = "worker:tracking";
let shuttingDown = false;

function logInfo(event, details = {}) {
  console.info(JSON.stringify({ event, source: SOURCE, ...details }));
}

function logError(event, details = {}) {
  console.error(JSON.stringify({ event, source: SOURCE, ...details }));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("tracking_polling_worker_shutdown_requested", { signal });
  stopTrackingPollingWorkerBootstrap({ source: SOURCE, logger: console });
  logInfo("tracking_polling_worker_shutdown_complete", { signal });
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const result = bootstrapTrackingPollingWorker({
  enableBootstrap: true,
  source: SOURCE,
  logger: console,
});

if (result.error) {
  logError("tracking_polling_worker_bootstrap_failed", { message: result.message || "Bootstrap failed" });
  process.exitCode = 1;
} else if (result.started) {
  logInfo("tracking_polling_worker_bootstrap_started", { started: true });
} else if (result.skipped) {
  logInfo("tracking_polling_worker_bootstrap_skipped", { reason: result.reason });
}

if (process.exitCode === 1) {
  process.exit(1);
}
