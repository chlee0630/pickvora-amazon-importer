-- CreateTable
CREATE TABLE "OrderWebhookLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "webhookId" TEXT,
    "shopifyOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "payload" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrderQueueJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyOrderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'zinc',
    "payload" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" DATETIME,
    "completedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProviderOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestPayload" TEXT,
    "responsePayload" TEXT,
    "processingLockedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderWebhookLog_webhookId_key" ON "OrderWebhookLog"("webhookId");

-- CreateIndex
CREATE INDEX "OrderWebhookLog_shop_shopifyOrderId_idx" ON "OrderWebhookLog"("shop", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderQueueJob_shop_type_shopifyOrderId_key" ON "OrderQueueJob"("shop", "type", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderQueueJob_status_runAt_idx" ON "OrderQueueJob"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderOrder_shop_shopifyOrderId_provider_key" ON "ProviderOrder"("shop", "shopifyOrderId", "provider");

-- CreateIndex
CREATE INDEX "ProviderOrder_provider_providerOrderId_idx" ON "ProviderOrder"("provider", "providerOrderId");

-- CreateIndex
CREATE INDEX "ProviderOrder_status_processingLockedAt_idx" ON "ProviderOrder"("status", "processingLockedAt");
