import prisma from "../../db.server.js";
import {
  dimensionsKey,
  safeAverage,
  safeRate,
} from "./analytics-utils.server.js";
import { logAnalyticsEvent } from "./analytics-logger.server.js";

const MAX_EVENTS_PER_BUCKET = 5000;

export async function aggregateAnalyticsWindow({ bucketStart, bucketEnd }) {
  const [monitoringEvents, orders, providerOrders, dlqJobs, trackingLogs, fulfillmentLogs] = await Promise.all([
    prisma.monitoringEvent.findMany({
      where: { createdAt: { gte: bucketStart, lt: bucketEnd } },
      orderBy: { createdAt: "asc" },
      take: MAX_EVENTS_PER_BUCKET,
    }),
    prisma.orderQueueJob.findMany({
      where: { createdAt: { lt: bucketEnd }, updatedAt: { gte: bucketStart } },
      select: {
        shop: true,
        type: true,
        status: true,
        attempts: true,
        failureCategory: true,
        createdAt: true,
        completedAt: true,
        lastFailureAt: true,
        dlqStatus: true,
      },
      take: MAX_EVENTS_PER_BUCKET,
    }),
    prisma.providerOrder.findMany({
      where: { updatedAt: { gte: bucketStart, lt: bucketEnd } },
      select: {
        shop: true,
        status: true,
        createdAt: true,
        trackingReceivedAt: true,
        fulfillmentSyncedAt: true,
      },
      take: MAX_EVENTS_PER_BUCKET,
    }),
    prisma.deadLetterQueueJob.findMany({
      where: { lastFailureAt: { gte: bucketStart, lt: bucketEnd } },
      select: {
        shop: true,
        type: true,
        failureCategory: true,
        recoveryAttempts: true,
      },
      take: MAX_EVENTS_PER_BUCKET,
    }),
    prisma.trackingLog.findMany({
      where: { createdAt: { gte: bucketStart, lt: bucketEnd } },
      select: { shop: true, status: true, createdAt: true },
      take: MAX_EVENTS_PER_BUCKET,
    }),
    prisma.fulfillmentLog.findMany({
      where: { createdAt: { gte: bucketStart, lt: bucketEnd } },
      select: { shop: true, status: true, createdAt: true },
      take: MAX_EVENTS_PER_BUCKET,
    }),
  ]);

  const summaries = [
    ...buildOrderSummaries(orders, fulfillmentLogs),
    ...buildRetrySummaries(orders, monitoringEvents),
    ...buildWorkerSummaries(monitoringEvents),
    ...buildApiSummaries(monitoringEvents),
    ...buildDlqSummaries(dlqJobs),
    ...buildTrackingSummaries(providerOrders, trackingLogs),
    ...buildFulfillmentSummaries(providerOrders, fulfillmentLogs, monitoringEvents),
  ];

  await writeSummaries({ bucketStart, bucketEnd, summaries });

  if (
    monitoringEvents.length >= MAX_EVENTS_PER_BUCKET ||
    orders.length >= MAX_EVENTS_PER_BUCKET ||
    providerOrders.length >= MAX_EVENTS_PER_BUCKET
  ) {
    logAnalyticsEvent("metric_anomaly", {
      anomaly: "analytics_bucket_limit_reached",
      bucketStart,
      bucketEnd,
      monitoringEvents: monitoringEvents.length,
      orders: orders.length,
      providerOrders: providerOrders.length,
    });
  }

  return { summaryCount: summaries.length };
}

function buildOrderSummaries(orders, fulfillmentLogs) {
  const totalProcessed = orders.filter((job) => job.type === "order.create");
  const successfulOrders = totalProcessed.filter((job) => job.status === "complete");
  const failedOrders = totalProcessed.filter((job) => job.status === "failed");
  const manualReviewOrders = orders.filter((job) => job.dlqStatus === "open" || job.status === "failed");
  const fulfillmentSuccess = fulfillmentLogs.filter((log) => log.status === "success").length;

  return [
    metric("orders.total_processed", totalProcessed.length),
    metric("orders.successful", successfulOrders.length),
    metric("orders.failed", failedOrders.length),
    metric("orders.manual_review", manualReviewOrders.length),
    metric("orders.fulfillment_success_rate", safeRate(fulfillmentSuccess, fulfillmentLogs.length)),
  ];
}

function buildRetrySummaries(orders, events) {
  const retryEvents = events.filter((event) => event.eventType === "retry_attempt");
  const exhaustedEvents = events.filter((event) => event.eventType === "retry_exhausted");
  const retriedOrders = orders.filter((job) => job.attempts > 1);
  const retryTotals = retriedOrders.reduce((sum, job) => sum + Math.max(job.attempts - 1, 0), 0);
  const categoryMetrics = countBy(
    orders.filter((job) => job.failureCategory),
    (job) => job.failureCategory
  ).map(([category, count]) => metric("retry.failure_category", count, { category }));

  return [
    metric("retry.frequency", retryEvents.length),
    metric("retry.exhaustion_rate", safeRate(exhaustedEvents.length, retryEvents.length + exhaustedEvents.length)),
    metric("retry.average_per_order", safeAverage(retryTotals, orders.length)),
    ...categoryMetrics,
  ];
}

function buildWorkerSummaries(events) {
  const workerEvents = events.filter((event) =>
    ["worker_success", "worker_failure", "worker_timeout", "worker_crash_recovery"].includes(event.eventType)
  );
  const byWorker = groupBy(workerEvents, (event) => event.workerName || "unknown");

  return Array.from(byWorker.entries()).flatMap(([workerName, items]) => {
    const successCount = items.filter((event) => event.eventType === "worker_success").length;
    const failureCount = items.filter((event) => event.eventType === "worker_failure").length;
    const timeoutCount = items.filter((event) => event.eventType === "worker_timeout").length;
    const crashCount = items.filter((event) => event.eventType === "worker_crash_recovery").length;
    const durations = items.map((event) => event.durationMs).filter(Number.isFinite);

    return [
      metric("worker.average_duration_ms", safeAverage(sum(durations), durations.length), { workerName }),
      metric("worker.timeout_frequency", timeoutCount, { workerName }),
      metric("worker.success_rate", safeRate(successCount, successCount + failureCount), { workerName }),
      metric("worker.crash_frequency", crashCount, { workerName }),
    ];
  });
}

function buildApiSummaries(events) {
  const apiEvents = events.filter((event) =>
    ["api_success", "api_failure", "api_timeout"].includes(event.eventType)
  );
  const byProvider = groupBy(apiEvents, (event) => event.provider || "unknown");

  return Array.from(byProvider.entries()).flatMap(([provider, items]) => {
    const successCount = items.filter((event) => event.eventType === "api_success").length;
    const failureCount = items.filter((event) => event.eventType === "api_failure").length;
    const timeoutCount = items.filter((event) => event.eventType === "api_timeout").length;
    const durations = items.map((event) => event.durationMs).filter(Number.isFinite);

    return [
      metric("api.failure_rate", safeRate(failureCount + timeoutCount, successCount + failureCount + timeoutCount), { provider }),
      metric("api.timeout_frequency", timeoutCount, { provider }),
      metric("api.average_latency_ms", safeAverage(sum(durations), durations.length), { provider }),
    ];
  });
}

function buildDlqSummaries(dlqJobs) {
  const categoryMetrics = countBy(dlqJobs, (job) => job.failureCategory || "unknown")
    .map(([category, count]) => metric("dlq.permanent_failure_category", count, { category }));
  const recoveryAttempts = dlqJobs.reduce((total, job) => total + job.recoveryAttempts, 0);

  return [
    metric("dlq.insertion_rate", dlqJobs.length),
    metric("dlq.recovery_attempts", recoveryAttempts),
    ...categoryMetrics,
  ];
}

function buildTrackingSummaries(providerOrders, trackingLogs) {
  const trackingDurations = providerOrders
    .filter((order) => order.trackingReceivedAt)
    .map((order) => order.trackingReceivedAt.getTime() - order.createdAt.getTime())
    .filter((duration) => duration >= 0);
  const trackingSuccess = trackingLogs.filter((log) => log.status === "TRACKING_RECEIVED").length;

  return [
    metric("tracking.average_delay_ms", safeAverage(sum(trackingDurations), trackingDurations.length)),
    metric("tracking.success_rate", safeRate(trackingSuccess, providerOrders.length || trackingLogs.length)),
  ];
}

function buildFulfillmentSummaries(providerOrders, fulfillmentLogs, events) {
  const completionDurations = providerOrders
    .filter((order) => order.trackingReceivedAt && order.fulfillmentSyncedAt)
    .map((order) => order.fulfillmentSyncedAt.getTime() - order.trackingReceivedAt.getTime())
    .filter((duration) => duration >= 0);
  const failureEvents = events.filter((event) => event.eventType === "fulfillment_failure").length;
  const successLogs = fulfillmentLogs.filter((log) => log.status === "success").length;

  return [
    metric("fulfillment.average_completion_delay_ms", safeAverage(sum(completionDurations), completionDurations.length)),
    metric("fulfillment.success_rate", safeRate(successLogs, successLogs + failureEvents)),
    metric("fulfillment.failure_count", failureEvents),
  ];
}

async function writeSummaries({ bucketStart, bucketEnd, summaries }) {
  const uniqueSummaries = new Map();
  for (const summary of summaries) {
    uniqueSummaries.set(`${summary.metricName}:${dimensionsKey(summary.dimensions)}`, summary);
  }

  for (const summary of uniqueSummaries.values()) {
    await prisma.analyticsSummary.upsert({
      where: {
        metricName_bucketStart_dimensionsKey: {
          metricName: summary.metricName,
          bucketStart,
          dimensionsKey: dimensionsKey(summary.dimensions),
        },
      },
      create: {
        metricName: summary.metricName,
        bucketStart,
        bucketEnd,
        dimensionsKey: dimensionsKey(summary.dimensions),
        dimensions: JSON.stringify(summary.dimensions),
        value: summary.value,
        count: Number.isFinite(summary.count) ? summary.count : null,
      },
      update: {
        bucketEnd,
        dimensions: JSON.stringify(summary.dimensions),
        value: summary.value,
        count: Number.isFinite(summary.count) ? summary.count : null,
      },
    });
  }
}

function metric(metricName, value, dimensions = {}, count = null) {
  return { metricName, value: Number(value) || 0, dimensions, count };
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function countBy(items, keyFn) {
  return Array.from(groupBy(items, keyFn).entries()).map(([key, values]) => [key, values.length]);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function detectAnalyticsAnomalies(summaries) {
  return summaries
    .filter((summary) =>
      summary.metricName.includes("average") && summary.value > 5 * 60 * 1000
    )
    .map((summary) => ({
      metricName: summary.metricName,
      value: summary.value,
      dimensions: summary.dimensions,
    }));
}
