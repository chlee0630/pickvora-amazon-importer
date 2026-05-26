ALTER TABLE "ProviderOrder" ADD COLUMN "providerFailureCode" TEXT;
ALTER TABLE "ProviderOrder" ADD COLUMN "providerFailureMessage" TEXT;
ALTER TABLE "ProviderOrder" ADD COLUMN "providerAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProviderOrder" ADD COLUMN "providerLastAttemptAt" DATETIME;

CREATE TABLE "ProviderHealth" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "disabledReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ProviderHealth_providerName_key" ON "ProviderHealth"("providerName");
CREATE INDEX "ProviderHealth_status_idx" ON "ProviderHealth"("status");
