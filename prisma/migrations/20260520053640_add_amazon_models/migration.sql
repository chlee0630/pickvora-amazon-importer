-- CreateTable
CREATE TABLE "AmazonProduct" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "defaultMargin" REAL NOT NULL DEFAULT 30,
    "includeShipping" BOOLEAN NOT NULL DEFAULT false,
    "autoHideOutOfStock" BOOLEAN NOT NULL DEFAULT true,
    "addReviewsToDesc" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerateTags" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SchedulerConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'daily',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UpdateLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT,
    "asin" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AmazonProduct_asin_key" ON "AmazonProduct"("asin");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulerConfig_shop_key" ON "SchedulerConfig"("shop");
