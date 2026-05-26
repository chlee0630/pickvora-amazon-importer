import prisma from "../db.server.js";
import { buildDateWhere, redactDashboardText } from "../utils/dashboard-filters.server.js";

const ANALYTICS_METRICS = [
  "orders.total_processed",
  "orders.successful",
  "orders.failed",
  "orders.manual_review",
  "orders.fulfillment_success_rate",
  "retry.frequency",
  "retry.exhaustion_rate",
  "dlq.insertion_rate",
  "fulfillment.success_rate",
  "fulfillment.failure_count",
];

export async function getOperationsDashboard(shop, filters) {
  try {
    const [overview, queue, fulfillment, workers, apiFailures, analytics, lists] = await Promise.all([
      getOrderOverview(shop, filters),
      getQueueSummary(shop, filters),
      getFulfillmentSummary(shop, filters),
      getWorkerSummary(shop, filters),
      getApiFailureSummary(shop, filters),
      getAnalyticsSummary(filters),
      getOperationalLists(shop, filters),
    ]);

    return {
      overview,
      queue,
      fulfillment,
      workers,
      apiFailures,
      analytics,
      ...lists,
    };
  } catch (err) {
    console.error("Operations dashboard query failure:", err?.message || err);
    throw err;
  }
}

async function getApiFailureSummary(shop, filters) {
  const where = {
    shop,
    eventType: { in: ["api_failure", "api_timeout"] },
    ...buildDateWhere(filters),
  };

  const events = await prisma.monitoringEvent.findMany({
    where,
    select: {
      id: true,
      eventType: true,
      provider: true,
      count: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return {
    failureCount: events.filter((event) => event.eventType === "api_failure").length,
    timeoutCount: events.filter((event) => event.eventType === "api_timeout").length,
    recent: events.slice(0, 10),
  };
}

async function getOrderOverview(shop, filters) {
  const where = {
    shop,
    type: "order.create",
    ...buildDateWhere(filters),
  };

  const [totalProcessed, successfulOrders, failedOrders, manualReviewCount, fulfillmentTotal, fulfillmentSuccess] =
    await Promise.all([
      prisma.orderQueueJob.count({ where: { ...where, status: { in: ["complete", "failed"] } } }),
      prisma.orderQueueJob.count({ where: { ...where, status: "complete" } }),
      prisma.orderQueueJob.count({ where: { ...where, status: "failed" } }),
      prisma.orderQueueJob.count({
        where: {
          ...where,
          OR: [{ dlqStatus: "open" }, { status: "failed" }],
        },
      }),
      prisma.fulfillmentLog.count({ where: { shop, ...buildDateWhere(filters) } }),
      prisma.fulfillmentLog.count({ where: { shop, status: "success", ...buildDateWhere(filters) } }),
    ]);

  return {
    totalProcessed,
    successfulOrders,
    failedOrders,
    manualReviewCount,
    fulfillmentSuccessRate: rate(fulfillmentSuccess, fulfillmentTotal),
  };
}

async function getQueueSummary(shop, filters) {
  const now = new Date();
  const where = {
    shop,
    ...(filters.queueStatus ? { status: filters.queueStatus } : {}),
    ...buildDateWhere(filters),
  };

  const [activeJobs, failedJobs, delayedJobs, retryAggregate, dlqOpenJobs, dlqTotalJobs] = await Promise.all([
    prisma.orderQueueJob.count({ where: { shop, status: "processing", ...buildDateWhere(filters) } }),
    prisma.orderQueueJob.count({ where: { shop, status: "failed", ...buildDateWhere(filters) } }),
    prisma.orderQueueJob.count({ where: { shop, status: "pending", runAt: { gt: now }, ...buildDateWhere(filters) } }),
    prisma.orderQueueJob.aggregate({
      where: { ...where, attempts: { gt: 1 } },
      _sum: { attempts: true },
      _count: { id: true },
    }),
    prisma.deadLetterQueueJob.count({ where: { shop, status: "open", ...buildDateWhere(filters, "lastFailureAt") } }),
    prisma.deadLetterQueueJob.count({ where: { shop, ...buildDateWhere(filters, "lastFailureAt") } }),
  ]);

  return {
    activeJobs,
    failedJobs,
    delayedJobs,
    retryCounts: Math.max((retryAggregate._sum.attempts || 0) - retryAggregate._count.id, 0),
    dlqOpenJobs,
    dlqTotalJobs,
  };
}

async function getFulfillmentSummary(shop, filters) {
  const dateWhere = buildDateWhere(filters);
  const [fulfilledOrders, trackingReceivedOrders, fulfillmentFailures, duplicatePreventionEvents] =
    await Promise.all([
      prisma.fulfillmentLog.count({ where: { shop, status: "success", ...dateWhere } }),
      prisma.providerOrder.count({
        where: {
          shop,
          trackingReceivedAt: { not: null },
          ...buildDateWhere(filters, "trackingReceivedAt"),
        },
      }),
      prisma.fulfillmentLog.count({
        where: {
          shop,
          status: { not: "success" },
          ...dateWhere,
        },
      }),
      prisma.monitoringEvent.count({
        where: {
          shop,
          eventType: "fulfillment_duplicate_prevented",
          ...dateWhere,
        },
      }),
    ]);

  return {
    fulfilledOrders,
    trackingReceivedOrders,
    fulfillmentFailures,
    duplicatePreventionEvents,
  };
}

async function getWorkerSummary(shop, filters) {
  const where = {
    shop,
    eventType: { in: ["worker_success", "worker_failure", "worker_timeout"] },
    ...buildDateWhere(filters),
  };

  const events = await prisma.monitoringEvent.findMany({
    where,
    select: {
      eventType: true,
      workerName: true,
      durationMs: true,
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const successCount = events.filter((event) => event.eventType === "worker_success").length;
  const failureCount = events.filter((event) => event.eventType === "worker_failure").length;
  const timeoutCount = events.filter((event) => event.eventType === "worker_timeout").length;
  const durations = events.map((event) => event.durationMs).filter(Number.isFinite);

  return {
    successRate: rate(successCount, successCount + failureCount),
    timeoutCount,
    failureCount,
    averageProcessingDurationMs: average(durations),
    workers: summarizeWorkers(events),
  };
}

async function getAnalyticsSummary(filters) {
  try {
    const rows = await prisma.analyticsSummary.findMany({
      where: {
        metricName: { in: ANALYTICS_METRICS },
        ...buildDateWhere(filters, "bucketStart"),
      },
      orderBy: { bucketStart: "desc" },
      take: 200,
    });

    return summarizeAnalytics(rows);
  } catch (err) {
    console.error("Operations dashboard analytics fetch failure:", err?.message || err);
    return {};
  }
}

async function getOperationalLists(shop, filters) {
  const orderWhere = {
    shop,
    ...(filters.orderStatus ? { status: filters.orderStatus } : {}),
    ...(filters.failureCategory ? { failureCategory: filters.failureCategory } : {}),
    ...buildDateWhere(filters),
  };
  const dlqWhere = {
    shop,
    ...(filters.failureCategory ? { failureCategory: filters.failureCategory } : {}),
    ...buildDateWhere(filters, "lastFailureAt"),
  };

  const [
    failedOrders,
    failedOrdersTotal,
    dlqJobs,
    dlqJobsTotal,
    retryJobs,
    manualReviewOrders,
    invalidAddressOrders,
    restrictedProductOrders,
    permanentFailureOrders,
  ] = await Promise.all([
    prisma.orderQueueJob.findMany({
      where: { ...orderWhere, status: "failed" },
      orderBy: { lastFailureAt: "desc" },
      skip: filters.skip,
      take: filters.pageSize,
      select: orderListSelect(),
    }),
    prisma.orderQueueJob.count({ where: { ...orderWhere, status: "failed" } }),
    prisma.deadLetterQueueJob.findMany({
      where: dlqWhere,
      orderBy: { lastFailureAt: "desc" },
      skip: filters.skip,
      take: filters.pageSize,
      select: dlqListSelect(),
    }),
    prisma.deadLetterQueueJob.count({ where: dlqWhere }),
    prisma.orderQueueJob.findMany({
      where: {
        ...orderWhere,
        attempts: { gt: 1 },
      },
      orderBy: { updatedAt: "desc" },
      skip: filters.skip,
      take: filters.pageSize,
      select: orderListSelect(),
    }),
    prisma.orderQueueJob.findMany({
      where: {
        ...orderWhere,
        OR: [
          { dlqStatus: "open" },
          { status: "failed" },
          { failureReason: { contains: "invalid address" } },
          { failureReason: { contains: "restricted product" } },
        ],
      },
      orderBy: { lastFailureAt: "desc" },
      skip: filters.skip,
      take: filters.pageSize,
      select: orderListSelect(),
    }),
    prisma.orderQueueJob.count({
      where: {
        ...orderWhere,
        failureReason: { contains: "invalid address" },
      },
    }),
    prisma.orderQueueJob.count({
      where: {
        ...orderWhere,
        failureReason: { contains: "restricted product" },
      },
    }),
    prisma.orderQueueJob.count({
      where: {
        ...orderWhere,
        failureCategory: "permanent",
      },
    }),
  ]);

  return {
    failedOrders: failedOrders.map(formatOrderJob),
    failedOrdersTotal,
    dlqJobs: dlqJobs.map(formatDlqJob),
    dlqJobsTotal,
    retryJobs: retryJobs.map(formatOrderJob),
    manualReviewOrders: manualReviewOrders.map(formatOrderJob),
    manualReviewSummary: {
      invalidAddressOrders,
      restrictedProductOrders,
      permanentFailureOrders,
    },
  };
}

function orderListSelect() {
  return {
    id: true,
    type: true,
    status: true,
    shopifyOrderId: true,
    provider: true,
    attempts: true,
    maxAttempts: true,
    runAt: true,
    completedAt: true,
    lastError: true,
    failureReason: true,
    failureCategory: true,
    dlqStatus: true,
    lastFailureAt: true,
    updatedAt: true,
  };
}

function dlqListSelect() {
  return {
    id: true,
    type: true,
    status: true,
    shopifyOrderId: true,
    provider: true,
    attempts: true,
    maxAttempts: true,
    recoveryAttempts: true,
    failureCategory: true,
    failureReason: true,
    lastFailureAt: true,
  };
}

function formatOrderJob(job) {
  return {
    ...job,
    lastError: redactDashboardText(job.lastError),
    failureReason: redactDashboardText(job.failureReason),
  };
}

function formatDlqJob(job) {
  return {
    ...job,
    failureReason: redactDashboardText(job.failureReason),
  };
}

function summarizeWorkers(events) {
  const byWorker = new Map();
  for (const event of events) {
    const workerName = event.workerName || "unknown";
    if (!byWorker.has(workerName)) {
      byWorker.set(workerName, { workerName, success: 0, failure: 0, timeout: 0, durations: [] });
    }
    const row = byWorker.get(workerName);
    if (event.eventType === "worker_success") row.success += 1;
    if (event.eventType === "worker_failure") row.failure += 1;
    if (event.eventType === "worker_timeout") row.timeout += 1;
    if (Number.isFinite(event.durationMs)) row.durations.push(event.durationMs);
  }

  return Array.from(byWorker.values()).map((worker) => ({
    workerName: worker.workerName,
    successRate: rate(worker.success, worker.success + worker.failure),
    failureCount: worker.failure,
    timeoutCount: worker.timeout,
    averageDurationMs: average(worker.durations),
  }));
}

function summarizeAnalytics(rows) {
  return rows.reduce((summary, row) => {
    if (summary[row.metricName] === undefined) {
      summary[row.metricName] = row.value;
    }
    return summary;
  }, {});
}

function rate(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}
