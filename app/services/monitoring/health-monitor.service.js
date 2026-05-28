import prisma from "../../db.server.js";
import { getHealthThresholds } from "../../config/health-thresholds.server.js";
import { maskSensitivePayload } from "../../utils/failure-audit-log.server.js";
import { recordMonitoringEvent } from "./monitoring-service.server.js";

const STATUS_ORDER = { OK: 0, WARNING: 1, CRITICAL: 2 };
const WORKERS = [
  "order_worker",
  "tracking_polling_worker",
  "fulfillment_update_worker",
];
const heartbeatCache = new Map();

export async function recordWorkerHeartbeat(workerName, details = {}) {
  const minIntervalMs = details.minIntervalMs || 60 * 1000;
  const now = Date.now();
  const last = heartbeatCache.get(workerName) || 0;
  if (now - last < minIntervalMs) return;
  heartbeatCache.set(workerName, now);

  try {
    recordMonitoringEvent("worker_heartbeat", {
      workerName,
      status: "alive",
      ...maskSensitivePayload(details),
    }, { persist: true });
  } catch (err) {
    console.error("Worker heartbeat failed:", err?.message || err);
  }
}

export async function getQueueHealth({ shop, client = prisma } = {}) {
  const thresholds = getHealthThresholds();
  return withHealthFallback("queue", async () => {
    const now = new Date();
    const staleLock = new Date(Date.now() - thresholds.queueOldestJobWarningMinutes * 60 * 1000);
    const whereShop = shop ? { shop } : {};
    const [waitingCount, activeCount, delayedCount, failedCount, stalledJobs, oldestWaitingJob] = await Promise.all([
      client.orderQueueJob.count({ where: { ...whereShop, status: "pending", runAt: { lte: now } } }),
      client.orderQueueJob.count({ where: { ...whereShop, status: "processing" } }),
      client.orderQueueJob.count({ where: { ...whereShop, status: "pending", runAt: { gt: now } } }),
      client.orderQueueJob.count({ where: { ...whereShop, status: "failed" } }),
      client.orderQueueJob.count({ where: { ...whereShop, status: "processing", lockedAt: { lt: staleLock } } }),
      client.orderQueueJob.findFirst({
        where: { ...whereShop, status: "pending", runAt: { lte: now } },
        orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
        select: { createdAt: true, runAt: true },
      }),
    ]);

    const oldestWaitingJobAgeMinutes = oldestWaitingJob
      ? Math.floor((Date.now() - oldestWaitingJob.createdAt.getTime()) / 60000)
      : 0;
    const status = maxStatus(
      thresholdStatus(waitingCount, thresholds.queueWaitingWarningThreshold, thresholds.queueWaitingCriticalThreshold),
      thresholdStatus(oldestWaitingJobAgeMinutes, thresholds.queueOldestJobWarningMinutes, thresholds.queueOldestJobCriticalMinutes),
      stalledJobs > 0 ? "WARNING" : "OK"
    );
    const result = {
      category: "queue",
      status,
      waitingCount,
      activeCount,
      delayedCount,
      failedCount,
      stalledJobs,
      oldestWaitingJobAgeMinutes,
      paused: false,
      message: status === "OK" ? "Queue is within thresholds." : "Queue backlog or stalled jobs detected.",
      checkedAt: new Date().toISOString(),
    };
    logBreach("queue_health_breach", result);
    return result;
  });
}

export async function getWorkerHeartbeatHealth({ client = prisma } = {}) {
  const thresholds = getHealthThresholds();
  return withHealthFallback("worker_heartbeat", async () => {
    const since = new Date(Date.now() - thresholds.workerHeartbeatCriticalMinutes * 4 * 60 * 1000);
    const events = await client.monitoringEvent.findMany({
      where: {
        eventType: "worker_heartbeat",
        createdAt: { gte: since },
      },
      select: { workerName: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const latest = firstBy(events, "workerName");
    const workers = WORKERS.map((workerName) => {
      const lastHeartbeatAt = latest.get(workerName)?.createdAt || null;
      const ageMinutes = lastHeartbeatAt ? Math.floor((Date.now() - lastHeartbeatAt.getTime()) / 60000) : null;
      const status = ageMinutes == null
        ? "WARNING"
        : thresholdStatus(ageMinutes, thresholds.workerHeartbeatWarningMinutes, thresholds.workerHeartbeatCriticalMinutes);
      return {
        workerName,
        status,
        lastHeartbeatAt,
        ageMinutes,
        message: status === "OK" ? "Heartbeat is fresh." : "Worker heartbeat is stale or missing.",
      };
    });
    const result = {
      category: "worker_heartbeat",
      status: maxStatus(...workers.map((worker) => worker.status)),
      workers,
      checkedAt: new Date().toISOString(),
    };
    for (const worker of workers) {
      if (worker.status !== "OK") logBreach("worker_heartbeat_stale", worker);
    }
    return result;
  });
}

export async function getApiFailureHealth({ shop, client = prisma } = {}) {
  const thresholds = getHealthThresholds();
  return withHealthFallback("api_failure", async () => {
    const since = new Date(Date.now() - thresholds.apiFailureWindowMinutes * 60 * 1000);
    const events = await client.monitoringEvent.findMany({
      where: {
        eventType: { in: ["api_success", "api_failure", "api_timeout"] },
        createdAt: { gte: since },
        ...(shop ? { shop } : {}),
      },
      select: { eventType: true, provider: true, payload: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });
    const providers = groupBy(events, (event) => event.provider || "unknown");
    const rows = Array.from(providers.entries()).map(([provider, items]) => {
      const failureCount = items.filter((event) => event.eventType === "api_failure").length;
      const timeoutCount = items.filter((event) => event.eventType === "api_timeout").length;
      const successCount = items.filter((event) => event.eventType === "api_success").length;
      const statusCounts = countApiStatuses(items);
      const totalFailures = failureCount + timeoutCount;
      const totalRequests = successCount + totalFailures;
      const failureRate = totalRequests ? Math.round((totalFailures / totalRequests) * 1000) / 10 : 0;
      const status = maxStatus(
        thresholdStatus(totalFailures, thresholds.apiFailureWarningThreshold, thresholds.apiFailureCriticalThreshold),
        thresholdStatus(failureRate, thresholds.apiFailureRateWarningPercent, thresholds.apiFailureRateCriticalPercent)
      );
      return {
        provider,
        status,
        failureCount,
        timeoutCount,
        rateLimitCount: statusCounts.rateLimitCount,
        serverErrorCount: statusCounts.serverErrorCount,
        successCount,
        failureRate,
        windowMinutes: thresholds.apiFailureWindowMinutes,
      };
    });
    const result = {
      category: "api_failure",
      status: rows.length ? maxStatus(...rows.map((row) => row.status)) : "OK",
      providers: rows,
      checkedAt: new Date().toISOString(),
    };
    for (const row of rows) {
      if (row.status !== "OK") logBreach("api_failure_spike", row);
    }
    return result;
  });
}

export async function getProviderHealth({ client = prisma } = {}) {
  const thresholds = getHealthThresholds();
  return withHealthFallback("provider", async () => {
    const rows = await client.providerHealth.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    const providers = rows.map((row) => {
      const status = row.status === "DISABLED"
        ? "CRITICAL"
        : maxStatus(
          row.status === "DEGRADED" ? "WARNING" : "OK",
          thresholdStatus(row.failureCount, thresholds.providerFailureWarningThreshold, thresholds.providerFailureCriticalThreshold)
        );
      return {
        provider: row.providerName,
        status,
        recentFailures: row.failureCount,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        message: providerMessage(row, status),
      };
    });
    const result = {
      category: "provider",
      status: providers.length ? maxStatus(...providers.map((provider) => provider.status)) : "OK",
      providers,
      checkedAt: new Date().toISOString(),
    };
    for (const provider of providers) {
      if (provider.status !== "OK") logBreach("provider_unhealthy", provider);
    }
    return result;
  });
}

export async function getDlqHealth({ shop, client = prisma } = {}) {
  const thresholds = getHealthThresholds();
  return withHealthFallback("dlq", async () => {
    const since = new Date(Date.now() - thresholds.dlqIncreaseWindowMinutes * 60 * 1000);
    const whereShop = shop ? { shop } : {};
    const [currentSize, recentIncrease] = await Promise.all([
      client.deadLetterQueueJob.count({ where: { ...whereShop, status: "open" } }),
      client.deadLetterQueueJob.count({ where: { ...whereShop, lastFailureAt: { gte: since } } }),
    ]);
    const status = thresholdStatus(
      recentIncrease,
      thresholds.dlqIncreaseWarningThreshold,
      thresholds.dlqIncreaseCriticalThreshold
    );
    const result = {
      category: "dlq",
      status,
      currentSize,
      recentIncrease,
      windowMinutes: thresholds.dlqIncreaseWindowMinutes,
      message: status === "OK" ? "DLQ is stable." : "DLQ increased within the recent health window.",
      checkedAt: new Date().toISOString(),
    };
    logBreach("dlq_increase_detected", result);
    return result;
  });
}

export async function getTrackingPollingHealth({ shop, client = prisma } = {}) {
  const thresholds = getHealthThresholds();
  return withHealthFallback("tracking_polling", async () => {
    const warningBefore = new Date(Date.now() - thresholds.trackingDelayWarningMinutes * 60 * 1000);
    const criticalBefore = new Date(Date.now() - thresholds.trackingDelayCriticalMinutes * 60 * 1000);
    const whereShop = shop ? { shop } : {};
    const [delayedOrders, criticalDelayedOrders, delayedPollingJobs] = await Promise.all([
      client.providerOrder.count({
        where: {
          ...whereShop,
          status: { in: ["ORDERED", "ZINC_SUBMITTED"] },
          trackingReceivedAt: null,
          createdAt: { lt: warningBefore },
        },
      }),
      client.providerOrder.count({
        where: {
          ...whereShop,
          status: { in: ["ORDERED", "ZINC_SUBMITTED"] },
          trackingReceivedAt: null,
          createdAt: { lt: criticalBefore },
        },
      }),
      client.orderQueueJob.count({
        where: {
          ...whereShop,
          type: "tracking.poll",
          status: "pending",
          runAt: { lt: warningBefore },
        },
      }),
    ]);
    const status = criticalDelayedOrders > 0
      ? "CRITICAL"
      : delayedOrders > 0 || delayedPollingJobs > 0 ? "WARNING" : "OK";
    const result = {
      category: "tracking_polling",
      status,
      delayedOrders,
      criticalDelayedOrders,
      delayedPollingJobs,
      warningMinutes: thresholds.trackingDelayWarningMinutes,
      criticalMinutes: thresholds.trackingDelayCriticalMinutes,
      message: status === "OK" ? "Tracking polling delay is within thresholds." : "Tracking polling delay detected.",
      checkedAt: new Date().toISOString(),
    };
    logBreach("tracking_polling_delay", result);
    return result;
  });
}

export async function getDashboardHealthSummary({ shop, client = prisma } = {}) {
  const checkedAt = new Date().toISOString();
  const [queue, workers, apiFailures, provider, dlq, trackingPolling] = await Promise.all([
    getQueueHealth({ shop, client }),
    getWorkerHeartbeatHealth({ shop, client }),
    getApiFailureHealth({ shop, client }),
    getProviderHealth({ client }),
    getDlqHealth({ shop, client }),
    getTrackingPollingHealth({ shop, client }),
  ]);
  const components = { queue, workers, apiFailures, provider, dlq, trackingPolling };
  const overallStatus = maxStatus(...Object.values(components).map((item) => item.status));
  const summary = {
    overallStatus,
    components,
    lastCheckedAt: checkedAt,
  };

  recordMonitoringEvent("health_check_execution", {
    shop,
    status: overallStatus,
    checkedAt,
  });
  if (overallStatus !== "OK") {
    recordMonitoringEvent("health_threshold_breach", {
      shop,
      status: overallStatus,
      components: Object.fromEntries(
        Object.entries(components).map(([key, value]) => [key, value.status])
      ),
    }, { persist: true });
  }

  return summary;
}

function withHealthFallback(category, handler) {
  return handler().catch((err) => {
    console.error(`${category} health check failed:`, err?.message || err);
    return {
      category,
      status: "WARNING",
      unavailable: true,
      message: `${category} health data is unavailable.`,
      checkedAt: new Date().toISOString(),
    };
  });
}

function thresholdStatus(value, warning, critical) {
  if (value >= critical) return "CRITICAL";
  if (value >= warning) return "WARNING";
  return "OK";
}

function maxStatus(...statuses) {
  return statuses.reduce((max, status) =>
    STATUS_ORDER[status] > STATUS_ORDER[max] ? status : max, "OK");
}

function firstBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row[key])) result.set(row[key], row);
  }
  return result;
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function countApiStatuses(items) {
  return items.reduce((counts, item) => {
    const payload = parsePayload(item.payload);
    const status = Number(payload.status);
    if (status === 429) counts.rateLimitCount += 1;
    if (status >= 500 && status <= 599) counts.serverErrorCount += 1;
    return counts;
  }, { rateLimitCount: 0, serverErrorCount: 0 });
}

function parsePayload(payload) {
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function providerMessage(row, status) {
  if (row.status === "DISABLED") return row.disabledReason || "Provider is disabled.";
  if (status === "CRITICAL") return "Provider failure threshold exceeded.";
  if (status === "WARNING") return "Provider is degraded or seeing repeated failures.";
  return "Provider is healthy.";
}

function logBreach(event, details) {
  if (details.status === "OK") return;
  recordMonitoringEvent(event, maskSensitivePayload(details), {
    persist: details.status === "CRITICAL",
  });
}
