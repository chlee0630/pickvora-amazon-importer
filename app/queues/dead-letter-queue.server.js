import prisma from "../db.server.js";
import { logFailureAudit, maskSensitivePayload, parseStoredPayload } from "../utils/failure-audit-log.server.js";

export async function moveJobToDeadLetterQueue(job, failure, client = prisma) {
  const retryHistory = job.retryHistory
    ? parseRetryHistory(job.retryHistory)
    : appendRetryHistory(null, {
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      category: failure.category,
      retryable: failure.retryable,
      reason: failure.reason,
      code: failure.code,
      status: failure.status,
      failedAt: new Date().toISOString(),
    });

  const deadLetterJob = await client.deadLetterQueueJob.upsert({
    where: { originalJobId: job.id },
    create: {
      originalJobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      originalPayload: job.payload,
      retryHistory: JSON.stringify(retryHistory),
      failureCategory: failure.category,
      failureReason: failure.reason,
      status: "open",
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastFailureAt: new Date(),
    },
    update: {
      originalPayload: job.payload,
      retryHistory: JSON.stringify(retryHistory),
      failureCategory: failure.category,
      failureReason: failure.reason,
      status: "open",
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastFailureAt: new Date(),
    },
  });

  logFailureAudit("dlq_inserted", {
    deadLetterJobId: deadLetterJob.id,
    originalJobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    failureCategory: failure.category,
    failureReason: failure.reason,
    payload: maskSensitivePayload(parseStoredPayload(job.payload)),
  });

  return deadLetterJob;
}

export function appendRetryHistory(existingHistory, entry) {
  const history = parseRetryHistory(existingHistory);
  history.push(maskSensitivePayload(entry));
  return history;
}

function parseRetryHistory(existingHistory) {
  if (!existingHistory) return [];
  try {
    const parsed = JSON.parse(existingHistory);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
