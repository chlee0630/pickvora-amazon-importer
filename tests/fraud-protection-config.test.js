import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelShopifyFraudOrder,
  createFraudTestAssessment,
  fetchShopifyOrderRisk,
  getFraudOrderRestockOption,
  handleFraudOrderCancellation,
  updateFraudProtectionConfig,
} from "../app/services/fraud-protection.server.js";
import { canUseFraudTestSimulationForShop } from "../app/utils/runtime-flags.server.js";

const SHOP = "example.myshopify.com";

test("updateFraudProtectionConfig stores safe dry-run enable settings", async () => {
  const calls = [];
  const config = await updateFraudProtectionConfig({
    shop: SHOP,
    enabled: true,
    dryRun: true,
    autoCancelHighRisk: true,
    autoCancelMediumRisk: true,
    updatedBy: "admin@example.com",
  }, {
    prismaClient: makePrismaClient(calls),
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.autoCancelHighRisk, true);
  assert.equal(config.autoCancelMediumRisk, false);
  assert.equal(config.blockZincOnHighRisk, false);
  assert.equal(config.restockInventory, true);
  assert.equal(config.refundPayment, false);
  assert.equal(config.notifyCustomer, false);
  assert.deepEqual(calls[0].where, { shop: SHOP });
});

test("updateFraudProtectionConfig stores safe disabled settings", async () => {
  const calls = [];
  const config = await updateFraudProtectionConfig({
    shop: SHOP,
    enabled: false,
    dryRun: true,
    autoCancelHighRisk: true,
    autoCancelMediumRisk: true,
  }, {
    prismaClient: makePrismaClient(calls),
  });

  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.autoCancelHighRisk, false);
  assert.equal(config.autoCancelMediumRisk, false);
  assert.equal(config.blockZincOnHighRisk, false);
  assert.equal(config.restockInventory, false);
});

test("updateFraudProtectionConfig never stores live mode when dryRun is false", async () => {
  const calls = [];
  const config = await updateFraudProtectionConfig({
    shop: SHOP,
    enabled: true,
    dryRun: false,
    autoCancelHighRisk: true,
    autoCancelMediumRisk: false,
  }, {
    prismaClient: makePrismaClient(calls),
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, true);
  assert.equal(calls[0].create.dryRun, true);
  assert.equal(calls[0].update.dryRun, true);
});

test("fetchShopifyOrderRisk queries only the minimal line item variant id for restock checks", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  try {
    globalThis.fetch = async (...args) => {
      calls.push(args);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          data: {
            order: {
              id: "gid://shopify/Order/123",
              name: "#123",
              lineItems: {
                nodes: [
                  { variant: { id: "gid://shopify/ProductVariant/456" } },
                ],
              },
            },
          },
        }),
      };
    };

    const order = await fetchShopifyOrderRisk(SHOP, "offline_token", "gid://shopify/Order/123");
    const body = JSON.parse(calls[0][1].body);

    assert.match(body.query, /lineItems\(first: 100\)/);
    assert.match(body.query, /variant\s*\{\s*id\s*\}/);
    assert.doesNotMatch(body.query, /lineItems\(first: 100\)[\s\S]*\bsku\b/);
    assert.doesNotMatch(body.query, /lineItems\(first: 100\)[\s\S]*\bquantity\b/);
    assert.equal(order.lineItems.nodes[0].variant.id, "gid://shopify/ProductVariant/456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelShopifyFraudOrder sends orderCancel with restock and no refund method", async () => {
  const calls = [];
  const result = await cancelShopifyFraudOrder({
    shop: SHOP,
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/123",
    restock: true,
  }, {
    adminFetch: async (...args) => {
      calls.push(args);
      return {
        data: {
          orderCancel: {
            job: { id: "gid://shopify/Job/abc-123", done: false },
            orderCancelUserErrors: [],
            userErrors: [],
          },
        },
      };
    },
  });

  const query = calls[0][2];
  const variables = calls[0][3];

  assert.match(query, /orderCancel/);
  assert.doesNotMatch(query, /refundCreate/);
  assert.doesNotMatch(query, /refundMethod/);
  assert.equal(variables.restock, true);
  assert.equal(variables.notifyCustomer, false);
  assert.equal(result.job.id, "gid://shopify/Job/abc-123");
});

test("getFraudOrderRestockOption follows production config without test variant gating", () => {
  assert.equal(getFraudOrderRestockOption({
    fraudAssessment: {
      skipped: false,
      result: {
        config: { enabled: true, restockInventory: true },
        riskLevel: "HIGH",
      },
    },
    shouldBlockZinc: true,
  }), true);

  assert.equal(getFraudOrderRestockOption({
    fraudAssessment: {
      skipped: false,
      result: {
        config: { enabled: true, restockInventory: false },
        riskLevel: "HIGH",
      },
    },
    shouldBlockZinc: true,
  }), false);
});

test("handleFraudOrderCancellation logs safe fields and records requested cancellation", async () => {
  const updates = [];
  const logs = [];
  const enqueued = [];

  const result = await handleFraudOrderCancellation({
    shop: SHOP,
    accessToken: "offline_token",
    fraudAssessment: {
      skipped: false,
      result: {
        config: { enabled: true, autoCancelHighRisk: true, restockInventory: true },
        riskLevel: "HIGH",
        order: { id: "gid://shopify/Order/123", name: "#123" },
        assessment: {
          shopifyOrderId: "gid://shopify/Order/123",
          orderName: "#123",
        },
      },
    },
    shouldBlockZinc: true,
  }, {
    prismaClient: {
      fraudOrderAssessment: {
        update: async (args) => updates.push(args),
      },
    },
    cancelShopifyFraudOrder: async (args) => ({
      job: { id: "gid://shopify/Job/abc-123", done: false },
      safeLog: {
        shop: args.shop,
        shopifyOrderId: args.shopifyOrderId,
        shouldRestock: args.restock,
        notifyCustomer: false,
        orderCancelJobId: "gid://shopify/Job/abc-123",
        orderCancelJobDone: false,
        userErrors: [],
        orderCancelUserErrors: [],
      },
    }),
    enqueueFraudCancelPollJob: async (args) => enqueued.push(args),
    logEvent: (event, details) => logs.push({ event, details }),
  });

  assert.equal(result.status, "REQUESTED");
  assert.equal(updates[0].data.cancellationStatus, "REQUESTED");
  assert.equal(enqueued[0].cancelJobId, "gid://shopify/Job/abc-123");
  assert.equal(logs.find((item) => item.event === "fraud_order_cancel_options_resolved").details.shouldRestock, true);
  assert.equal(logs.find((item) => item.event === "fraud_order_cancel_request_prepared").details.notifyCustomer, false);
  assert.equal(logs.find((item) => item.event === "fraud_order_cancel_response_received").details.refundPaymentUsed, false);
  assert.equal(logs.find((item) => item.event === "fraud_order_cancel_response_received").details.refundMethodUsed, false);
});

test("canUseFraudTestSimulationForShop blocks production runtime", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    assert.equal(canUseFraudTestSimulationForShop(SHOP), false);

    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "production";
    assert.equal(canUseFraudTestSimulationForShop(SHOP), false);

    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    assert.equal(canUseFraudTestSimulationForShop(SHOP), true);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
  }
});

test("createFraudTestAssessment creates a HIGH risk dry-run simulation record", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("Shopify API should not be called");
  };

  try {
    const assessment = await createFraudTestAssessment({
      shop: SHOP,
      createdBy: "admin@example.com",
    }, {
      prismaClient: makeSimulationPrismaClient(calls, {
        enabled: true,
        dryRun: true,
        autoCancelHighRisk: true,
        autoCancelMediumRisk: false,
      }),
      now: new Date("2026-06-06T00:00:00.000Z"),
    });

    assert.equal(assessment.shop, SHOP);
    assert.equal(assessment.shopifyOrderId, "gid://shopify/Order/fraud-test-1780704000000");
    assert.equal(assessment.orderName, "FRAUD-TEST-1780704000000");
    assert.equal(assessment.riskLevel, "HIGH");
    assert.equal(assessment.recommendation, "CANCEL");
    assert.equal(assessment.decision, "WOULD_CANCEL");
    assert.equal(assessment.actionMode, "DRY_RUN");
    assert.equal(assessment.cancellationStatus, null);
    assert.equal(assessment.cancellationError, null);
    assert.deepEqual(JSON.parse(assessment.riskPayload), {
      source: "pickvora_internal_fraud_test",
      simulated: true,
      note: "No Shopify order was created",
      createdBy: "admin",
    });
    assert.deepEqual(calls.map((call) => call.model), ["fraudProtectionConfig", "fraudOrderAssessment"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("createFraudTestAssessment uses review/allow policy without touching order pipeline tables", async () => {
  const calls = [];
  const assessment = await createFraudTestAssessment({
    shop: SHOP,
  }, {
    prismaClient: makeSimulationPrismaClient(calls, {
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: false,
      autoCancelMediumRisk: false,
    }),
    now: new Date("2026-06-06T00:00:01.000Z"),
  });

  assert.equal(assessment.riskLevel, "HIGH");
  assert.equal(assessment.decision, "REVIEW");
  assert.equal(assessment.actionMode, "DRY_RUN");
  assert.deepEqual(calls.map((call) => call.model), ["fraudProtectionConfig", "fraudOrderAssessment"]);
});

function makePrismaClient(calls) {
  return {
    fraudProtectionConfig: {
      upsert: async (args) => {
        calls.push(args);
        return {
          id: "fraud-config-1",
          shop: args.where.shop,
          ...args.create,
        };
      },
    },
  };
}

function makeSimulationPrismaClient(calls, config) {
  const client = {
    fraudProtectionConfig: {
      findUnique: async ({ where }) => {
        calls.push({ model: "fraudProtectionConfig", operation: "findUnique", where });
        return {
          shop: where.shop,
          ...config,
        };
      },
    },
    fraudOrderAssessment: {
      create: async ({ data }) => {
        calls.push({ model: "fraudOrderAssessment", operation: "create", data });
        return {
          id: "fraud-assessment-1",
          ...data,
        };
      },
    },
  };

  for (const model of ["providerOrder", "orderQueueJob", "deadLetterQueueJob", "fulfillmentLog", "trackingLog"]) {
    Object.defineProperty(client, model, {
      get() {
        throw new Error(`${model} should not be touched by fraud test simulation`);
      },
    });
  }

  return client;
}
