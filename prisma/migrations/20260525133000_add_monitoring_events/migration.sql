CREATE TABLE "MonitoringEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "shop" TEXT,
    "jobType" TEXT,
    "workerName" TEXT,
    "provider" TEXT,
    "shopifyOrderId" TEXT,
    "durationMs" INTEGER,
    "count" INTEGER,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "MonitoringEvent_eventType_createdAt_idx" ON "MonitoringEvent"("eventType", "createdAt");
CREATE INDEX "MonitoringEvent_severity_createdAt_idx" ON "MonitoringEvent"("severity", "createdAt");
CREATE INDEX "MonitoringEvent_shop_createdAt_idx" ON "MonitoringEvent"("shop", "createdAt");
