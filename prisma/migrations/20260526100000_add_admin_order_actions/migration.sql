CREATE TABLE "AdminOrderAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "adminNote" TEXT,
    "actionPayload" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AdminOrderAction_shop_shopifyOrderId_idx" ON "AdminOrderAction"("shop", "shopifyOrderId");
CREATE INDEX "AdminOrderAction_actionType_idx" ON "AdminOrderAction"("actionType");
CREATE INDEX "AdminOrderAction_createdAt_idx" ON "AdminOrderAction"("createdAt");
