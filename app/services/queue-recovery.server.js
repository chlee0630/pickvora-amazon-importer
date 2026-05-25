import prisma from "../db.server.js";
import { scheduleWorkerForJobType } from "../queues/order-queue.server.js";
import { logFailureAudit } from "../utils/failure-audit-log.server.js";
import { recordDlqMetric } from "./monitoring/monitoring-service.server.js";

export async function getDeadLetterJob(deadLetterJobId) {
  return prisma.deadLetterQueueJob.findUnique({ where: { id: deadLetterJobId } });
}

export async function listRecoverableDeadLetterJobs({ shop, type, take = 50 } = {}) {
  return prisma.deadLetterQueueJob.findMany({
    where: {
      status: { in: ["open", "recovering"] },
      ...(shop ? { shop } : {}),
      ...(type ? { type } : {}),
    },
    orderBy: [{ lastFailureAt: "desc" }, { createdAt: "desc" }],
    take,
  });
}

export async function replayDeadLetterJob(deadLetterJobId, { requestedBy = "manual" } = {}) {
  const deadLetterJob = await prisma.deadLetterQueueJob.findUnique({
    where: { id: deadLetterJobId },
  });
  if (!deadLetterJob) throw new Error(`Dead letter job not found: ${deadLetterJobId}`);
  if (deadLetterJob.status === "replayed") return deadLetterJob;

  const updated = await prisma.$transaction(async (tx) => {
    const existingQueueJob = await tx.orderQueueJob.findUnique({
      where: { id: deadLetterJob.originalJobId },
    });

    if (existingQueueJob?.status === "processing") {
      throw new Error("Cannot replay a job that is currently processing");
    }

    await tx.orderQueueJob.upsert({
      where: { id: deadLetterJob.originalJobId },
      create: {
        id: deadLetterJob.originalJobId,
        shop: deadLetterJob.shop,
        type: deadLetterJob.type,
        shopifyOrderId: deadLetterJob.shopifyOrderId,
        provider: deadLetterJob.provider,
        payload: deadLetterJob.originalPayload,
        attempts: 0,
        maxAttempts: deadLetterJob.maxAttempts,
        status: "pending",
        runAt: new Date(),
        dlqStatus: "replayed",
        retryHistory: deadLetterJob.retryHistory,
        recoveryAttempts: 1,
      },
      update: {
        status: "pending",
        lockedAt: null,
        completedAt: null,
        lastError: null,
        failureReason: null,
        failureCategory: null,
        dlqStatus: "replayed",
        runAt: new Date(),
        recoveryAttempts: { increment: 1 },
      },
    });

    return tx.deadLetterQueueJob.update({
      where: { id: deadLetterJob.id },
      data: {
        status: "replayed",
        recoveredAt: new Date(),
        recoveryAttempts: { increment: 1 },
        recoveryNote: `Replay requested by ${requestedBy}`,
      },
    });
  });

  logFailureAudit("dlq_replay_requested", {
    deadLetterJobId,
    originalJobId: deadLetterJob.originalJobId,
    shop: deadLetterJob.shop,
    type: deadLetterJob.type,
    shopifyOrderId: deadLetterJob.shopifyOrderId,
    requestedBy,
  });

  recordDlqMetric("dlq_replay_attempt", {
    deadLetterJobId,
    originalJobId: deadLetterJob.originalJobId,
    shop: deadLetterJob.shop,
    type: deadLetterJob.type,
    shopifyOrderId: deadLetterJob.shopifyOrderId,
    provider: deadLetterJob.provider,
    requestedBy,
    recoveryAttempts: updated.recoveryAttempts,
  });

  scheduleWorkerForJobType(deadLetterJob.type);
  return updated;
}
