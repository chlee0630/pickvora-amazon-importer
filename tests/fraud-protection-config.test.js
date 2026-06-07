import assert from "node:assert/strict";
import test from "node:test";

import {
  createFraudTestAssessment,
  getFraudHighRiskOverrideForOrder,
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

function makeOrder({ name, address2 }) {
  return {
    name,
    shippingAddress: {
      address2,
    },
  };
}
