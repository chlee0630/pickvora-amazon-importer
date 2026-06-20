import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { processFulfillmentJob } from "../app/services/fulfillment/fulfillment-sync.server.js";

test("processFulfillmentJob does not call provider APIs and allows tracked PriceYak provider orders", async () => {
  const calls = {
    acquire: [],
    fetchFulfillmentContext: [],
    createTrackingFulfillment: [],
    saveFulfillmentLog: [],
    fulfilled: [],
    metrics: [],
    logs: [],
    release: [],
  };
  const providerOrder = makeProviderOrder({ provider: "priceyak" });

  await processFulfillmentJob(makeFulfillmentJob({ provider: "priceyak" }), {
    acquireFulfillmentLock: async (job) => {
      calls.acquire.push(job);
      return providerOrder;
    },
    findExistingFulfillmentLog: async () => null,
    getOfflineSession: async () => ({ accessToken: "mock-token" }),
    fetchFulfillmentContext: async (...args) => {
      calls.fetchFulfillmentContext.push(args);
      return makeFulfillmentContext();
    },
    hasMatchingFulfillment: () => false,
    buildFulfillmentInput: (_order, tracking) => ({
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1",
          fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 1 }],
        },
      ],
      trackingInfo: {
        number: tracking.trackingNumber,
        company: tracking.carrier,
        url: tracking.trackingUrl || undefined,
      },
      notifyCustomer: false,
    }),
    createTrackingFulfillment: async (...args) => {
      calls.createTrackingFulfillment.push(args);
      return {
        fulfillment: { id: "gid://shopify/Fulfillment/1" },
        responsePayload: { data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/1" } } } },
      };
    },
    saveFulfillmentLog: async (...args) => calls.saveFulfillmentLog.push(args),
    markProviderOrderFulfilled: async (...args) => calls.fulfilled.push(args),
    recordFulfillmentMetric: (...args) => calls.metrics.push(args),
    logFulfillmentEvent: (...args) => calls.logs.push(args),
    releaseFulfillmentLock: async (...args) => calls.release.push(args),
  });

  assert.equal(calls.createTrackingFulfillment.length, 1);
  assert.equal(calls.createTrackingFulfillment[0][0], "example.myshopify.com");
  assert.equal(calls.saveFulfillmentLog.length, 1);
  assert.equal(calls.saveFulfillmentLog[0][0].provider, "priceyak");
  assert.equal(calls.saveFulfillmentLog[0][3].requestPayload.notifyCustomer, false);
  assert.equal(calls.fulfilled.length, 1);
  assert.equal(calls.metrics[0][0], "fulfillment_success");
  assert.equal(calls.release.length, 0);
  assertNoSensitiveContent(calls);
});

test("processFulfillmentJob safely fails before Shopify fulfillment when tracking payload is missing", async () => {
  const calls = {
    acquire: [],
    createTrackingFulfillment: [],
    release: [],
  };

  await assert.rejects(
    () => processFulfillmentJob(makeFulfillmentJob({
      payload: {
        providerOrderId: "priceyak-order-1",
        trackingNumber: "",
        carrier: "UPS",
      },
      provider: "priceyak",
    }), {
      acquireFulfillmentLock: async (...args) => {
        calls.acquire.push(args);
        return makeProviderOrder({ provider: "priceyak" });
      },
      createTrackingFulfillment: async (...args) => calls.createTrackingFulfillment.push(args),
      releaseFulfillmentLock: async (...args) => calls.release.push(args),
    }),
    /Invalid tracking number/
  );

  assert.equal(calls.acquire.length, 0);
  assert.equal(calls.createTrackingFulfillment.length, 0);
  assert.equal(calls.release.length, 0);
});

test("processFulfillmentJob safely fails before Shopify fulfillment when provider order has no received tracking", async () => {
  const calls = {
    createTrackingFulfillment: [],
    release: [],
  };

  await assert.rejects(
    () => processFulfillmentJob(makeFulfillmentJob({ provider: "priceyak" }), {
      acquireFulfillmentLock: async () => makeProviderOrder({
        provider: "priceyak",
        trackingReceivedAt: null,
      }),
      createTrackingFulfillment: async (...args) => calls.createTrackingFulfillment.push(args),
      releaseFulfillmentLock: async (...args) => calls.release.push(args),
    }),
    /Tracking has not been received locally/
  );

  assert.equal(calls.createTrackingFulfillment.length, 0);
  assert.equal(calls.release.length, 1);
  assert.equal(calls.release[0][0].provider, "priceyak");
});

test("fulfillment worker and fulfillment sync do not call order providers or add forbidden refund patterns", () => {
  const workerSource = readFileSync(new URL("../app/workers/fulfillment-update-worker.server.js", import.meta.url), "utf8");
  const syncSource = readFileSync(new URL("../app/services/fulfillment/fulfillment-sync.server.js", import.meta.url), "utf8");
  const combined = `${workerSource}\n${syncSource}`;

  assert.doesNotMatch(combined, /getOrderProvider|resolveOrderProvider|createZincProvider|createPriceYakProvider|zincFetch|priceyak/i);
  assert.doesNotMatch(combined, /refundCreate/);
  assert.doesNotMatch(combined, /notifyCustomer\s*:\s*true/);
});

function makeFulfillmentJob(overrides = {}) {
  const payload = overrides.payload || {
    providerOrderId: "priceyak-order-1",
    trackingNumber: "1ZTEST1234567890",
    carrier: "UPS",
    trackingUrl: "https://carrier.example/track/1ZTEST1234567890",
  };

  return {
    id: "fulfillment-job-1",
    shop: "example.myshopify.com",
    type: "fulfillment.update",
    shopifyOrderId: "gid://shopify/Order/123",
    provider: "zinc",
    attempts: 1,
    payload: JSON.stringify(payload),
    ...overrides,
  };
}

function makeProviderOrder(overrides = {}) {
  return {
    id: "provider-order-1",
    shop: "example.myshopify.com",
    shopifyOrderId: "gid://shopify/Order/123",
    provider: "zinc",
    providerOrderId: "priceyak-order-1",
    trackingNumber: "1ZTEST1234567890",
    trackingCarrier: "UPS",
    trackingUrl: "https://carrier.example/track/1ZTEST1234567890",
    trackingReceivedAt: new Date("2026-06-20T00:00:00.000Z"),
    fulfillmentSyncedAt: null,
    shopifyFulfillmentId: null,
    ...overrides,
  };
}

function makeFulfillmentContext() {
  return {
    id: "gid://shopify/Order/123",
    fulfillments: [],
    fulfillmentOrders: {
      nodes: [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          status: "OPEN",
          lineItems: {
            nodes: [
              { id: "gid://shopify/FulfillmentOrderLineItem/1", remainingQuantity: 1 },
            ],
          },
        },
      ],
    },
  };
}

function assertNoSensitiveContent(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "customer@example.com",
    "private address",
    "billing_address",
    "shipping_address",
    "browser_ip",
    "payment",
    "card",
    "secret",
    "rawPayload",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `sensitive fulfillment content found: ${forbidden}`);
  }
}
