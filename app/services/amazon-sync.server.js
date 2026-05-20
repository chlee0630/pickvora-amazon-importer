import prisma from "../db.server.js";
import { fetchProductDetails } from "./rainforest.server.js";
import { checkProductFilter } from "./filter.server.js";
import {
  createShopifyProduct,
  updateShopifyProduct,
  hideShopifyProduct,
  showShopifyProduct,
} from "./shopify-products.server.js";

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

  for (const asin of asins) {
    const trimmed = asin.trim().toUpperCase();
    if (!trimmed) continue;

    try {
      const existing = await prisma.amazonProduct.findUnique({
        where: { asin: trimmed },
      });
      if (existing) {
        results.push({ asin: trimmed, status: "skipped", message: "Already imported" });
        continue;
      }

      // Fetch Amazon data
      const amazonData = await fetchProductDetails(trimmed);

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
        results.push({
          asin: trimmed,
          status: "blocked",
          riskLevel,
          filterReason,
          title: amazonData.title,
        });
        continue;
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

      results.push({
        asin: trimmed,
        status: filterStatus === "warned" ? "warned" : "success",
        riskLevel,
        filterReason: filterReason || null,
        title: amazonData.title,
      });
    } catch (err) {
      await addLog(shop, trimmed, "import", "error", err.message);
      await prisma.amazonProduct.upsert({
        where: { asin: trimmed },
        create: { asin: trimmed, title: trimmed, syncStatus: "error", syncError: err.message },
        update: { syncStatus: "error", syncError: err.message },
      });
      results.push({ asin: trimmed, status: "error", message: err.message });
    }
  }

  return results;
}

export async function syncProduct(product, shop, accessToken) {
  const settings = await getSettings(shop);

  try {
    const amazonData = await fetchProductDetails(product.asin);

    // Re-check filter on sync
    const filterResult = await checkProductFilter(amazonData);
    const wasOutOfStock = product.outOfStock;
    const isNowOutOfStock = amazonData.outOfStock;
    const oldPrice = product.price;
    const newPrice = amazonData.price;

    if (product.shopifyProductId) {
      if (isNowOutOfStock && settings.autoHideOutOfStock) {
        await hideShopifyProduct(shop, accessToken, product.shopifyProductId);
        await addLog(shop, product.asin, "hidden", "success", "Product hidden (out of stock)");
      } else if (wasOutOfStock && !isNowOutOfStock) {
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
          syncStatus: isNowOutOfStock ? "hidden" : "synced",
          syncError: null,
          lastSyncedAt: new Date(),
          riskLevel: filterResult.riskLevel,
          filterReason: filterResult.filterReason,
        },
      });
    } else {
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
