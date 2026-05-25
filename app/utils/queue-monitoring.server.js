import prisma from "../db.server.js";
import { logFailureAudit } from "./failure-audit-log.server.js";
import { recordMonitoringEvent } from "../services/monitoring/monitoring-service.server.js";

export async function recoverStaleProcessingJobs({ olderThanMs = 10 * 60 * 1000, types } = {}) {
  const staleLock = new Date(Date.now() - olderThanMs);
  const result = await prisma.orderQueueJob.updateMany({
    where: {
      status: "processing",
      lockedAt: { lt: staleLock },
      ...(types?.length ? { type: { in: types } } : {}),
    },
    data: {
      status: "pending",
      lockedAt: null,
      failureReason: "Recovered stale processing job after worker crash",
    },
  });

  if (result.count > 0) {
    logFailureAudit("worker_crash_recovery", {
      recoveredJobs: result.count,
      olderThanMs,
      types: types || "all",
    });
    recordMonitoringEvent("worker_crash_recovery", {
      recoveredJobs: result.count,
      olderThanMs,
      types: types || "all",
      count: result.count,
    });
  }

  return result.count;
}
