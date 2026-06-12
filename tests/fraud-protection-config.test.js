import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFraudHighRiskOverrideDebugDetails,
  cancelShopifyFraudOrder,
  canUseFraudOrderCancelForShop,
  createFraudTestAssessment,
  assessOrderFraudRisk,
  fetchShopifyOrderRisk,
  fetchShopifyCancelJobStatus,
  fetchShopifyOrderCancellationStatus,
  getFraudHighRiskOverrideForOrder,
  getFraudOrderCancelEligibility,
  getFraudOrderRefundOption,
  getFraudOrderRestockOption,
  handleFraudOrderCancellation,
  logFraudHighRiskOverrideDebug,
  processFraudCancelPoll,
  canUseFraudOrderRefundForShop,
  canUseFraudOrderRestockForShop,
  updateFraudProtectionConfig,
  updateFraudZincBlockConfig,
} from "../app/services/fraud-protection.server.js";
import {
  canUseFraudTestSimulationForShop,
  canUseFraudZincBlockControlsForShop,
} from "../app/utils/runtime-flags.server.js";

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
  assert.equal(config.restockInventory, false);
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
});

test("updateFraudProtectionConfig stores restockInventory only behind dev restock guards", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });
  const calls = [];

  try {
    const config = await updateFraudProtectionConfig({
      shop: "pickvora-dev.myshopify.com",
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
      restockInventory: true,
    }, {
      prismaClient: makePrismaClient(calls),
    });

    assert.equal(config.restockInventory, true);
    assert.equal(calls[0].create.restockInventory, true);

    process.env.NODE_ENV = "production";
    const blocked = await updateFraudProtectionConfig({
      shop: "pickvora-dev.myshopify.com",
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
      restockInventory: true,
    }, {
      prismaClient: makePrismaClient([]),
    });
    assert.equal(blocked.restockInventory, false);
  } finally {
    restoreEnv(original);
  }
});

test("updateFraudProtectionConfig stores refundPayment only behind dev refund guards", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "true" });
  const calls = [];

  try {
    const config = await updateFraudProtectionConfig({
      shop: "pickvora-dev.myshopify.com",
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
      refundPayment: true,
    }, {
      prismaClient: makePrismaClient(calls),
    });

    assert.equal(config.refundPayment, true);
    assert.equal(calls[0].create.refundPayment, true);

    process.env.NODE_ENV = "production";
    const blocked = await updateFraudProtectionConfig({
      shop: "pickvora-dev.myshopify.com",
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
      refundPayment: true,
    }, {
      prismaClient: makePrismaClient([]),
    });
    assert.equal(blocked.refundPayment, false);
  } finally {
    restoreEnv(original);
  }
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

test("updateFraudProtectionConfig stores Zinc block disabled unless explicitly allowed", async () => {
  const calls = [];
  const config = await updateFraudProtectionConfig({
    shop: SHOP,
    enabled: true,
    dryRun: true,
    autoCancelHighRisk: true,
    autoCancelMediumRisk: false,
    blockZincOnHighRisk: false,
  }, {
    prismaClient: makePrismaClient(calls),
  });

  assert.equal(config.blockZincOnHighRisk, false);
  assert.equal(calls[0].create.blockZincOnHighRisk, false);
  assert.equal(calls[0].update.blockZincOnHighRisk, false);
});

test("updateFraudZincBlockConfig enables dev/test Zinc block with safe dry-run settings", async () => {
  const calls = [];
  const config = await updateFraudZincBlockConfig({
    shop: SHOP,
    blockZincOnHighRisk: true,
    updatedBy: "admin@example.com",
  }, {
    prismaClient: makeConfigReadWritePrismaClient(calls, {
      enabled: false,
      dryRun: true,
      autoCancelHighRisk: false,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: false,
    }),
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.autoCancelHighRisk, true);
  assert.equal(config.autoCancelMediumRisk, false);
  assert.equal(config.blockZincOnHighRisk, true);
  assert.equal(config.restockInventory, false);
  assert.equal(config.refundPayment, false);
  assert.equal(config.notifyCustomer, false);
  assert.deepEqual(calls.map((call) => call.operation), ["findUnique", "upsert"]);
});

test("updateFraudZincBlockConfig disables Zinc block without enabling live mode", async () => {
  const calls = [];
  const config = await updateFraudZincBlockConfig({
    shop: SHOP,
    blockZincOnHighRisk: false,
  }, {
    prismaClient: makeConfigReadWritePrismaClient(calls, {
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
    }),
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.autoCancelHighRisk, true);
  assert.equal(config.blockZincOnHighRisk, false);
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

test("canUseFraudZincBlockControlsForShop blocks production runtime", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    assert.equal(canUseFraudZincBlockControlsForShop(SHOP), false);

    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "production";
    assert.equal(canUseFraudZincBlockControlsForShop(SHOP), false);

    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "example.myshopify.com";
    assert.equal(canUseFraudZincBlockControlsForShop(SHOP), false);

    process.env.SHOP_CUSTOM_DOMAIN = "";
    assert.equal(canUseFraudZincBlockControlsForShop(SHOP), true);
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

test("getFraudHighRiskOverrideForOrder returns null in production runtime", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";

    assert.equal(getFraudHighRiskOverrideForOrder({
      shop: SHOP,
      actualRiskLevel: "LOW",
      order: makeOrder({
        name: "#1010",
        address2: "PICKVORA_FRAUD_HIGH_TEST",
      }),
    }), null);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
  }
});

test("getFraudHighRiskOverrideForOrder returns null for protected shop", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = SHOP;

    assert.equal(getFraudHighRiskOverrideForOrder({
      shop: SHOP,
      actualRiskLevel: "LOW",
      order: makeOrder({
        name: "#1010",
        address2: "PICKVORA_FRAUD_HIGH_TEST",
      }),
    }), null);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
  }
});

test("getFraudHighRiskOverrideForOrder returns null for excluded historical test orders", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";

    for (const orderName of ["#1005", "#1006", "#1007", "#1008", "#1009"]) {
      assert.equal(getFraudHighRiskOverrideForOrder({
        shop: SHOP,
        actualRiskLevel: "LOW",
        order: makeOrder({
          name: orderName,
          address2: "PICKVORA_FRAUD_HIGH_TEST",
        }),
      }), null);
    }
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
  }
});

test("getFraudHighRiskOverrideForOrder overrides marker orders in dev/test runtime", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";

    const override = getFraudHighRiskOverrideForOrder({
      shop: SHOP,
      actualRiskLevel: "LOW",
      order: makeOrder({
        name: "#1010",
        address2: "PICKVORA_FRAUD_HIGH_TEST",
      }),
    });

    assert.deepEqual(override, {
      source: "pickvora_dev_test_high_override",
      markerField: "shippingAddress.address2",
      markerValue: "PICKVORA_FRAUD_HIGH_TEST",
      excludedOrders: ["#1005", "1005", "#1006", "1006", "#1007", "1007", "#1008", "1008", "#1009", "1009"],
      actualRiskLevel: "LOW",
      overriddenRiskLevel: "HIGH",
      devTestOnly: true,
    });
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
  }
});

test("getFraudHighRiskOverrideForOrder keeps marker-free orders on the Shopify risk result", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";

    assert.equal(getFraudHighRiskOverrideForOrder({
      shop: SHOP,
      actualRiskLevel: "MEDIUM",
      order: makeOrder({
        name: "#1011",
        address2: "unit 4",
      }),
    }), null);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
  }
});

test("buildFraudHighRiskOverrideDebugDetails keeps debug payload restricted to allowed fields", () => {
  assert.deepEqual(buildFraudHighRiskOverrideDebugDetails({
    shop: SHOP,
    orderName: "#1011",
    hasAddress2: true,
    address2MarkerMatched: true,
    fraudTestSimulationAllowed: true,
    overrideApplied: true,
    actualRiskLevel: "NONE",
    finalRiskLevel: "HIGH",
  }), {
    shop: SHOP,
    orderName: "#1011",
    hasAddress2: true,
    address2MarkerMatched: true,
    fraudTestSimulationAllowed: true,
    overrideApplied: true,
    actualRiskLevel: "NONE",
    finalRiskLevel: "HIGH",
  });
});

test("logFraudHighRiskOverrideDebug is suppressed in production runtime", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
  };
  const logs = [];
  const originalLog = console.log;

  try {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_APP_ENV = "production";
    console.log = (...args) => logs.push(args);

    logFraudHighRiskOverrideDebug({
      shop: SHOP,
      orderName: "#1011",
      hasAddress2: true,
      address2MarkerMatched: true,
      fraudTestSimulationAllowed: false,
      overrideApplied: false,
      actualRiskLevel: "NONE",
      finalRiskLevel: "NONE",
    });

    assert.equal(logs.length, 0);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    console.log = originalLog;
  }
});

test("logFraudHighRiskOverrideDebug emits only allowed fields in dev/test runtime", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
  };
  const logs = [];
  const originalLog = console.log;

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    console.log = (...args) => logs.push(args);

    logFraudHighRiskOverrideDebug({
      shop: SHOP,
      orderName: "#1011",
      hasAddress2: true,
      address2MarkerMatched: true,
      fraudTestSimulationAllowed: true,
      overrideApplied: true,
      actualRiskLevel: "NONE",
      finalRiskLevel: "HIGH",
    });

    assert.equal(logs.length, 1);
    const payload = JSON.parse(logs[0][0]);
    assert.equal(payload.event, "fraud_high_risk_override_debug");
    assert.equal(payload.layer, "fraud_protection");
    assert.equal(payload.shop, SHOP);
    assert.equal(payload.orderName, "#1011");
    assert.equal(payload.hasAddress2, true);
    assert.equal(payload.address2MarkerMatched, true);
    assert.equal(payload.fraudTestSimulationAllowed, true);
    assert.equal(payload.overrideApplied, true);
    assert.equal(payload.actualRiskLevel, "NONE");
    assert.equal(payload.finalRiskLevel, "HIGH");
    assert.equal(payload.order, undefined);
    assert.equal(payload.address2, undefined);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    console.log = originalLog;
  }
});

test("assessOrderFraudRisk applies the dev/test HIGH override when shippingAddress.address2 matches", async () => {
  const calls = [];
  const debugCalls = [];

  const result = await assessOrderFraudRisk({
    shop: "pickvora-dev.myshopify.com",
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/1013",
  }, {
    getFraudProtectionConfig: async () => ({
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
    }),
    fetchShopifyOrderRisk: async () => ({
      name: "#1013",
      shippingAddress: {
        address2: "PICKVORA_FRAUD_HIGH_TEST",
      },
      totalPriceSet: {
        shopMoney: {
          amount: "123.45",
          currencyCode: "USD",
        },
      },
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      risk: {
        assessments: [{ riskLevel: "NONE" }],
        recommendation: "ALLOW",
      },
    }),
    prismaClient: {
      fraudOrderAssessment: {
        upsert: async (args) => {
          calls.push(args);
          return {
            id: "fraud-assessment-1",
            ...args.create,
          };
        },
      },
    },
    logFraudHighRiskOverrideDebug: (details) => debugCalls.push(details),
  });

  assert.equal(result.riskLevel, "HIGH");
  assert.equal(result.decision, "WOULD_CANCEL");
  assert.equal(result.actionMode, "DRY_RUN");
  assert.equal(debugCalls.length, 1);
  assert.deepEqual(debugCalls[0], {
    shop: "pickvora-dev.myshopify.com",
    orderName: "#1013",
    hasAddress2: true,
    address2MarkerMatched: true,
    fraudTestSimulationAllowed: true,
    overrideApplied: true,
    actualRiskLevel: "NONE",
    finalRiskLevel: "HIGH",
  });
  assert.equal(calls[0].create.riskLevel, "HIGH");
  assert.equal(calls[0].create.decision, "WOULD_CANCEL");
  assert.match(calls[0].create.riskPayload, /pickvora_dev_test_high_override/);
});

test("assessOrderFraudRisk keeps the existing flow when shippingAddress.address2 does not match", async () => {
  const calls = [];
  const debugCalls = [];

  const result = await assessOrderFraudRisk({
    shop: "pickvora-dev.myshopify.com",
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/1014",
  }, {
    getFraudProtectionConfig: async () => ({
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
    }),
    fetchShopifyOrderRisk: async () => ({
      name: "#1014",
      shippingAddress: {
        address2: "unit 4",
      },
      totalPriceSet: {
        shopMoney: {
          amount: "123.45",
          currencyCode: "USD",
        },
      },
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      risk: {
        assessments: [{ riskLevel: "LOW" }],
        recommendation: "ALLOW",
      },
    }),
    prismaClient: {
      fraudOrderAssessment: {
        upsert: async (args) => {
          calls.push(args);
          return {
            id: "fraud-assessment-1",
            ...args.create,
          };
        },
      },
    },
    logFraudHighRiskOverrideDebug: (details) => debugCalls.push(details),
  });

  assert.equal(result.riskLevel, "LOW");
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.actionMode, "DRY_RUN");
  assert.equal(debugCalls.length, 1);
  assert.deepEqual(debugCalls[0], {
    shop: "pickvora-dev.myshopify.com",
    orderName: "#1014",
    hasAddress2: true,
    address2MarkerMatched: false,
    fraudTestSimulationAllowed: true,
    overrideApplied: false,
    actualRiskLevel: "LOW",
    finalRiskLevel: "LOW",
  });
  assert.equal(calls[0].create.riskLevel, "LOW");
  assert.equal(calls[0].create.decision, "ALLOW");
  assert.doesNotMatch(calls[0].create.riskPayload, /pickvora_dev_test_high_override/);
});

test("canUseFraudOrderCancelForShop requires dev shop, non-production runtime, and env flag", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
    FRAUD_ORDER_RESTOCK_ENABLED: process.env.FRAUD_ORDER_RESTOCK_ENABLED,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    process.env.FRAUD_ORDER_CANCEL_ENABLED = "";
    assert.equal(canUseFraudOrderCancelForShop("pickvora-dev.myshopify.com"), false);

    process.env.FRAUD_ORDER_CANCEL_ENABLED = "true";
    assert.equal(canUseFraudOrderCancelForShop("example.myshopify.com"), false);

    process.env.NODE_ENV = "production";
    assert.equal(canUseFraudOrderCancelForShop("pickvora-dev.myshopify.com"), false);

    process.env.NODE_ENV = "development";
    process.env.SHOP_CUSTOM_DOMAIN = "pickvora-dev.myshopify.com";
    assert.equal(canUseFraudOrderCancelForShop("pickvora-dev.myshopify.com"), false);

    process.env.SHOP_CUSTOM_DOMAIN = "";
    assert.equal(canUseFraudOrderCancelForShop("pickvora-dev.myshopify.com"), true);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
    process.env.FRAUD_ORDER_CANCEL_ENABLED = original.FRAUD_ORDER_CANCEL_ENABLED;
    restoreEnvValue("FRAUD_ORDER_RESTOCK_ENABLED", original.FRAUD_ORDER_RESTOCK_ENABLED);
  }
});

test("getFraudOrderCancelEligibility blocks historical test orders", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
    FRAUD_ORDER_REFUND_ENABLED: process.env.FRAUD_ORDER_REFUND_ENABLED,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    process.env.FRAUD_ORDER_CANCEL_ENABLED = "true";

    for (const orderName of ["#1005", "#1006", "#1007", "#1008", "#1009", "#1010", "#1011", "#1012", "#1013", "#1014", "#1015", "#1016", "#1017", "#1018", "#1019"]) {
      assert.deepEqual(getFraudOrderCancelEligibility({
        shop: "pickvora-dev.myshopify.com",
        order: makeOrder({ name: orderName, address2: "" }),
        fraudAssessment: makeFraudAssessment({ orderName }),
        shouldBlockZinc: true,
      }), { allowed: false, reason: "blocked_test_order" });
    }
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
    process.env.FRAUD_ORDER_CANCEL_ENABLED = original.FRAUD_ORDER_CANCEL_ENABLED;
    restoreEnvValue("FRAUD_ORDER_REFUND_ENABLED", original.FRAUD_ORDER_REFUND_ENABLED);
  }
});

test("canUseFraudOrderRestockForShop requires cancel guard and restock env flag", () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "" });

  try {
    assert.equal(canUseFraudOrderRestockForShop("pickvora-dev.myshopify.com"), false);

    process.env.FRAUD_ORDER_RESTOCK_ENABLED = "true";
    assert.equal(canUseFraudOrderRestockForShop("pickvora-dev.myshopify.com"), true);
    assert.equal(canUseFraudOrderRestockForShop("example.myshopify.com"), false);

    process.env.NODE_ENV = "production";
    assert.equal(canUseFraudOrderRestockForShop("pickvora-dev.myshopify.com"), false);
  } finally {
    restoreEnv(original);
  }
});

test("canUseFraudOrderRefundForShop requires cancel guard and refund env flag", () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "" });

  try {
    assert.equal(canUseFraudOrderRefundForShop("pickvora-dev.myshopify.com"), false);

    process.env.FRAUD_ORDER_REFUND_ENABLED = "true";
    assert.equal(canUseFraudOrderRefundForShop("pickvora-dev.myshopify.com"), true);
    assert.equal(canUseFraudOrderRefundForShop("example.myshopify.com"), false);

    process.env.NODE_ENV = "production";
    assert.equal(canUseFraudOrderRefundForShop("pickvora-dev.myshopify.com"), false);
  } finally {
    restoreEnv(original);
  }
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
              id: "gid://shopify/Order/900001020",
              name: "#1020",
              lineItems: {
                nodes: [
                  { variant: { id: "gid://shopify/ProductVariant/50836887994615" } },
                ],
              },
            },
          },
        }),
      };
    };

    const order = await fetchShopifyOrderRisk(
      "pickvora-dev.myshopify.com",
      "offline_token",
      "gid://shopify/Order/900001020"
    );

    const body = JSON.parse(calls[0][1].body);
    assert.match(body.query, /lineItems\(first: 100\)/);
    assert.match(body.query, /variant\s*\{\s*id\s*\}/);
    assert.doesNotMatch(body.query, /lineItems\(first: 100\)[\s\S]*\bsku\b/);
    assert.doesNotMatch(body.query, /lineItems\(first: 100\)[\s\S]*\bquantity\b/);
    assert.equal(order.lineItems.nodes[0].variant.id, "gid://shopify/ProductVariant/50836887994615");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assessOrderFraudRisk lineItems result enables restock cancellation path", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });
  const assessmentWrites = [];
  const cancellationWrites = [];
  const cancelCalls = [];

  try {
    const assessed = await assessOrderFraudRisk({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/900001020",
    }, {
      getFraudProtectionConfig: async () => ({
        enabled: true,
        dryRun: true,
        autoCancelHighRisk: true,
        autoCancelMediumRisk: false,
        blockZincOnHighRisk: true,
        restockInventory: true,
      }),
      fetchShopifyOrderRisk: async () => ({
        id: "gid://shopify/Order/900001020",
        name: "#1020",
        shippingAddress: {
          address2: "PICKVORA_FRAUD_HIGH_TEST",
        },
        lineItems: {
          nodes: [
            {
              variant: {
                id: "gid://shopify/ProductVariant/50836887994615",
              },
            },
          ],
        },
        totalPriceSet: {
          shopMoney: {
            amount: "10.00",
            currencyCode: "USD",
          },
        },
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "UNFULFILLED",
        risk: {
          assessments: [{ riskLevel: "NONE" }],
          recommendation: "ALLOW",
        },
      }),
      prismaClient: {
        fraudOrderAssessment: {
          upsert: async (args) => {
            assessmentWrites.push(args);
            return {
              id: "fraud-assessment-1",
              ...args.create,
            };
          },
        },
      },
      logFraudHighRiskOverrideDebug: () => {},
    });

    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: { skipped: false, result: assessed },
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(cancellationWrites),
      cancelShopifyFraudOrder: async (args) => {
        cancelCalls.push(args);
        return { job: { id: "gid://shopify/Job/1", done: true } };
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("poll should not be enqueued for done job");
      },
      logEvent: () => {},
    });

    assert.equal(assessed.order.lineItems.nodes[0].variant.id, "gid://shopify/ProductVariant/50836887994615");
    assert.equal(assessmentWrites[0].create.riskLevel, "HIGH");
    assert.equal(result.status, "CANCELLED");
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].restock, true);
  } finally {
    restoreEnv(original);
  }
});

test("getFraudOrderRestockOption only enables restock for the dev restock test variant", () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });

  try {
    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "", restockVariant: true }),
      fraudAssessment: makeFraudAssessment({ orderName: "#1020", restockInventory: true, restockVariant: true }),
      shouldBlockZinc: true,
    }), true);

    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "", restockVariant: true }),
      fraudAssessment: makeFraudAssessment({ orderName: "#1020", restockInventory: false, restockVariant: true }),
      shouldBlockZinc: true,
    }), false);

    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "", restockVariant: false }),
      fraudAssessment: makeFraudAssessment({ orderName: "#1020", restockInventory: true, restockVariant: false }),
      shouldBlockZinc: true,
    }), false);

    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: { id: "gid://shopify/Order/900001020", name: "#1020" },
      fraudAssessment: makeFraudAssessment({ orderName: "#1020", restockInventory: true, restockVariant: false }),
      shouldBlockZinc: true,
    }), false);

    for (const riskLevel of ["LOW", "MEDIUM", "NONE", "UNKNOWN"]) {
      assert.equal(getFraudOrderRestockOption({
        shop: "pickvora-dev.myshopify.com",
        order: makeOrder({ name: "#1020", address2: "", restockVariant: true }),
        fraudAssessment: makeFraudAssessment({ orderName: "#1020", riskLevel, restockInventory: true, restockVariant: true }),
        shouldBlockZinc: true,
      }), false);
    }

    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1016", address2: "", restockVariant: true }),
      fraudAssessment: makeFraudAssessment({ orderName: "#1016", restockInventory: true, restockVariant: true }),
      shouldBlockZinc: true,
    }), false);

    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1018", address2: "", restockVariant: true }),
      fraudAssessment: makeFraudAssessment({ orderName: "#1018", restockInventory: true, restockVariant: true }),
      shouldBlockZinc: true,
    }), false);

    assert.equal(getFraudOrderRestockOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1019", address2: "", restockVariant: true }),
      fraudAssessment: makeFraudAssessment({ orderName: "#1019", restockInventory: true, restockVariant: true }),
      shouldBlockZinc: true,
    }), false);
  } finally {
    restoreEnv(original);
  }
});

test("getFraudOrderRefundOption requires dev refund guard, live config, HIGH risk, and Zinc block", () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "true" });

  try {
    assert.equal(getFraudOrderRefundOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "" }),
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: false,
        refundPayment: true,
      }),
      shouldBlockZinc: true,
    }), true);

    assert.equal(getFraudOrderRefundOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "" }),
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: true,
        refundPayment: true,
      }),
      shouldBlockZinc: true,
    }), false);

    assert.equal(getFraudOrderRefundOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "" }),
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: false,
        refundPayment: false,
      }),
      shouldBlockZinc: true,
    }), false);

    assert.equal(getFraudOrderRefundOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "" }),
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: false,
        refundPayment: true,
      }),
      shouldBlockZinc: false,
    }), false);

    process.env.NODE_ENV = "production";
    assert.equal(getFraudOrderRefundOption({
      shop: "pickvora-dev.myshopify.com",
      order: makeOrder({ name: "#1020", address2: "" }),
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: false,
        refundPayment: true,
      }),
      shouldBlockZinc: true,
    }), false);
  } finally {
    restoreEnv(original);
  }
});

test("handleFraudOrderCancellation skips without calling orderCancel when env flag is off", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
    FRAUD_ORDER_RESTOCK_ENABLED: process.env.FRAUD_ORDER_RESTOCK_ENABLED,
    FRAUD_ORDER_REFUND_ENABLED: process.env.FRAUD_ORDER_REFUND_ENABLED,
  };
  const calls = [];
  let cancelCalled = false;

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    process.env.FRAUD_ORDER_CANCEL_ENABLED = "";

    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({ orderName: "#1015" }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async () => {
        cancelCalled = true;
      },
      logEvent: () => {},
    });

    assert.equal(cancelCalled, false);
    assert.deepEqual(result, { status: "SKIPPED", reason: "fraud_order_cancel_disabled" });
    assert.equal(calls[0].data.cancellationStatus, "SKIPPED");
    assert.equal(calls[0].data.cancellationError, "fraud_order_cancel_disabled");
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
    process.env.FRAUD_ORDER_CANCEL_ENABLED = original.FRAUD_ORDER_CANCEL_ENABLED;
    restoreEnvValue("FRAUD_ORDER_RESTOCK_ENABLED", original.FRAUD_ORDER_RESTOCK_ENABLED);
    restoreEnvValue("FRAUD_ORDER_REFUND_ENABLED", original.FRAUD_ORDER_REFUND_ENABLED);
  }
});

test("handleFraudOrderCancellation calls orderCancel only for HIGH blockable dev fraud orders", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
    FRAUD_ORDER_RESTOCK_ENABLED: process.env.FRAUD_ORDER_RESTOCK_ENABLED,
    FRAUD_ORDER_REFUND_ENABLED: process.env.FRAUD_ORDER_REFUND_ENABLED,
  };
  const calls = [];
  const cancelCalls = [];
  const enqueueCalls = [];

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    process.env.FRAUD_ORDER_CANCEL_ENABLED = "true";

    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({ orderName: "#1020" }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async (args) => {
        cancelCalls.push(args);
        return { job: { id: "gid://shopify/Job/1", done: false } };
      },
      enqueueFraudCancelPollJob: async (args) => {
        enqueueCalls.push(args);
      },
      logEvent: () => {},
    });

    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].shopifyOrderId, "gid://shopify/Order/900001015");
    assert.equal(cancelCalls[0].restock, false);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].cancelJobId, "gid://shopify/Job/1");
    assert.equal(result.status, "REQUESTED");
    assert.equal(calls[0].data.cancellationStatus, "REQUESTED");
    assert.equal(calls[0].data.cancellationError, null);
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
    process.env.FRAUD_ORDER_CANCEL_ENABLED = original.FRAUD_ORDER_CANCEL_ENABLED;
    restoreEnvValue("FRAUD_ORDER_RESTOCK_ENABLED", original.FRAUD_ORDER_RESTOCK_ENABLED);
    restoreEnvValue("FRAUD_ORDER_REFUND_ENABLED", original.FRAUD_ORDER_REFUND_ENABLED);
  }
});

test("handleFraudOrderCancellation passes restock true only for eligible dev restock fraud orders", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });
  const calls = [];
  const cancelCalls = [];

  try {
    const fraudAssessment = makeFraudAssessment({
      orderName: "#1020",
      restockInventory: true,
      restockVariant: true,
    });
    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment,
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async (args) => {
        cancelCalls.push(args);
        return { job: { id: "gid://shopify/Job/1", done: true } };
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("poll should not be enqueued for done job");
      },
      logEvent: () => {},
    });

    assert.equal(result.status, "CANCELLED");
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].restock, true);
    assert.equal(fraudAssessment.result.config.blockZincOnHighRisk, true);
    assert.equal(fraudAssessment.result.riskLevel, "HIGH");
  } finally {
    restoreEnv(original);
  }
});

test("handleFraudOrderCancellation passes refund true only for eligible live dev refund orders", async () => {
  const original = setDevCancelEnv({
    FRAUD_ORDER_RESTOCK_ENABLED: "true",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });
  const calls = [];
  const cancelCalls = [];
  const logs = [];

  try {
    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: false,
        refundPayment: true,
        restockInventory: true,
        restockVariant: true,
      }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async (args) => {
        cancelCalls.push(args);
        return {
          job: { id: "gid://shopify/Job/1", done: true },
          safeLog: {
            shop: args.shop,
            shopifyOrderId: args.shopifyOrderId,
            shouldRestock: args.restock,
            shouldRefund: args.refundPayment,
            refundMethodType: "ORIGINAL_PAYMENT_METHODS",
            notifyCustomer: false,
            orderCancelJobId: "gid://shopify/Job/1",
            orderCancelJobDone: true,
            userErrors: [],
            orderCancelUserErrors: [],
          },
        };
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("poll should not be enqueued for done job");
      },
      logEvent: (event, details) => logs.push({ event, details }),
    });

    assert.equal(result.status, "CANCELLED");
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].refundPayment, true);
    const request = logs.find((item) => item.event === "fraud_order_cancel_request_prepared");
    const response = logs.find((item) => item.event === "fraud_order_cancel_response_received");
    assert.equal(request.details.shouldRefund, true);
    assert.equal(request.details.refundMethodType, "ORIGINAL_PAYMENT_METHODS");
    assert.equal(request.details.refundPaymentUsed, true);
    assert.equal(request.details.refundMethodUsed, true);
    assert.equal(request.details.notifyCustomer, false);
    assert.equal(response.details.shouldRefund, true);
    assertNoSensitiveLogKeys(logs);
  } finally {
    restoreEnv(original);
  }
});

test("handleFraudOrderCancellation does not call orderCancel again when cancellation was already recorded", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "true" });
  const calls = [];
  let cancelCalled = false;

  try {
    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        dryRun: false,
        refundPayment: true,
        cancellationStatus: "REQUESTED",
      }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async () => {
        cancelCalled = true;
      },
      logEvent: () => {},
    });

    assert.equal(cancelCalled, false);
    assert.deepEqual(result, { status: "SKIPPED", reason: "fraud_order_cancel_already_recorded" });
    assert.equal(calls.length, 0);
  } finally {
    restoreEnv(original);
  }
});

test("handleFraudOrderCancellation logs safe restock true cancellation details", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });
  const calls = [];
  const logs = [];

  try {
    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        restockInventory: true,
        restockVariant: true,
      }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async () => ({
        job: { id: "gid://shopify/Job/1", done: true },
      }),
      enqueueFraudCancelPollJob: async () => {
        throw new Error("poll should not be enqueued for done job");
      },
      logEvent: (event, details) => logs.push({ event, details }),
    });

    const options = logs.find((item) => item.event === "fraud_order_cancel_options_resolved");
    const request = logs.find((item) => item.event === "fraud_order_cancel_request_prepared");
    const response = logs.find((item) => item.event === "fraud_order_cancel_response_received");
    const requested = logs.find((item) => item.event === "fraud_order_cancel_requested");

    assert.equal(result.status, "CANCELLED");
    assert.equal(options.details.shouldRestock, true);
    assert.equal(options.details.riskLevel, "HIGH");
    assert.equal(options.details.shouldBlockZinc, true);
    assert.equal(request.details.shouldRestock, true);
    assert.equal(request.details.notifyCustomer, false);
    assert.equal(request.details.refundPaymentUsed, false);
    assert.equal(request.details.refundMethodUsed, false);
    assert.equal(response.details.orderCancelJobId, "gid://shopify/Job/1");
    assert.equal(response.details.orderCancelJobDone, true);
    assert.equal(requested.details.shouldRestock, true);
    assert.equal(requested.details.cancellationStatus, "CANCELLED");
    assert.equal(requested.details.orderCancelJobDone, true);
    assert.equal(requested.details.hasCancellationError, false);
    assertNoSensitiveLogKeys(logs);
  } finally {
    restoreEnv(original);
  }
});

test("handleFraudOrderCancellation logs safe restock false cancellation details", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });
  const calls = [];
  const logs = [];

  try {
    await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        restockInventory: true,
        restockVariant: false,
      }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async () => ({
        job: { id: "gid://shopify/Job/1", done: false },
      }),
      enqueueFraudCancelPollJob: async () => {},
      logEvent: (event, details) => logs.push({ event, details }),
    });

    const options = logs.find((item) => item.event === "fraud_order_cancel_options_resolved");
    const request = logs.find((item) => item.event === "fraud_order_cancel_request_prepared");

    assert.equal(options.details.shouldRestock, false);
    assert.equal(request.details.shouldRestock, false);
    assert.equal(request.details.notifyCustomer, false);
    assert.equal(request.details.refundPaymentUsed, false);
    assert.equal(request.details.refundMethodUsed, false);
    assertNoSensitiveLogKeys(logs);
  } finally {
    restoreEnv(original);
  }
});

test("handleFraudOrderCancellation records userErrors and does not change Zinc block eligibility", async () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
  };
  const calls = [];
  const fraudAssessment = makeFraudAssessment({ orderName: "#1020" });

  try {
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_APP_ENV = "";
    process.env.SHOP_CUSTOM_DOMAIN = "";
    process.env.FRAUD_ORDER_CANCEL_ENABLED = "true";

    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment,
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async () => {
        const error = new Error("Shopify orderCancel returned user errors.");
        error.userErrors = [{ code: "ORDER_ALREADY_CANCELLED", message: "Order is already cancelled." }];
        throw error;
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("poll should not be enqueued after failed cancellation");
      },
      logEvent: () => {},
    });

    assert.equal(result.status, "FAILED");
    assert.match(result.error, /ORDER_ALREADY_CANCELLED/);
    assert.equal(calls[0].data.cancellationStatus, "FAILED");
    assert.match(calls[0].data.cancellationError, /Order is already cancelled/);
    assert.equal(fraudAssessment.result.config.blockZincOnHighRisk, true);
    assert.equal(fraudAssessment.result.riskLevel, "HIGH");
  } finally {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SHOPIFY_APP_ENV = original.SHOPIFY_APP_ENV;
    process.env.SHOP_CUSTOM_DOMAIN = original.SHOP_CUSTOM_DOMAIN;
    process.env.FRAUD_ORDER_CANCEL_ENABLED = original.FRAUD_ORDER_CANCEL_ENABLED;
  }
});

test("handleFraudOrderCancellation logs only safe orderCancel user error summaries", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_RESTOCK_ENABLED: "true" });
  const calls = [];
  const logs = [];

  try {
    const result = await handleFraudOrderCancellation({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      fraudAssessment: makeFraudAssessment({
        orderName: "#1020",
        restockInventory: true,
        restockVariant: true,
      }),
      shouldBlockZinc: true,
    }, {
      prismaClient: makeCancellationPrismaClient(calls),
      cancelShopifyFraudOrder: async () => {
        const error = new Error("Shopify orderCancel returned user errors.");
        error.userErrors = [{
          code: "ORDER_ALREADY_CANCELLED",
          message: "Order is already cancelled.".repeat(20),
          accessToken: "must-not-log",
          customer: { email: "must-not-log@example.com" },
        }];
        error.safeOrderCancelSummary = {
          shouldRestock: true,
          notifyCustomer: false,
          orderCancelJobId: "gid://shopify/Job/1",
          orderCancelJobDone: false,
          orderCancelUserErrors: error.userErrors,
        };
        throw error;
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("poll should not be enqueued after failed cancellation");
      },
      logEvent: (event, details) => logs.push({ event, details }),
    });

    const response = logs.find((item) => item.event === "fraud_order_cancel_response_received");
    const failed = logs.find((item) => item.event === "fraud_order_cancel_failed");

    assert.equal(result.status, "FAILED");
    assert.equal(response.details.shouldRestock, true);
    assert.equal(response.details.notifyCustomer, false);
    assert.equal(response.details.orderCancelJobId, "gid://shopify/Job/1");
    assert.equal(response.details.hasOrderCancelUserErrors, true);
    assert.equal(response.details.orderCancelUserErrors[0].code, "ORDER_ALREADY_CANCELLED");
    assert.ok(response.details.orderCancelUserErrors[0].message.length <= 240);
    assert.equal(failed.details.hasCancellationError, true);
    assertNoSensitiveLogKeys(logs);
  } finally {
    restoreEnv(original);
  }
});

test("cancelShopifyFraudOrder sends only orderCancel with fixed safe options", async () => {
  const calls = [];
  const result = await cancelShopifyFraudOrder({
    shop: "pickvora-dev.myshopify.com",
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/900001015",
  }, {
    adminFetch: async (...args) => {
      calls.push(args);
      return {
        data: {
          orderCancel: {
            job: { id: "gid://shopify/Job/1", done: true },
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
  assert.equal(variables.restock, false);
  assert.equal(variables.notifyCustomer, false);
  assert.equal(variables.reason, "FRAUD");
  assert.equal(variables.staffNote, "Pickvora dev fraud protection test cancellation");
  assert.equal(result.job.done, true);
});

test("cancelShopifyFraudOrder can pass restock true without refund or notify options", async () => {
  const calls = [];
  await cancelShopifyFraudOrder({
    shop: "pickvora-dev.myshopify.com",
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/900001017",
    restock: true,
  }, {
    adminFetch: async (...args) => {
      calls.push(args);
      return {
        data: {
          orderCancel: {
            job: { id: "gid://shopify/Job/1", done: true },
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
});

test("cancelShopifyFraudOrder includes original payment refund method only when requested", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "true" });
  const calls = [];

  try {
    await cancelShopifyFraudOrder({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/900001020",
      restock: true,
      refundPayment: true,
    }, {
      adminFetch: async (...args) => {
        calls.push(args);
        return {
          data: {
            orderCancel: {
              job: { id: "gid://shopify/Job/1", done: false },
              orderCancelUserErrors: [],
              userErrors: [],
            },
          },
        };
      },
    });

    const query = calls[0][2];
    const variables = calls[0][3];
    assert.match(query, /refundMethod: \$refundMethod/);
    assert.doesNotMatch(query, /refundCreate/);
    assert.deepEqual(variables.refundMethod, { originalPaymentMethodsRefund: true });
    assert.equal(variables.restock, true);
    assert.equal(variables.notifyCustomer, false);
  } finally {
    restoreEnv(original);
  }
});

test("cancelShopifyFraudOrder blocks direct refundPayment requests in production runtime", async () => {
  const original = setDevCancelEnv({
    NODE_ENV: "production",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });
  const calls = [];

  try {
    await cancelShopifyFraudOrder({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/900001020",
      restock: true,
      refundPayment: true,
    }, {
      adminFetch: async (...args) => {
        calls.push(args);
        return {
          data: {
            orderCancel: {
              job: { id: "gid://shopify/Job/1", done: false },
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
    restoreEnv(original);
  }
});

test("cancelShopifyFraudOrder blocks direct refundPayment requests without refund env flag", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "" });
  const calls = [];

  try {
    await cancelShopifyFraudOrder({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/900001020",
      restock: true,
      refundPayment: true,
    }, {
      adminFetch: async (...args) => {
        calls.push(args);
        return {
          data: {
            orderCancel: {
              job: { id: "gid://shopify/Job/1", done: false },
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
    restoreEnv(original);
  }
});

test("cancelShopifyFraudOrder blocks direct refundPayment requests for non-dev shops", async () => {
  const original = setDevCancelEnv({ FRAUD_ORDER_REFUND_ENABLED: "true" });
  const calls = [];

  try {
    await cancelShopifyFraudOrder({
      shop: "example.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/900001020",
      restock: true,
      refundPayment: true,
    }, {
      adminFetch: async (...args) => {
        calls.push(args);
        return {
          data: {
            orderCancel: {
              job: { id: "gid://shopify/Job/1", done: false },
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
    restoreEnv(original);
  }
});

test("cancelShopifyFraudOrder blocks direct refundPayment requests for protected shops", async () => {
  const original = setDevCancelEnv({
    SHOP_CUSTOM_DOMAIN: "pickvora-dev.myshopify.com",
    FRAUD_ORDER_REFUND_ENABLED: "true",
  });
  const calls = [];

  try {
    await cancelShopifyFraudOrder({
      shop: "pickvora-dev.myshopify.com",
      accessToken: "offline_token",
      shopifyOrderId: "gid://shopify/Order/900001020",
      restock: true,
      refundPayment: true,
    }, {
      adminFetch: async (...args) => {
        calls.push(args);
        return {
          data: {
            orderCancel: {
              job: { id: "gid://shopify/Job/1", done: false },
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
    restoreEnv(original);
  }
});

test("fetchShopifyCancelJobStatus uses read-only job query", async () => {
  const calls = [];
  const result = await fetchShopifyCancelJobStatus({
    shop: "pickvora-dev.myshopify.com",
    accessToken: "offline_token",
    cancelJobId: "gid://shopify/Job/1",
  }, {
    adminFetch: async (...args) => {
      calls.push(args);
      return { data: { job: { id: "gid://shopify/Job/1", done: true } } };
    },
  });

  const query = calls[0][2];
  assert.match(query, /query fraudCancelJobStatus/);
  assert.match(query, /job\(id: \$id\)/);
  assert.doesNotMatch(query, /mutation/);
  assert.doesNotMatch(query, /orderCancel/);
  assert.equal(result.done, true);
});

test("fetchShopifyOrderCancellationStatus uses read-only order query", async () => {
  const calls = [];
  const result = await fetchShopifyOrderCancellationStatus({
    shop: "pickvora-dev.myshopify.com",
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/900001016",
  }, {
    adminFetch: async (...args) => {
      calls.push(args);
      return {
        data: {
          order: {
            id: "gid://shopify/Order/900001016",
            name: "#1016",
            cancelledAt: "2026-06-07T00:00:00Z",
            cancelReason: "FRAUD",
          },
        },
      };
    },
  });

  const query = calls[0][2];
  assert.match(query, /query fraudCancelOrderStatus/);
  assert.match(query, /order\(id: \$id\)/);
  assert.doesNotMatch(query, /mutation/);
  assert.doesNotMatch(query, /orderCancel/);
  assert.equal(result.cancelledAt, "2026-06-07T00:00:00Z");
});

test("processFraudCancelPoll marks CANCELLED when job is done and order is cancelled", async () => {
  const original = setDevCancelEnv();
  const calls = [];
  const fetchCalls = [];

  try {
    const result = await processFraudCancelPoll({
      job: makeFraudCancelPollJob({ attempts: 2 }),
      accessToken: "offline_token",
    }, {
      prismaClient: makeFraudCancelPollPrismaClient(calls),
      fetchShopifyCancelJobStatus: async () => {
        fetchCalls.push("job");
        return { id: "gid://shopify/Job/1", done: true };
      },
      fetchShopifyOrderCancellationStatus: async () => {
        fetchCalls.push("order");
        return { id: "gid://shopify/Order/900001016", name: "#1016", cancelledAt: "2026-06-07T00:00:00Z" };
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("retry should not be scheduled");
      },
      logEvent: () => {},
    });

    assert.equal(result.status, "CANCELLED");
    assert.deepEqual(fetchCalls, ["job", "order"]);
    assert.equal(calls[0].data.cancellationStatus, "CANCELLED");
    assert.equal(calls[0].data.cancellationError, null);
  } finally {
    restoreEnv(original);
  }
});

test("processFraudCancelPoll keeps REQUESTED and schedules retry when job is not done", async () => {
  const original = setDevCancelEnv();
  const calls = [];
  const enqueueCalls = [];

  try {
    const result = await processFraudCancelPoll({
      job: makeFraudCancelPollJob({ attempts: 2 }),
      accessToken: "offline_token",
    }, {
      prismaClient: makeFraudCancelPollPrismaClient(calls),
      fetchShopifyCancelJobStatus: async () => ({ id: "gid://shopify/Job/1", done: false }),
      fetchShopifyOrderCancellationStatus: async () => {
        throw new Error("order fallback should not be needed while job is pending");
      },
      enqueueFraudCancelPollJob: async (args) => {
        enqueueCalls.push(args);
      },
      logEvent: () => {},
    });

    assert.equal(result.status, "REQUESTED");
    assert.equal(result.retryScheduled, true);
    assert.equal(calls.length, 0);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].rescheduleExisting, true);
  } finally {
    restoreEnv(original);
  }
});

test("processFraudCancelPoll falls back to order status when job lookup fails", async () => {
  const original = setDevCancelEnv();
  const calls = [];

  try {
    const result = await processFraudCancelPoll({
      job: makeFraudCancelPollJob({ attempts: 2 }),
      accessToken: "offline_token",
    }, {
      prismaClient: makeFraudCancelPollPrismaClient(calls),
      fetchShopifyCancelJobStatus: async () => {
        throw Object.assign(new Error("temporary Shopify job lookup failure"), { retryable: true });
      },
      fetchShopifyOrderCancellationStatus: async () => ({ id: "gid://shopify/Order/900001016", name: "#1016", cancelledAt: "2026-06-07T00:00:00Z" }),
      enqueueFraudCancelPollJob: async () => {
        throw new Error("retry should not be scheduled after cancellation confirmation");
      },
      logEvent: () => {},
    });

    assert.equal(result.status, "CANCELLED");
    assert.equal(calls[0].data.cancellationStatus, "CANCELLED");
  } finally {
    restoreEnv(original);
  }
});

test("processFraudCancelPoll retries transient job lookup failure without touching provider order", async () => {
  const original = setDevCancelEnv();
  const calls = [];

  try {
    await assert.rejects(
      () => processFraudCancelPoll({
        job: makeFraudCancelPollJob({ attempts: 2 }),
        accessToken: "offline_token",
      }, {
        prismaClient: makeFraudCancelPollPrismaClient(calls),
        fetchShopifyCancelJobStatus: async () => {
          throw Object.assign(new Error("temporary Shopify job lookup failure"), { retryable: true });
        },
        fetchShopifyOrderCancellationStatus: async () => ({ id: "gid://shopify/Order/900001016", name: "#1016", cancelledAt: null, cancelReason: null }),
        enqueueFraudCancelPollJob: async () => {
          throw new Error("manual retry should go through queue failure handling");
        },
        logEvent: () => {},
      }),
      /not cancelled yet/
    );

    assert.equal(calls.length, 0);
  } finally {
    restoreEnv(original);
  }
});

test("processFraudCancelPoll marks STALE after max attempts", async () => {
  const original = setDevCancelEnv();
  const calls = [];

  try {
    const result = await processFraudCancelPoll({
      job: makeFraudCancelPollJob({ attempts: 8, maxAttempts: 8 }),
      accessToken: "offline_token",
    }, {
      prismaClient: makeFraudCancelPollPrismaClient(calls),
      fetchShopifyCancelJobStatus: async () => ({ id: "gid://shopify/Job/1", done: false }),
      fetchShopifyOrderCancellationStatus: async () => {
        throw new Error("order fallback should not be needed while job is pending");
      },
      enqueueFraudCancelPollJob: async () => {
        throw new Error("retry should not be scheduled after max attempts");
      },
      logEvent: () => {},
    });

    assert.equal(result.status, "STALE");
    assert.equal(calls[0].data.cancellationStatus, "STALE");
    assert.match(calls[0].data.cancellationError, /not confirmed/);
  } finally {
    restoreEnv(original);
  }
});

test("processFraudCancelPoll skips non-dev, production, and protected historical orders without Shopify queries", async () => {
  const queryCalls = [];
  const cases = [
    { env: () => setDevCancelEnv(), job: makeFraudCancelPollJob({ shop: "cmgpwd-ty.myshopify.com" }) },
    { env: () => setDevCancelEnv({ NODE_ENV: "production" }), job: makeFraudCancelPollJob() },
    { env: () => setDevCancelEnv(), job: makeFraudCancelPollJob({ orderName: "#1015" }) },
  ];

  for (const item of cases) {
    const original = item.env();
    try {
      const result = await processFraudCancelPoll({
        job: item.job,
        accessToken: "offline_token",
      }, {
        prismaClient: makeFraudCancelPollPrismaClient([], { orderName: item.job.orderName || "#1016" }),
        fetchShopifyCancelJobStatus: async () => {
          queryCalls.push("job");
        },
        fetchShopifyOrderCancellationStatus: async () => {
          queryCalls.push("order");
        },
        enqueueFraudCancelPollJob: async () => {
          throw new Error("retry should not be scheduled");
        },
        logEvent: () => {},
      });
      assert.equal(result.status, "SKIPPED");
    } finally {
      restoreEnv(original);
    }
  }

  assert.equal(queryCalls.length, 0);
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

function makeConfigReadWritePrismaClient(calls, currentConfig) {
  return {
    fraudProtectionConfig: {
      findUnique: async ({ where }) => {
        calls.push({ operation: "findUnique", where });
        return {
          shop: where.shop,
          ...currentConfig,
        };
      },
      upsert: async (args) => {
        calls.push({ operation: "upsert", ...args });
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

function makeOrder({ name, address2, restockVariant = false }) {
  return {
    id: "gid://shopify/Order/900001015",
    name,
    shippingAddress: {
      address2,
    },
    lineItems: {
      nodes: [
        {
          variant: {
            id: restockVariant
              ? "gid://shopify/ProductVariant/50836887994615"
              : "gid://shopify/ProductVariant/not-restock-test",
          },
        },
      ],
    },
  };
}

function makeFraudAssessment({
  orderName,
  riskLevel = "HIGH",
  blockZincOnHighRisk = true,
  restockInventory = false,
  refundPayment = false,
  dryRun = true,
  restockVariant = false,
  cancellationStatus = null,
} = {}) {
  return {
    skipped: false,
    result: {
      config: {
        enabled: true,
        dryRun,
        autoCancelHighRisk: true,
        blockZincOnHighRisk,
        restockInventory,
        refundPayment,
      },
      order: {
        id: "gid://shopify/Order/900001015",
        name: orderName,
        lineItems: {
          nodes: [
            {
              variant: {
                id: restockVariant
                  ? "gid://shopify/ProductVariant/50836887994615"
                  : "gid://shopify/ProductVariant/not-restock-test",
              },
            },
          ],
        },
      },
      assessment: {
        shopifyOrderId: "gid://shopify/Order/900001015",
        orderName,
        cancellationStatus,
      },
      riskLevel,
      decision: "WOULD_CANCEL",
      actionMode: "DRY_RUN",
    },
  };
}

function makeCancellationPrismaClient(calls) {
  return {
    fraudOrderAssessment: {
      update: async (args) => {
        calls.push(args);
        return args.data;
      },
    },
  };
}

function makeFraudCancelPollJob(overrides = {}) {
  return {
    id: "fraud-cancel-poll-job-1",
    shop: overrides.shop || "pickvora-dev.myshopify.com",
    type: "fraud.cancel.poll",
    shopifyOrderId: overrides.shopifyOrderId || "gid://shopify/Order/900001017",
    provider: "zinc",
    payload: JSON.stringify({
      cancelJobId: overrides.cancelJobId === undefined ? "gid://shopify/Job/1" : overrides.cancelJobId,
      requestedAt: "2026-06-07T00:00:00.000Z",
      source: "fraud_order_cancel",
    }),
    attempts: overrides.attempts || 1,
    maxAttempts: overrides.maxAttempts || 8,
    orderName: overrides.orderName,
  };
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

function makeFraudCancelPollPrismaClient(calls, overrides = {}) {
  return {
    fraudOrderAssessment: {
      findUnique: async () => ({
        id: "fraud-assessment-1",
        shop: "pickvora-dev.myshopify.com",
        shopifyOrderId: "gid://shopify/Order/900001017",
        orderName: overrides.orderName || "#1020",
        riskLevel: "HIGH",
        decision: "WOULD_CANCEL",
        actionMode: "DRY_RUN",
        cancellationStatus: overrides.cancellationStatus || "REQUESTED",
      }),
      update: async (args) => {
        calls.push(args);
        return args.data;
      },
    },
    providerOrder: {
      get() {
        throw new Error("ProviderOrder should not be touched by fraud cancel polling");
      },
    },
  };
}

function setDevCancelEnv(overrides = {}) {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_APP_ENV: process.env.SHOPIFY_APP_ENV,
    SHOP_CUSTOM_DOMAIN: process.env.SHOP_CUSTOM_DOMAIN,
    FRAUD_ORDER_CANCEL_ENABLED: process.env.FRAUD_ORDER_CANCEL_ENABLED,
    FRAUD_ORDER_RESTOCK_ENABLED: process.env.FRAUD_ORDER_RESTOCK_ENABLED,
    FRAUD_ORDER_REFUND_ENABLED: process.env.FRAUD_ORDER_REFUND_ENABLED,
  };
  process.env.NODE_ENV = overrides.NODE_ENV ?? "development";
  process.env.SHOPIFY_APP_ENV = overrides.SHOPIFY_APP_ENV ?? "";
  process.env.SHOP_CUSTOM_DOMAIN = overrides.SHOP_CUSTOM_DOMAIN ?? "";
  process.env.FRAUD_ORDER_CANCEL_ENABLED = overrides.FRAUD_ORDER_CANCEL_ENABLED ?? "true";
  process.env.FRAUD_ORDER_RESTOCK_ENABLED = overrides.FRAUD_ORDER_RESTOCK_ENABLED ?? process.env.FRAUD_ORDER_RESTOCK_ENABLED ?? "";
  process.env.FRAUD_ORDER_REFUND_ENABLED = overrides.FRAUD_ORDER_REFUND_ENABLED ?? process.env.FRAUD_ORDER_REFUND_ENABLED ?? "";
  return original;
}

function restoreEnv(original) {
  restoreEnvValue("NODE_ENV", original.NODE_ENV);
  restoreEnvValue("SHOPIFY_APP_ENV", original.SHOPIFY_APP_ENV);
  restoreEnvValue("SHOP_CUSTOM_DOMAIN", original.SHOP_CUSTOM_DOMAIN);
  restoreEnvValue("FRAUD_ORDER_CANCEL_ENABLED", original.FRAUD_ORDER_CANCEL_ENABLED);
  restoreEnvValue("FRAUD_ORDER_RESTOCK_ENABLED", original.FRAUD_ORDER_RESTOCK_ENABLED);
  restoreEnvValue("FRAUD_ORDER_REFUND_ENABLED", original.FRAUD_ORDER_REFUND_ENABLED);
}

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
