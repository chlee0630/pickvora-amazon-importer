CREATE TABLE "AnalyticsSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "metricName" TEXT NOT NULL,
    "bucketStart" DATETIME NOT NULL,
    "bucketEnd" DATETIME NOT NULL,
    "dimensionsKey" TEXT NOT NULL DEFAULT '{}',
    "dimensions" TEXT,
    "value" REAL NOT NULL,
    "count" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AnalyticsAggregationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucketStart" DATETIME NOT NULL,
    "bucketEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "summaryCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "AnalyticsSummary_metricName_bucketStart_dimensionsKey_key" ON "AnalyticsSummary"("metricName", "bucketStart", "dimensionsKey");
CREATE INDEX "AnalyticsSummary_metricName_bucketStart_idx" ON "AnalyticsSummary"("metricName", "bucketStart");
CREATE INDEX "AnalyticsSummary_bucketStart_bucketEnd_idx" ON "AnalyticsSummary"("bucketStart", "bucketEnd");
CREATE UNIQUE INDEX "AnalyticsAggregationRun_bucketStart_bucketEnd_key" ON "AnalyticsAggregationRun"("bucketStart", "bucketEnd");
CREATE INDEX "AnalyticsAggregationRun_status_bucketEnd_idx" ON "AnalyticsAggregationRun"("status", "bucketEnd");
