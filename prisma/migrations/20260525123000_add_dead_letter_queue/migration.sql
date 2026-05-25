ALTER TABLE "OrderQueueJob" ADD COLUMN "retryHistory" TEXT;
ALTER TABLE "OrderQueueJob" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "OrderQueueJob" ADD COLUMN "failureCategory" TEXT;
ALTER TABLE "OrderQueueJob" ADD COLUMN "dlqStatus" TEXT;
ALTER TABLE "OrderQueueJob" ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderQueueJob" ADD COLUMN "lastFailureAt" DATETIME;

CREATE TABLE "DeadLetterQueueJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originalJobId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'zinc',
    "status" TEXT NOT NULL DEFAULT 'open',
    "originalPayload" TEXT,
    "retryHistory" TEXT,
    "failureCategory" TEXT NOT NULL,
    "failureReason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "recoveryNote" TEXT,
    "lastFailureAt" DATETIME NOT NULL,
    "recoveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "DeadLetterQueueJob_originalJobId_key" ON "DeadLetterQueueJob"("originalJobId");
CREATE INDEX "OrderQueueJob_dlqStatus_idx" ON "OrderQueueJob"("dlqStatus");
CREATE INDEX "DeadLetterQueueJob_status_lastFailureAt_idx" ON "DeadLetterQueueJob"("status", "lastFailureAt");
CREATE INDEX "DeadLetterQueueJob_shop_shopifyOrderId_idx" ON "DeadLetterQueueJob"("shop", "shopifyOrderId");
