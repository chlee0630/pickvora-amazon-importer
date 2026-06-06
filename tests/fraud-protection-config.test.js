import assert from "node:assert/strict";
import test from "node:test";

import { updateFraudProtectionConfig } from "../app/services/fraud-protection.server.js";

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
