/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import { injectTestTracking } from "../app/services/test-tracking-injection.server.js";

const BASE_SHOP = "dev-shop.myshopify.com";
const BASE_ORDER_ID = "gid://shopify/Order/1007";
const BASE_PROVIDER_ORDER_ID = "zinc-1007";

test("injectTestTracking rejects when feature flag is disabled", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_TEST_TRACKING_INJECTION_ENABLED: process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED,
  };

  process.env.NODE_ENV = "development";
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = "false";

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder()) },
    }),
    /disabled/i
  );

  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = original.ZINC_TEST_TRACKING_INJECTION_ENABLED;
});

test("injectTestTracking rejects in production runtime even when enabled", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_TEST_TRACKING_INJECTION_ENABLED: process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED,
  };

  process.env.NODE_ENV = "production";
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = "true";

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder()) },
    }),
    /disabled|production/i
  );

  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = original.ZINC_TEST_TRACKING_INJECTION_ENABLED;
});

test("injectTestTracking rejects when the shop matches SHOP_CUSTOM_DOMAIN", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_TEST_TRACKING_INJECTION_ENABLED: process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  process.env.NODE_ENV = "development";
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = "true";
  process.env.SHOP_CUSTOM_DOMAIN = BASE_SHOP;

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder()) },
    }),
    /disabled/i
  );

  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = original.ZINC_TEST_TRACKING_INJECTION_ENABLED;
  process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
});

test("injectTestTracking rejects missing tracking number or carrier", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_TEST_TRACKING_INJECTION_ENABLED: process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED,
  };

  process.env.NODE_ENV = "development";
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = "true";

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder()) },
    }),
    /tracking number/i
  );

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "",
      deps: { prismaClient: makePrismaClient(makeProviderOrder()) },
    }),
    /carrier/i
  );

  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = original.ZINC_TEST_TRACKING_INJECTION_ENABLED;
});

test("injectTestTracking rejects invalid order states and blocked orders", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_TEST_TRACKING_INJECTION_ENABLED: process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED,
  };

  process.env.NODE_ENV = "development";
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = "true";

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder({ status: "MANUAL_REVIEW" })) },
    }),
    /tracking state|eligible/i
  );

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder({ fulfillmentSyncedAt: new Date(), shopifyFulfillmentId: "ful_1" })) },
    }),
    /fulfillment synced/i
  );

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1005",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: { prismaClient: makePrismaClient(makeProviderOrder({ requestPayload: JSON.stringify({ orderName: "#1005" }) })) },
    }),
    /blocked/i
  );

  await assert.rejects(
    () => injectTestTracking({
      shop: BASE_SHOP,
      orderRef: "#1007",
      trackingNumber: "1ZTEST1234567890",
      carrier: "UPS",
      deps: {
        prismaClient: makePrismaClient(makeProviderOrder(), {
          queueJobs: [{ status: "failed", dlqStatus: "open" }],
        }),
      },
    }),
    /DLQ|failed/i
  );

  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = original.ZINC_TEST_TRACKING_INJECTION_ENABLED;
});

test("injectTestTracking runs the synthetic tracking and fulfillment success path", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_TEST_TRACKING_INJECTION_ENABLED: process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED,
  };

  process.env.NODE_ENV = "development";
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = "true";

  const providerOrder = makeProviderOrder();
  const calls = {
    tracking: [],
    fulfillment: [],
    monitoring: [],
  };

  const prismaClient = makePrismaClient(providerOrder);
  const result = await injectTestTracking({
    shop: BASE_SHOP,
    orderRef: "#1007",
    trackingNumber: "1ZTEST1234567890",
    carrier: "UPS",
    deps: {
      prismaClient,
      processTrackingReceiptFn: async (args) => {
        calls.tracking.push(args);
        providerOrder.status = "TRACKING_RECEIVED";
        providerOrder.trackingNumber = args.tracking.trackingNumber;
        providerOrder.trackingCarrier = args.tracking.trackingCompany;
        providerOrder.trackingReceivedAt = new Date("2026-06-03T00:00:00.000Z");
        return { duplicate: false };
      },
      processFulfillmentJobFn: async (job) => {
        calls.fulfillment.push(job);
        assert.equal(typeof job.payload, "string");
        const parsed = JSON.parse(job.payload);
        assert.deepEqual(parsed, {
          providerOrderId: BASE_PROVIDER_ORDER_ID,
          trackingNumber: "1ZTEST1234567890",
          carrier: "UPS",
          trackingUrl: null,
        });
        providerOrder.status = "FULFILLED";
        providerOrder.fulfillmentSyncedAt = new Date("2026-06-03T00:01:00.000Z");
        providerOrder.shopifyFulfillmentId = "fulfillment_123";
      },
      recordMonitoringEventFn: (eventType, details, options) => {
        calls.monitoring.push({ eventType, details, options });
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.order.status, "FULFILLED");
  assert.equal(result.order.trackingNumber, "1ZTEST1234567890");
  assert.equal(result.order.trackingCarrier, "UPS");
  assert.equal(result.order.shopifyFulfillmentId, "fulfillment_123");
  assert.equal(calls.tracking.length, 1);
  assert.equal(calls.fulfillment.length, 1);
  assert.equal(calls.tracking[0].skipFulfillmentEnqueue, true);
  assert.equal(calls.tracking[0].source, "test_tracking_injection");
  assert.equal(calls.tracking[0].tracking.trackingNumber, "1ZTEST1234567890");
  assert.equal(typeof calls.fulfillment[0].payload, "string");
  assert.equal(calls.monitoring.at(-1).eventType, "test_tracking_injected");
  assert.equal(calls.monitoring.at(-1).details.trackingNumber, "1Z***90");

  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED = original.ZINC_TEST_TRACKING_INJECTION_ENABLED;
});

function makeProviderOrder(overrides = {}) {
  return {
    id: "provider-order-1",
    shop: BASE_SHOP,
    shopifyOrderId: BASE_ORDER_ID,
    provider: "zinc",
    providerOrderId: BASE_PROVIDER_ORDER_ID,
    status: "ZINC_SUBMITTED",
    requestPayload: JSON.stringify({ orderName: "#1007" }),
    trackingNumber: null,
    trackingCarrier: null,
    trackingReceivedAt: null,
    fulfillmentSyncedAt: null,
    shopifyFulfillmentId: null,
    ...overrides,
  };
}

function makePrismaClient(providerOrder, { queueJobs = [], dlqJobs = [] } = {}) {
  return {
    providerOrder: {
      findFirst: async ({ where }) => {
        if (where?.providerOrderId && where.providerOrderId === providerOrder.providerOrderId) return providerOrder;
        if (where?.shopifyOrderId && where.shopifyOrderId === providerOrder.shopifyOrderId) return providerOrder;
        if (where?.OR) {
          for (const clause of where.OR) {
            if (clause.shopifyOrderId && clause.shopifyOrderId === providerOrder.shopifyOrderId) return providerOrder;
            if (clause.providerOrderId && clause.providerOrderId === providerOrder.providerOrderId) return providerOrder;
            if (clause.requestPayload?.contains && providerOrder.requestPayload.includes(clause.requestPayload.contains)) return providerOrder;
          }
        }
        return null;
      },
      findUnique: async ({ where }) => (where?.id === providerOrder.id ? providerOrder : null),
    },
    orderQueueJob: {
      findMany: async () => queueJobs,
    },
    deadLetterQueueJob: {
      findMany: async () => dlqJobs,
    },
  };
}
