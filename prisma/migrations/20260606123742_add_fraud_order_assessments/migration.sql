-- CreateTable
CREATE TABLE "FraudProtectionConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "autoCancelHighRisk" BOOLEAN NOT NULL DEFAULT false,
    "autoCancelMediumRisk" BOOLEAN NOT NULL DEFAULT false,
    "cancelReason" TEXT NOT NULL DEFAULT 'FRAUD',
    "restockInventory" BOOLEAN NOT NULL DEFAULT true,
    "refundPayment" BOOLEAN NOT NULL DEFAULT true,
    "notifyCustomer" BOOLEAN NOT NULL DEFAULT false,
    "delayMinutes" INTEGER NOT NULL DEFAULT 2,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FraudOrderAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "recommendation" TEXT,
    "score" REAL,
    "totalPrice" REAL,
    "currencyCode" TEXT,
    "displayFinancialStatus" TEXT,
    "displayFulfillmentStatus" TEXT,
    "cancelledAt" DATETIME,
    "assessmentStatus" TEXT NOT NULL DEFAULT 'ASSESSED',
    "decision" TEXT NOT NULL DEFAULT 'ALLOW',
    "actionMode" TEXT NOT NULL DEFAULT 'DRY_RUN',
    "cancellationStatus" TEXT,
    "cancellationError" TEXT,
    "riskPayload" TEXT,
    "assessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "FraudProtectionConfig_shop_key" ON "FraudProtectionConfig"("shop");

-- CreateIndex
CREATE INDEX "FraudOrderAssessment_shop_riskLevel_idx" ON "FraudOrderAssessment"("shop", "riskLevel");

-- CreateIndex
CREATE INDEX "FraudOrderAssessment_shop_decision_idx" ON "FraudOrderAssessment"("shop", "decision");

-- CreateIndex
CREATE INDEX "FraudOrderAssessment_shop_assessedAt_idx" ON "FraudOrderAssessment"("shop", "assessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FraudOrderAssessment_shop_shopifyOrderId_key" ON "FraudOrderAssessment"("shop", "shopifyOrderId");
