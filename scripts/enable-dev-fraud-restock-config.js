import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEV_SHOP = "pickvora-dev.myshopify.com";
const PRODUCTION_SHOP = "cmgpwd-ty.myshopify.com";
const SAFE_CONFIG_FIELDS = {
  shop: true,
  enabled: true,
  dryRun: true,
  autoCancelHighRisk: true,
  autoCancelMediumRisk: true,
  blockZincOnHighRisk: true,
  restockInventory: true,
  refundPayment: true,
  notifyCustomer: true,
};

async function main() {
  loadLocalEnvForGuard();

  const args = new Set(process.argv.slice(2));
  const applyRequested = args.has("--apply");
  const confirmRequested = args.has("--confirm-dev-restock-config");
  const targetShop = String(process.env.TARGET_SHOP || (applyRequested ? "" : DEV_SHOP)).trim().toLowerCase();
  const mode = applyRequested ? "apply" : "dry-run";

  assertSafeRuntime({ targetShop, applyRequested, confirmRequested });

  const [{ PrismaClient }, fraudProtection] = await Promise.all([
    import("@prisma/client"),
    import("../app/services/fraud-protection.server.js"),
  ]);
  const { updateFraudProtectionConfig, canUseFraudOrderRestockForShop } = fraudProtection;
  if (!canUseFraudOrderRestockForShop(targetShop)) {
    throw new Error("Fraud order restock guard is not enabled for the target shop.");
  }

  const prisma = new PrismaClient();
  try {
    const currentConfig = await prisma.fraudProtectionConfig.findUnique({
      where: { shop: targetShop },
      select: SAFE_CONFIG_FIELDS,
    });
    const plannedConfig = buildPlannedConfig(targetShop);

    if (!applyRequested) {
      console.log(JSON.stringify({
        mode,
        status: "ready",
        targetShop,
        writesPerformed: false,
        currentConfig,
        plannedConfig,
        applyCommand: "$env:TARGET_SHOP='pickvora-dev.myshopify.com'; node scripts/enable-dev-fraud-restock-config.js --apply --confirm-dev-restock-config",
      }, null, 2));
      return;
    }

    const updatedConfig = await updateFraudProtectionConfig({
      shop: targetShop,
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
      autoCancelMediumRisk: false,
      blockZincOnHighRisk: true,
      restockInventory: true,
      updatedBy: "dev-restock-e2e-setup",
    });
    const safeUpdatedConfig = pickSafeConfigFields(updatedConfig);
    assertUpdatedConfigIsSafe(safeUpdatedConfig);

    console.log(JSON.stringify({
      mode,
      status: "updated",
      targetShop,
      writesPerformed: true,
      updatedConfig: safeUpdatedConfig,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function loadLocalEnvForGuard() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (!isAllowedEnvKey(key) || process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(match[2]);
  }
}

function isAllowedEnvKey(key) {
  return [
    "DATABASE_URL",
    "FRAUD_ORDER_CANCEL_ENABLED",
    "FRAUD_ORDER_RESTOCK_ENABLED",
    "NODE_ENV",
    "SHOPIFY_APP_ENV",
    "SHOP_CUSTOM_DOMAIN",
    "TARGET_SHOP",
  ].includes(key);
}

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function assertSafeRuntime({ targetShop, applyRequested, confirmRequested }) {
  if (applyRequested && !confirmRequested) {
    throw new Error("--apply requires --confirm-dev-restock-config.");
  }
  if (targetShop !== DEV_SHOP) {
    throw new Error(`Refusing to run outside dev shop: ${targetShop || "(missing)"}`);
  }
  if (isProductionRuntime()) {
    throw new Error("Refusing to run in production runtime.");
  }
  if (String(process.env.FRAUD_ORDER_CANCEL_ENABLED || "") !== "true") {
    throw new Error("FRAUD_ORDER_CANCEL_ENABLED must be true.");
  }
  if (String(process.env.FRAUD_ORDER_RESTOCK_ENABLED || "") !== "true") {
    throw new Error("FRAUD_ORDER_RESTOCK_ENABLED must be true.");
  }

  const customDomain = String(process.env.SHOP_CUSTOM_DOMAIN || "").trim().toLowerCase();
  if (customDomain === PRODUCTION_SHOP || customDomain === DEV_SHOP) {
    throw new Error("Refusing to run when SHOP_CUSTOM_DOMAIN is protected.");
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").toLowerCase();
  if (looksLikeProductionDatabase(databaseUrl)) {
    throw new Error("Refusing to run against a production-looking DATABASE_URL.");
  }
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.SHOPIFY_APP_ENV === "production";
}

function looksLikeProductionDatabase(value) {
  if (!value) return false;
  return [
    "production",
    "prod",
    PRODUCTION_SHOP,
    "pickvora.115.68.177.198.nip.io",
  ].some((needle) => value.includes(needle));
}

function buildPlannedConfig(shop) {
  return {
    shop,
    enabled: true,
    dryRun: true,
    autoCancelHighRisk: true,
    autoCancelMediumRisk: false,
    blockZincOnHighRisk: true,
    restockInventory: true,
    refundPayment: false,
    notifyCustomer: false,
  };
}

function pickSafeConfigFields(config) {
  return {
    shop: config.shop,
    enabled: config.enabled,
    dryRun: config.dryRun,
    autoCancelHighRisk: config.autoCancelHighRisk,
    autoCancelMediumRisk: config.autoCancelMediumRisk,
    blockZincOnHighRisk: config.blockZincOnHighRisk,
    restockInventory: config.restockInventory,
    refundPayment: config.refundPayment,
    notifyCustomer: config.notifyCustomer,
  };
}

function assertUpdatedConfigIsSafe(config) {
  const expected = buildPlannedConfig(DEV_SHOP);
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) {
      throw new Error(`Updated config failed safety check for ${key}.`);
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    mode: process.argv.includes("--apply") ? "apply" : "dry-run",
    status: "failed",
    writesPerformed: false,
    error: err?.message || String(err),
  }, null, 2));
  process.exitCode = 1;
});
