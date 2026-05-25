import prisma from "../../db.server.js";
import { recordMonitoringEvent } from "./monitoring-service.server.js";

const DEFAULT_STUCK_MS = 10 * 60 * 1000;
const DEFAULT_CONGESTION_THRESHOLD = 100;
let lastHealthCheckAt = 0;

export function scheduleQueueHealthCheck(options = {}) {
  const minIntervalMs = options.minIntervalMs || 30 * 1000;
  if (Date.now() - lastHealthCheckAt < minIntervalMs) return;
  lastHealthCheckAt = Date.now();

  setTimeout(() => {
    collectQueueHealth(options).catch((err) =>
      console.error("Queue health check failed:", err?.message || err)
    );
  }, 0);
}

export async function collectQueueHealth({
  stuckMs = DEFAULT_STUCK_MS,
  congestionThreshold = DEFAULT_CONGESTION_THRESHOLD,
} = {}) {
  const now = new Date();
  const staleLock = new Date(Date.now() - stuckMs);

  const [activeJobs, failedJobs, delayedJobs, stuckJobs, oldestPendingJob, dlqOpenJobs] = await Promise.all([
    prisma.orderQueueJob.count({ where: { status: "processing" } }),
    prisma.orderQueueJob.count({ where: { status: "failed" } }),
    prisma.orderQueueJob.count({ where: { status: "pending", runAt: { gt: now } } }),
    prisma.orderQueueJob.count({ where: { status: "processing", lockedAt: { lt: staleLock } } }),
    prisma.orderQueueJob.findFirst({
      where: { status: "pending", runAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.deadLetterQueueJob.count({ where: { status: "open" } }),
  ]);

  const queueLatencyMs = oldestPendingJob ? Date.now() - oldestPendingJob.createdAt.getTime() : 0;
  const totalAttentionJobs = activeJobs + failedJobs + delayedJobs + stuckJobs + dlqOpenJobs;
  const eventType =
    stuckJobs > 0 || queueLatencyMs > stuckMs || totalAttentionJobs >= congestionThreshold
      ? "queue_congestion"
      : "queue_health";

  const result = {
    activeJobs,
    failedJobs,
    delayedJobs,
    stuckJobs,
    dlqOpenJobs,
    queueLatencyMs,
    congestionThreshold,
    count: totalAttentionJobs,
  };

  recordMonitoringEvent(eventType, result, {
    persist: eventType === "queue_congestion",
  });

  return result;
}
