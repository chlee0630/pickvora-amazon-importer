import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelShopifyFraudOrder,
  canUseFraudOrderRefundForShop,
  createFraudTestAssessment,
  fetchShopifyOrderRisk,
  getFraudOrderCancelEligibility,
  getFraudOrderRefundOption,
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

test("cancelShopifyFraudOrder includes original payment refund method only for guarded production refund", async () => {
  const original = setRefundEnv({
    NODE_ENV: "production",
    SHOPIFY_APP_ENV: "production",
    FRAUD_ORDER_CANCEL_ENABLED: "true",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });
  const calls = [];

  try {
    await cancelShopifyFraudOrder({
      shop: "cmgpwd-ty.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/123",
      restock: true,
      refundPayment: true,
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
    assert.match(query, /refundMethod/);
    assert.doesNotMatch(query, /refundCreate/);
    assert.deepEqual(variables.refundMethod, { originalPaymentMethodsRefund: true });
    assert.equal(variables.restock, true);
    assert.equal(variables.notifyCustomer, false);
  } finally {
    restoreRefundEnv(original);
  }
});

test("cancelShopifyFraudOrder blocks refund method when production guards are missing", async () => {
  const cases = [
    {
      env: { NODE_ENV: "production", SHOPIFY_APP_ENV: "production", FRAUD_ORDER_CANCEL_ENABLED: "", FRAUD_ORDER_REFUND_ENABLED: "true" },
      shop: "cmgpwd-ty.myshopify.com",
    },
    {
      env: { NODE_ENV: "production", SHOPIFY_APP_ENV: "production", FRAUD_ORDER_CANCEL_ENABLED: "true", FRAUD_ORDER_REFUND_ENABLED: "" },
      shop: "cmgpwd-ty.myshopify.com",
    },
    {
      env: { NODE_ENV: "production", SHOPIFY_APP_ENV: "production", FRAUD_ORDER_CANCEL_ENABLED: "true", FRAUD_ORDER_REFUND_ENABLED: "true" },
      shop: "example.myshopify.com",
    },
  ];

  for (const item of cases) {
    const original = setRefundEnv(item.env);
    const calls = [];
    try {
      await cancelShopifyFraudOrder({
        shop: item.shop,
        accessToken: "offline_token",
        shopifyOrderId: "gid://shopify/Order/123",
        restock: true,
        refundPayment: true,
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
      assert.doesNotMatch(query, /refundMethod/);
      assert.equal(Object.hasOwn(variables, "refundMethod"), false);
      assert.equal(variables.notifyCustomer, false);
    } finally {
      restoreRefundEnv(original);
    }
  }
});

test("getFraudOrderRefundOption requires production shop, live high-risk cancel decision, config, and no prior cancellation", () => {
  const original = setRefundEnv({
    NODE_ENV: "production",
    SHOPIFY_APP_ENV: "production",
    FRAUD_ORDER_CANCEL_ENABLED: "true",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });

  try {
    const base = makeRefundFraudAssessment();
    assert.equal(canUseFraudOrderRefundForShop("cmgpwd-ty.myshopify.com"), true);
    assert.equal(getFraudOrderRefundOption({
      shop: "cmgpwd-ty.myshopify.com",
      order: base.result.order,
      fraudAssessment: base,
      shouldBlockZinc: true,
    }), true);

    for (const overrides of [
      { shop: "example.myshopify.com" },
      { shouldBlockZinc: false },
      { config: { refundPayment: false } },
      { config: { notifyCustomer: true } },
      { config: { dryRun: true } },
      { config: { blockZincOnHighRisk: false } },
      { config: { autoCancelHighRisk: false } },
      { riskLevel: "MEDIUM" },
      { decision: "WOULD_CANCEL" },
      { cancellationStatus: "REQUESTED" },
      { orderName: "#1023" },
    ]) {
      const assessment = makeRefundFraudAssessment(overrides);
      assert.equal(getFraudOrderRefundOption({
        shop: overrides.shop || "cmgpwd-ty.myshopify.com",
        order: assessment.result.order,
        fraudAssessment: assessment,
        shouldBlockZinc: overrides.shouldBlockZinc ?? true,
      }), false, `expected refund to be blocked for ${JSON.stringify(overrides)}`);
    }
  } finally {
    restoreRefundEnv(original);
  }
});

test("canUseFraudOrderRefundForShop allows dev refund only for the dev shop outside production", () => {
  const original = setRefundEnv({
    NODE_ENV: "development",
    SHOPIFY_APP_ENV: "",
    FRAUD_ORDER_CANCEL_ENABLED: "true",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });

  try {
    assert.equal(canUseFraudOrderRefundForShop("pickvora-dev.myshopify.com"), true);
    assert.equal(canUseFraudOrderRefundForShop("cmgpwd-ty.myshopify.com"), false);
    assert.equal(canUseFraudOrderRefundForShop("example.myshopify.com"), false);

    process.env.SHOP_CUSTOM_DOMAIN = "pickvora-dev.myshopify.com";
    assert.equal(canUseFraudOrderRefundForShop("pickvora-dev.myshopify.com"), false);
  } finally {
    restoreRefundEnv(original);
  }
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

test("handleFraudOrderCancellation passes refund only for eligible production refund orders", async () => {
  const original = setRefundEnv({
    NODE_ENV: "production",
    SHOPIFY_APP_ENV: "production",
    FRAUD_ORDER_CANCEL_ENABLED: "true",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });
  const updates = [];
  const logs = [];
  const cancelCalls = [];

  try {
    const result = await handleFraudOrderCancellation({
      shop: "cmgpwd-ty.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeRefundFraudAssessment(),
      shouldBlockZinc: true,
    }, {
      prismaClient: {
        fraudOrderAssessment: {
          update: async (args) => updates.push(args),
        },
      },
      cancelShopifyFraudOrder: async (args) => {
        cancelCalls.push(args);
        return {
          job: { id: "gid://shopify/Job/abc-123", done: false },
          safeLog: {
            shop: args.shop,
            shopifyOrderId: args.shopifyOrderId,
            shouldRestock: args.restock,
            shouldRefund: args.refundPayment,
            refundMethodType: args.refundPayment ? "ORIGINAL_PAYMENT_METHODS" : null,
            notifyCustomer: false,
            refundPaymentUsed: args.refundPayment,
            refundMethodUsed: args.refundPayment,
            orderCancelJobId: "gid://shopify/Job/abc-123",
            orderCancelJobDone: false,
            userErrors: [],
            orderCancelUserErrors: [],
          },
        };
      },
      enqueueFraudCancelPollJob: async () => {},
      logEvent: (event, details) => logs.push({ event, details }),
    });

    assert.equal(result.status, "REQUESTED");
    assert.equal(cancelCalls[0].refundPayment, true);
    assert.equal(cancelCalls[0].restock, true);
    assert.equal(updates[0].data.cancellationStatus, "REQUESTED");
    assert.equal(logs.find((item) => item.event === "fraud_order_cancel_options_resolved").details.shouldRefund, true);
    assert.equal(logs.find((item) => item.event === "fraud_order_cancel_request_prepared").details.refundPaymentUsed, true);
    assert.equal(logs.find((item) => item.event === "fraud_order_cancel_response_received").details.refundMethodUsed, true);
    assertNoSensitiveLogKeys(logs);
  } finally {
    restoreRefundEnv(original);
  }
});

test("getFraudOrderCancelEligibility blocks repeated cancellation and protected historical orders", () => {
  assert.deepEqual(getFraudOrderCancelEligibility({
    order: { id: "gid://shopify/Order/123", name: "#1023" },
    fraudAssessment: makeRefundFraudAssessment({ orderName: "#1023" }),
    shouldBlockZinc: true,
  }), { allowed: false, reason: "blocked_test_order" });

  assert.deepEqual(getFraudOrderCancelEligibility({
    order: { id: "gid://shopify/Order/123", name: "#1024" },
    fraudAssessment: makeRefundFraudAssessment({ orderName: "#1024", cancellationStatus: "REQUESTED" }),
    shouldBlockZinc: true,
  }), { allowed: false, reason: "fraud_order_cancel_already_recorded" });
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

function makeRefundFraudAssessment(overrides = {}) {
  const config = {
    enabled: true,
    dryRun: false,
    autoCancelHighRisk: true,
    blockZincOnHighRisk: true,
    restockInventory: true,
    refundPayment: true,
    notifyCustomer: false,
    ...(overrides.config || {}),
  };
  const orderName = overrides.orderName || "#1024";
  return {
    skipped: Boolean(overrides.skipped),
    result: {
      config,
      riskLevel: overrides.riskLevel || "HIGH",
      decision: overrides.decision || "CANCEL_REQUIRED",
      actionMode: "LIVE_PENDING_CANCEL",
      order: {
        id: "gid://shopify/Order/123",
        name: orderName,
      },
      assessment: {
        shopifyOrderId: "gid://shopify/Order/123",
        orderName,
        cancellationStatus: overrides.cancellationStatus || null,
      },
    },
  };
}

function setRefundEnv(overrides = {}) {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
    FRAUD_ORDER_REFUND_ENABLED: process.env.FRAUD_ORDER_REFUND_ENABLED,
  };
  process.env.NODE_ENV = overrides.NODE_ENV ?? "";
  process.env.SHOPIFY_APP_ENV = overrides.SHOPIFY_APP_ENV ?? "";
  process.env.SHOP_CUSTOM_DOMAIN = overrides.SHOP_CUSTOM_DOMAIN ?? "";
  process.env.FRAUD_ORDER_CANCEL_ENABLED = overrides.FRAUD_ORDER_CANCEL_ENABLED ?? "";
  process.env.FRAUD_ORDER_REFUND_ENABLED = overrides.FRAUD_ORDER_REFUND_ENABLED ?? "";
  return original;
}

function restoreRefundEnv(original) {
  restoreEnvValue("NODE_ENV", original.NODE_ENV);
  restoreEnvValue("SHOPIFY_APP_ENV", original.SHOPIFY_APP_ENV);
  restoreEnvValue("SHOP_CUSTOM_DOMAIN", original.SHOP_CUSTOM_DOMAIN);
  restoreEnvValue("FRAUD_ORDER_CANCEL_ENABLED", original.FRAUD_ORDER_CANCEL_ENABLED);
  restoreEnvValue("FRAUD_ORDER_REFUND_ENABLED", original.FRAUD_ORDER_REFUND_ENABLED);
}

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function assertNoSensitiveLogKeys(value) {
  const blockedKeys = new Set([
    "accessToken",
    "token",
    "apiKey",
    "secret",
    "customer",
    "email",
    "phone",
    "shippingAddress",
    "billingAddress",
    "address",
    "requestPayload",
    "variables",
    "response",
    "raw",
    "payment",
    "cartToken",
    "browserIp",
  ]);

  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(blockedKeys.has(key), false, `sensitive key logged: ${key}`);
      visit(nested);
    }
  };

  visit(value);
}
