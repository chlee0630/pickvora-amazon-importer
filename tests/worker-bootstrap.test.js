import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapTrackingPollingWorker,
  resetTrackingPollingWorkerBootstrapForTests,
  stopTrackingPollingWorkerBootstrap,
} from "../app/utils/worker-bootstrap.server.js";

test("bootstrapTrackingPollingWorker is opt-in and initializes tracking polling only once per process", () => {
  resetTrackingPollingWorkerBootstrapForTests();

  let initCalls = 0;
  let monitoringCalls = 0;
  const logs = [];
  const initTrackingPollingWorkersFn = () => {
    initCalls += 1;
  };
  const recordMonitoringEventFn = () => {
    monitoringCalls += 1;
  };
  const logger = {
    debug: (message) => logs.push(["debug", message]),
    error: (message) => logs.push(["error", message]),
  };

  assert.deepEqual(
    bootstrapTrackingPollingWorker({
      initTrackingPollingWorkersFn,
      recordMonitoringEventFn,
      logger,
      source: "test",
    }),
    { started: false, skipped: true, reason: "disabled" },
  );
  assert.equal(initCalls, 0);
  assert.equal(monitoringCalls, 0);

  assert.deepEqual(
    bootstrapTrackingPollingWorker({
      enableBootstrap: true,
      initTrackingPollingWorkersFn,
      recordMonitoringEventFn,
      logger,
      source: "test",
    }),
    { started: true, skipped: false, success: true },
  );
  assert.deepEqual(
    bootstrapTrackingPollingWorker({
      enableBootstrap: true,
      initTrackingPollingWorkersFn,
      recordMonitoringEventFn,
      logger,
      source: "test",
    }),
    { started: false, skipped: true, reason: "started" },
  );
  assert.equal(initCalls, 1);
  assert.equal(monitoringCalls, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /tracking_polling_worker_bootstrap_skipped/);
});

test("bootstrapTrackingPollingWorker can be reset for a fresh process simulation", () => {
  resetTrackingPollingWorkerBootstrapForTests();

  let initCalls = 0;
  let monitoringCalls = 0;
  const initTrackingPollingWorkersFn = () => {
    initCalls += 1;
  };
  const recordMonitoringEventFn = () => {
    monitoringCalls += 1;
  };

  bootstrapTrackingPollingWorker({
    enableBootstrap: true,
    initTrackingPollingWorkersFn,
    recordMonitoringEventFn,
    source: "test",
  });
  resetTrackingPollingWorkerBootstrapForTests();
  bootstrapTrackingPollingWorker({
    enableBootstrap: true,
    initTrackingPollingWorkersFn,
    recordMonitoringEventFn,
    source: "test",
  });

  assert.equal(initCalls, 2);
  assert.equal(monitoringCalls, 4);
});

test("bootstrapTrackingPollingWorker records a failure when init throws", () => {
  resetTrackingPollingWorkerBootstrapForTests();

  let monitoringCalls = [];
  const initTrackingPollingWorkersFn = () => {
    throw new Error("boom");
  };
  const recordMonitoringEventFn = (eventType, details) => {
    monitoringCalls.push([eventType, details]);
  };

  const result = bootstrapTrackingPollingWorker({
    enableBootstrap: true,
    initTrackingPollingWorkersFn,
    recordMonitoringEventFn,
    logger: { debug() {}, error() {} },
    source: "test",
  });

  assert.deepEqual(result, { started: false, skipped: false, error: true, message: "boom" });
  assert.equal(monitoringCalls[0][0], "tracking_polling_worker_bootstrap_started");
  assert.equal(monitoringCalls[1][0], "tracking_polling_worker_bootstrap_failed");
  assert.equal(monitoringCalls[1][1].error.message, "boom");
  assert.deepEqual(
    bootstrapTrackingPollingWorker({
      enableBootstrap: true,
      initTrackingPollingWorkersFn: () => {
        throw new Error("should not run again");
      },
      recordMonitoringEventFn,
      logger: { debug() {}, error() {} },
      source: "test",
    }),
    { started: false, skipped: true, reason: "failed" },
  );
});

test("stopTrackingPollingWorkerBootstrap clears the interval and allows a fresh start", () => {
  resetTrackingPollingWorkerBootstrapForTests();

  let initCalls = 0;
  const initTrackingPollingWorkersFn = () => {
    initCalls += 1;
  };

  const logger = { info() {}, debug() {} };
  globalThis.__trackingPollingWorkerInterval = {};

  const stopResult = stopTrackingPollingWorkerBootstrap({ logger, source: "test" });
  assert.deepEqual(stopResult, { stopped: true, skipped: false });

  assert.deepEqual(
    bootstrapTrackingPollingWorker({
      enableBootstrap: true,
      initTrackingPollingWorkersFn,
      recordMonitoringEventFn: () => {},
      logger,
      source: "test",
    }),
    { started: true, skipped: false, success: true },
  );
  assert.equal(initCalls, 1);
});
