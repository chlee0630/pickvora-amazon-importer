import { PrismaClient } from "@prisma/client";

const DEV_SHOP = "pickvora-dev.myshopify.com";
const PRODUCTION_SHOP = "cmgpwd-ty.myshopify.com";

const CANDIDATE = {
  asin: "B0RESTOCK1",
  title: "Pickvora Restock Test Product",
  amazonUrl: "https://zinc.com/shop/products/test-success",
  shopifyProductId: "gid://shopify/Product/9994603135223",
  shopifyVariantId: "gid://shopify/ProductVariant/50836887994615",
  shopifyHandle: "pickvora-restock-test-product",
  shopifyPrice: 10,
  price: 10,
  salePrice: null,
  inStock: true,
  outOfStock: false,
  availabilityStatus: "in_stock",
  cannotBeShipped: false,
  shippingUnavailableReason: null,
  shippingPrice: null,
  primeEligible: false,
  marginRate: 30,
  syncStatus: "blocked",
  riskLevel: "safe",
  filterStatus: "blocked",
  filterReason: "Restock E2E test-only mapping",
};

const REQUIRED_CREATE_FIELDS = ["asin", "title"];

async function main() {
  const args = new Set(process.argv.slice(2));
  const applyRequested = args.has("--apply");
  const targetShop = String(process.env.TARGET_SHOP || DEV_SHOP).trim().toLowerCase();

  assertSafeRuntime({ targetShop, applyRequested });
  validateCandidateShape(CANDIDATE);

  const prisma = new PrismaClient();
  try {
    const duplicates = await findDuplicateMappings(prisma, CANDIDATE);
    if (duplicates.length > 0) {
      console.log(JSON.stringify({
        mode: "dry-run",
        status: "blocked",
        reason: "duplicate_mapping_found",
        duplicateCount: duplicates.length,
        duplicates,
      }, null, 2));
      return;
    }

    console.log(JSON.stringify({
      mode: "dry-run",
      status: "ready",
      targetShop,
      writesPerformed: false,
      requiredFieldsPresent: REQUIRED_CREATE_FIELDS,
      createData: CANDIDATE,
      nextStep: "Request an explicit apply-capable implementation before creating this mapping.",
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function assertSafeRuntime({ targetShop, applyRequested }) {
  if (applyRequested) {
    throw new Error("--apply is intentionally disabled in this dry-run-only script.");
  }
  if (targetShop !== DEV_SHOP) {
    throw new Error(`Refusing to run outside dev shop: ${targetShop || "(missing)"}`);
  }
  if (isProductionRuntime()) {
    throw new Error("Refusing to run in production runtime.");
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

function validateCandidateShape(data) {
  const missingRequiredFields = REQUIRED_CREATE_FIELDS.filter((field) => data[field] == null || data[field] === "");
  if (missingRequiredFields.length > 0) {
    throw new Error(`Candidate is missing required AmazonProduct fields: ${missingRequiredFields.join(", ")}`);
  }
  if (!/^[A-Z0-9]{10}$/.test(data.asin)) {
    throw new Error("Candidate ASIN must be 10 uppercase alphanumeric characters.");
  }
  if (!/^gid:\/\/shopify\/Product\/[0-9]+$/.test(data.shopifyProductId)) {
    throw new Error("Candidate shopifyProductId must be a Shopify Product GID.");
  }
  if (!/^gid:\/\/shopify\/ProductVariant\/[0-9]+$/.test(data.shopifyVariantId)) {
    throw new Error("Candidate shopifyVariantId must be a Shopify ProductVariant GID.");
  }
  if (data.amazonUrl !== "https://zinc.com/shop/products/test-success") {
    throw new Error("Candidate amazonUrl must remain the Zinc test-success URL.");
  }
}

async function findDuplicateMappings(prisma, data) {
  const rows = await prisma.amazonProduct.findMany({
    where: {
      OR: [
        { asin: data.asin },
        { shopifyVariantId: data.shopifyVariantId },
        { shopifyProductId: data.shopifyProductId },
      ],
    },
    select: {
      id: true,
      asin: true,
      title: true,
      shopifyProductId: true,
      shopifyVariantId: true,
      shopifyHandle: true,
      amazonUrl: true,
      syncStatus: true,
      filterStatus: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    asin: row.asin,
    title: row.title,
    shopifyProductId: row.shopifyProductId,
    shopifyVariantId: row.shopifyVariantId,
    shopifyHandle: row.shopifyHandle,
    amazonUrl: row.amazonUrl,
    syncStatus: row.syncStatus,
    filterStatus: row.filterStatus,
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({
    mode: "dry-run",
    status: "failed",
    writesPerformed: false,
    error: err?.message || String(err),
  }, null, 2));
  process.exitCode = 1;
});
