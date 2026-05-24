import prisma from "../db.server.js";

const DEFAULT_MAX_ATTEMPTS = 5;

export async function enqueueOrderProcessingJob({ shop, shopifyOrderId, payload, provider = "zinc" }) {
  const job = await prisma.orderQueueJob.upsert({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "order.create",
        shopifyOrderId,
      },
    },
    create: {
      shop,
      type: "order.create",
      shopifyOrderId,
      provider,
      payload: JSON.stringify(payload || {}),
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    },
    update: {
      status: "pending",
      payload: JSON.stringify(payload || {}),
      lastError: null,
      runAt: new Date(),
    },
  });

  scheduleOrderWorkerRun();
  return job;
}

export async function claimNextOrderJob() {
  const now = new Date();
  const staleLock = new Date(Date.now() - 10 * 60 * 1000);
  const job = await prisma.orderQueueJob.findFirst({
    where: {
      OR: [
        { status: "pending", runAt: { lte: now } },
        { status: "processing", lockedAt: { lt: staleLock } },
      ],
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
  });

  if (!job) return null;

  const claimed = await prisma.orderQueueJob.updateMany({
    where: {
      id: job.id,
      OR: [
        { status: "pending" },
        { status: "processing", lockedAt: { lt: staleLock } },
      ],
    },
    data: {
      status: "processing",
      lockedAt: now,
      attempts: { increment: 1 },
    },
  });

  if (claimed.count !== 1) return null;
  return prisma.orderQueueJob.findUnique({ where: { id: job.id } });
}

export async function completeOrderJob(jobId) {
  await prisma.orderQueueJob.update({
    where: { id: jobId },
    data: {
      status: "complete",
      completedAt: new Date(),
      lockedAt: null,
      lastError: null,
    },
  });
}

export async function failOrderJob(job, error, { retryable = true } = {}) {
  const message = error?.message || String(error);
  const attempts = job.attempts;
  const exhausted = !retryable || attempts >= job.maxAttempts;
  const delayMs = getBackoffDelayMs(attempts);

  await prisma.orderQueueJob.update({
    where: { id: job.id },
    data: {
      status: exhausted ? "failed" : "pending",
      lockedAt: null,
      runAt: exhausted ? job.runAt : new Date(Date.now() + delayMs),
      lastError: message.slice(0, 1000),
    },
  });

  logQueueEvent(exhausted ? "order_job_failed" : "order_job_retry_scheduled", {
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    attempts,
    maxAttempts: job.maxAttempts,
    retryable,
    delayMs: exhausted ? 0 : delayMs,
    error: message,
  });

  if (!exhausted) scheduleOrderWorkerRun(delayMs);
}

export function scheduleOrderWorkerRun(delayMs = 0) {
  const run = () => {
    import("../workers/order-worker.server.js")
      .then(({ runOrderWorkerOnce }) => runOrderWorkerOnce())
      .catch((err) => console.error("Order worker schedule error:", err));
  };

  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    setTimeout(run, 0);
  }
}

function getBackoffDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 2 ** Math.max(attempts - 1, 0) * 60 * 1000);
}

function logQueueEvent(event, details) {
  console.log(JSON.stringify({
    event,
    layer: "order_queue",
    ...details,
  }));
}
