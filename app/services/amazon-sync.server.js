import prisma from "../db.server.js";
import { fetchProductDetails } from "./amazon-product-provider.server.js";
import { checkProductFilter } from "./filter.server.js";
import {
  createShopifyProduct,
  updateShopifyProduct,
  hideShopifyProduct,
  showShopifyProduct,
} from "./shopify-products.server.js";
import { getScalingConfig } from "../utils/scaling-config.server.js";

async function getSettings(shop) {
  return (
    (await prisma.appSettings.findUnique({ where: { shop } })) ?? {
      defaultMargin: 30,
      includeShipping: false,
      autoHideOutOfStock: true,
      addReviewsToDesc: true,
      autoGenerateTags: true,
      saleMode: "direct",
      addDisclaimer: true,
    }
  );
}

async function addLog(shop, asin, action, status, message, oldValue, newValue) {
  await prisma.updateLog.create({
    data: { shop, asin, action, status, message, oldValue, newValue },
  });
}

/**
 * Import one or more ASINs.
 * @param {string[]} asins
 * @param {string} shop
 * @param {string} accessToken
 * @param {boolean} overrideBlocks - user confirmed to import even blocked items
 */
export async function importASINs(asins, shop, accessToken, overrideBlocks = false) {
  const settings = await getSettings(shop);
  const results = [];
  const { importBatchSize, importBatchMaxSize, importWorkerConcurrency } = getScalingConfig();
  if (asins.length > importBatchMaxSize) {
    console.log(JSON.stringify({
      event: "import_batch_split",
      layer: "amazon_import",
      requestedCount: asins.length,
      maxBatchSize: importBatchMaxSize,
      batchSize: importBatchSize,
    }));
  }

  for (const batch of chunkArray(asins, importBatchSize)) {
    const settled = await runWithConcurrency(batch, importWorkerConcurrency, (asin) =>
      importSingleASIN({ asin, shop, accessToken, overrideBlocks, settings })
    );
    results.push(...settled);
  }

  return results;
}

async function importSingleASIN({ asin, shop, accessToken, overrideBlocks, settings }) {
  const trimmed = asin.trim().toUpperCase();
  if (!trimmed) return null;

  try {
      const existing = await prisma.amazonProduct.findUnique({
        where: { asin: trimmed },
      });
      if (existing) {
        await syncProduct(existing, shop, accessToken);
        return { asin: trimmed, status: "success", message: "Existing product updated" };
      }

      // Fetch Amazon data
      const amazonData = await fetchProductDetails(trimmed);

      if (amazonData.cannotBeShipped) {
        const reason = amazonData.shippingUnavailableReason || "This item cannot be shipped to the selected location";
        await addLog(shop, trimmed, "import", "skipped", `Shipping unavailable: ${reason}`);
        return {
          asin: trimmed,
          status: "blocked",
          filterReason: reason,
          title: amazonData.title,
        };
      }

      // Run copyright filter
      const filterResult = await checkProductFilter(amazonData);
      const { blocked, riskLevel, filterReason } = filterResult;

      // Hard block — skip Shopify creation
      if (blocked && !overrideBlocks) {
        await prisma.amazonProduct.upsert({
          where: { asin: trimmed },
          create: {
            ...amazonData,
            syncStatus: "blocked",
            filterStatus: "blocked",
            riskLevel,
            filterReason,
          },
          update: {
            syncStatus: "blocked",
            filterStatus: "blocked",
            riskLevel,
            filterReason,
          },
        });
        await addLog(shop, trimmed, "import", "blocked", `Blocked: ${filterReason}`, null, riskLevel);
        return {
          asin: trimmed,
          status: "blocked",
          riskLevel,
          filterReason,
          title: amazonData.title,
        };
      }

      // Warned (medium risk) or forced override
      const filterStatus = blocked ? "warned" : riskLevel !== "safe" ? "warned" : "ok";

      const shopifyResult = await createShopifyProduct(shop, accessToken, amazonData, settings);

      await prisma.amazonProduct.create({
        data: {
          ...amazonData,
          ...shopifyResult,
          marginRate: settings.defaultMargin,
          syncStatus: "synced",
          lastSyncedAt: new Date(),
          riskLevel,
          filterStatus,
          filterReason: filterReason || null,
        },
      });

      const logMsg = filterStatus === "warned"
        ? `Imported with warning: ${filterReason} — ${amazonData.title}`
        : `Imported: ${amazonData.title}`;
      await addLog(shop, trimmed, "import", "success", logMsg, null, riskLevel);

      return {
        asin: trimmed,
        status: filterStatus === "warned" ? "warned" : "success",
        riskLevel,
        filterReason: filterReason || null,
        title: amazonData.title,
      };
    } catch (err) {
      await addLog(shop, trimmed, "import", "error", err.message);
      await prisma.amazonProduct.upsert({
        where: { asin: trimmed },
        create: { asin: trimmed, title: trimmed, syncStatus: "error", syncError: err.message },
        update: { syncStatus: "error", syncError: err.message },
      });
      return { asin: trimmed, status: "error", message: err.message };
    }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(items, concurrency, handler) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const result = await handler(items[currentIndex]);
      if (result) results[currentIndex] = result;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results.filter(Boolean);
}

export async function syncProduct(product, shop, accessToken) {
  const settings = await getSettings(shop);

  try {
    const amazonData = await fetchProductDetails(product.asin);

    // Re-check filter on sync
    const filterResult = await checkProductFilter(amazonData);
    const wasOutOfStock = product.outOfStock;
    const isNowActive = amazonData.availabilityStatus === "in_stock";
    const oldPrice = product.price;
    const newPrice = amazonData.price;

    if (product.shopifyProductId) {
      if (!isNowActive && settings.autoHideOutOfStock) {
        await hideShopifyProduct(shop, accessToken, product.shopifyProductId);
        await addLog(
          shop,
          product.asin,
          "hidden",
          "success",
          `Product set to draft (${amazonData.availabilityStatus || "unavailable"})`,
        );
      } else if (wasOutOfStock && isNowActive) {
        await showShopifyProduct(shop, accessToken, product.shopifyProductId);
        await addLog(shop, product.asin, "stock_update", "success", "Product shown (back in stock)");
      }

      const { shopifyPrice } = await updateShopifyProduct(
        shop, accessToken, product.shopifyProductId, product.shopifyVariantId, amazonData, settings,
      );

      if (oldPrice !== newPrice) {
        await addLog(shop, product.asin, "price_update", "success",
          `Price updated: $${oldPrice} → $${newPrice}`, String(oldPrice), String(newPrice));
      }

      await prisma.amazonProduct.update({
        where: { id: product.id },
        data: {
          ...amazonData,
          shopifyPrice,
          syncStatus: isNowActive ? "synced" : "hidden",
          syncError: null,
          lastSyncedAt: new Date(),
          riskLevel: filterResult.riskLevel,
          filterReason: filterResult.filterReason,
        },
      });
    } else {
      if (amazonData.cannotBeShipped) {
        await prisma.amazonProduct.update({
          where: { id: product.id },
          data: {
            ...amazonData,
            syncStatus: "hidden",
            syncError: null,
            lastSyncedAt: new Date(),
            riskLevel: filterResult.riskLevel,
            filterReason: filterResult.filterReason,
          },
        });
        await addLog(
          shop,
          product.asin,
          "sync",
          "skipped",
          `Shipping unavailable, Shopify creation skipped: ${amazonData.shippingUnavailableReason || "cannot_be_shipped"}`,
        );
        return;
      }

      const shopifyResult = await createShopifyProduct(shop, accessToken, amazonData, settings);
      await prisma.amazonProduct.update({
        where: { id: product.id },
        data: {
          ...amazonData,
          ...shopifyResult,
          marginRate: settings.defaultMargin,
          syncStatus: "synced",
          syncError: null,
          lastSyncedAt: new Date(),
          riskLevel: filterResult.riskLevel,
          filterReason: filterResult.filterReason,
        },
      });
    }
  } catch (err) {
    await prisma.amazonProduct.update({
      where: { id: product.id },
      data: { syncStatus: "error", syncError: err.message },
    });
    await addLog(shop, product.asin, "sync", "error", err.message);
    throw err;
  }
}

export async function syncAllProductsForShop(shop, accessToken) {
  // Skip blocked products during auto-sync
  const products = await prisma.amazonProduct.findMany({
    where: { filterStatus: { not: "blocked" } },
  });
  let success = 0;
  let errors = 0;

  for (const product of products) {
    try {
      await syncProduct(product, shop, accessToken);
      success++;
    } catch {
      errors++;
    }
  }

  await prisma.schedulerConfig.updateMany({
    where: { shop },
    data: { lastRunAt: new Date() },
  });

  return { success, errors, total: products.length };
}
