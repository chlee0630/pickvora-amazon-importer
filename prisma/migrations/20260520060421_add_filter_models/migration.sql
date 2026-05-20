-- CreateTable
CREATE TABLE "BrandBlacklist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brand" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL DEFAULT 'high',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CategoryBlacklist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "KeywordFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyword" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AmazonProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asin" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT,
    "description" TEXT,
    "featureBullets" TEXT,
    "price" REAL,
    "salePrice" REAL,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "stockQuantity" INTEGER,
    "outOfStock" BOOLEAN NOT NULL DEFAULT false,
    "shippingPrice" REAL,
    "primeEligible" BOOLEAN NOT NULL DEFAULT false,
    "mainImage" TEXT,
    "images" TEXT,
    "variants" TEXT,
    "rating" REAL,
    "ratingsTotal" INTEGER,
    "reviews" TEXT,
    "bestsellRank" INTEGER,
    "amazonUrl" TEXT,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "shopifyHandle" TEXT,
    "marginRate" REAL NOT NULL DEFAULT 30,
    "shopifyPrice" REAL,
    "lastSyncedAt" DATETIME,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'safe',
    "filterStatus" TEXT NOT NULL DEFAULT 'ok',
    "filterReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AmazonProduct" ("amazonUrl", "asin", "bestsellRank", "brand", "category", "createdAt", "description", "featureBullets", "id", "images", "inStock", "lastSyncedAt", "mainImage", "marginRate", "outOfStock", "price", "primeEligible", "rating", "ratingsTotal", "reviews", "salePrice", "shippingPrice", "shopifyHandle", "shopifyPrice", "shopifyProductId", "shopifyVariantId", "stockQuantity", "syncError", "syncStatus", "title", "updatedAt", "variants") SELECT "amazonUrl", "asin", "bestsellRank", "brand", "category", "createdAt", "description", "featureBullets", "id", "images", "inStock", "lastSyncedAt", "mainImage", "marginRate", "outOfStock", "price", "primeEligible", "rating", "ratingsTotal", "reviews", "salePrice", "shippingPrice", "shopifyHandle", "shopifyPrice", "shopifyProductId", "shopifyVariantId", "stockQuantity", "syncError", "syncStatus", "title", "updatedAt", "variants" FROM "AmazonProduct";
DROP TABLE "AmazonProduct";
ALTER TABLE "new_AmazonProduct" RENAME TO "AmazonProduct";
CREATE UNIQUE INDEX "AmazonProduct_asin_key" ON "AmazonProduct"("asin");
CREATE TABLE "new_AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "defaultMargin" REAL NOT NULL DEFAULT 30,
    "includeShipping" BOOLEAN NOT NULL DEFAULT false,
    "autoHideOutOfStock" BOOLEAN NOT NULL DEFAULT true,
    "addReviewsToDesc" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerateTags" BOOLEAN NOT NULL DEFAULT true,
    "saleMode" TEXT NOT NULL DEFAULT 'direct',
    "addDisclaimer" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("addReviewsToDesc", "autoGenerateTags", "autoHideOutOfStock", "createdAt", "defaultMargin", "id", "includeShipping", "shop", "updatedAt") SELECT "addReviewsToDesc", "autoGenerateTags", "autoHideOutOfStock", "createdAt", "defaultMargin", "id", "includeShipping", "shop", "updatedAt" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "BrandBlacklist_brand_key" ON "BrandBlacklist"("brand");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryBlacklist_category_key" ON "CategoryBlacklist"("category");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordFilter_keyword_key" ON "KeywordFilter"("keyword");
