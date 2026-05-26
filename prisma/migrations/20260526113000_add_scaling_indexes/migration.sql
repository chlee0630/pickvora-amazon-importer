CREATE INDEX "OrderQueueJob_shopifyOrderId_idx" ON "OrderQueueJob"("shopifyOrderId");
CREATE INDEX "OrderQueueJob_shop_status_updatedAt_idx" ON "OrderQueueJob"("shop", "status", "updatedAt");
CREATE INDEX "ProviderOrder_providerOrderId_idx" ON "ProviderOrder"("providerOrderId");
CREATE INDEX "ProviderOrder_shop_updatedAt_idx" ON "ProviderOrder"("shop", "updatedAt");
