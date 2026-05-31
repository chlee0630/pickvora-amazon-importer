import assert from "node:assert/strict";
import test from "node:test";

import {
  handleTrackingNotReady,
  isTrackingPollingExhausted,
} from "../app/workers/tracking-polling-worker.server.js";

test("isTrackingPollingExhausted returns false before maxAttempts", () => {
  assert.equal(isTrackingPollingExhausted({ attempts: 3, maxAttempts: 5 }), false);
});

test("isTrackingPollingExhausted returns true at maxAttempts", () => {
  assert.equal(isTrackingPollingExhausted({ attempts: 5, maxAttempts: 5 }), true);
});

test("handleTrackingNotReady reschedules when attempts are below maxAttempts", async () => {
  const calls = {
    log: [],
    monitoring: [],
    update: [],
    enqueue: [],
  };

  const result = await handleTrackingNotReady(
    { id: "job-1", shop: "shop", type: "tracking.poll", shopifyOrderId: "order-1", provider: "zinc", attempts: 3, maxAttempts: 5 },
    { id: "provider-1", providerOrderId: "zinc-1" },
    { status: "pending" },
    {
      updateProviderOrder: async (data) => calls.update.push(data),
      enqueueTrackingPollJobFn: async (data) => {
        calls.enqueue.push(data);
        return { id: "next-job" };
      },
      recordMonitoringEventFn: (eventType, details) => calls.monitoring.push({ eventType, details }),
      logTrackingEventFn: (eventType, job, details) => calls.log.push({ eventType, job, details }),
    }
  );

  assert.equal(result, false);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.log[0].eventType, "tracking_not_ready");
  assert.equal(calls.monitoring.length, 0);
  assert.equal(calls.enqueue[0].rescheduleExisting, true);
});

test("handleTrackingNotReady marks the provider order manual review and stops when attempts reach maxAttempts", async () => {
  const calls = {
    log: [],
    monitoring: [],
    update: [],
    enqueue: [],
  };

  await assert.rejects(
    () => handleTrackingNotReady(
      { id: "job-2", shop: "shop", type: "tracking.poll", shopifyOrderId: "order-2", provider: "zinc", attempts: 5, maxAttempts: 5 },
      { id: "provider-2", providerOrderId: "zinc-2" },
      { status: "pending" },
      {
        updateProviderOrder: async (data) => calls.update.push(data),
        enqueueTrackingPollJobFn: async (data) => {
          calls.enqueue.push(data);
          return { id: "next-job" };
        },
        recordMonitoringEventFn: (eventType, details) => calls.monitoring.push({ eventType, details }),
        logTrackingEventFn: (eventType, job, details) => calls.log.push({ eventType, job, details }),
      }
    ),
    (err) => err.message === "Tracking not received after max polling attempts"
  );

  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0], {
    status: "MANUAL_REVIEW",
    providerFailureCode: "TRACKING_NOT_RECEIVED",
    providerFailureMessage: "Tracking not received after max polling attempts",
    lastError: "Tracking not received after max polling attempts",
    processingLockedAt: null,
  });
  assert.equal(calls.enqueue.length, 0);
  assert.equal(calls.log[0].eventType, "tracking_polling_exhausted");
  assert.equal(calls.monitoring[0].eventType, "tracking_polling_exhausted");
  assert.equal(calls.monitoring[0].details.failureCategory, "TRACKING_TIMEOUT");
});
