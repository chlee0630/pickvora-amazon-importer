import prisma from "../db.server.js";
import {
  claimNextOrderJob,
  completeOrderJob,
  failOrderJob,
  enqueueTrackingPollJob,
} from "../queues/order-queue.server.js";
import { resolveOrderProvider } from "../services/order-providers/index.server.js";
import { recordProviderFailure, recordProviderSuccess } from "../services/order-providers/provider-health.server.js";
import { fetchShopifyOrder } from "../services/shopify-orders.server.js";
import { classifyFailure } from "../utils/failure-classifier.server.js";
import { normalizeProviderError, logProviderEvent } from "../utils/provider-errors.server.js";
import { trackWorkerJob } from "../services/monitoring/worker-latency.server.js";

const JOB_TIMEOUT_MS = 45000;
const ORDER_LOCK_TTL_MS = 10 * 60 * 1000;

let workerRunning = false;

class PermanentOrderError extends Error {}
class ProviderUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.retryable = false;
    this.code = "PROVIDER_UNAVAILABLE";
    this.manualReviewRequired = true;
  }
}

export async function runOrderWorkerOnce() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    let job = await claimNextOrderJob({ types: ["order.create"] });
    while (job) {
      try {
        await trackWorkerJob("order_worker", job, async () => {
          if (job.type !== "order.create") {
            throw new PermanentOrderError(`Unsupported order job type: ${job.type}`);
          }

          await withTimeout(processCreateOrderJob(job), JOB_TIMEOUT_MS);
          await completeOrderJob(job.id);
        }, { timeoutMs: JOB_TIMEOUT_MS });
      } catch (err) {
        logWorkerEvent("order_job_error", job, {
          error: err.message,
          retryable: isRetryableError(err),
        });

        await releaseProviderOrderLock(job, err);
        await failOrderJob(job, err, { retryable: isRetryableError(err) });
      }

      job = await claimNextOrderJob({ types: ["order.create"] });
    }
  } finally {
    workerRunning = false;
  }
}

export function initOrderWorkers() {
  // eslint-disable-next-line no-undef
  const g = globalThis;
  if (g.__orderWorkerInterval) return;

  g.__orderWorkerInterval = setInterval(() => {
    runOrderWorkerOnce().catch((err) => console.error("Order worker interval error:", err));
  }, 60 * 1000);

  runOrderWorkerOnce().catch((err) => console.error("Order worker init error:", err));
}

async function processCreateOrderJob(job) {
  const existingProviderOrder = await findExistingProviderOrder(job);
  if (existingProviderOrder?.providerOrderId) {
    logProviderEvent("duplicate_provider_order_prevented", {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: existingProviderOrder.provider,
      providerOrderId: existingProviderOrder.providerOrderId,
    });
    await enqueueTrackingPollJob({
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: existingProviderOrder.provider,
      delayMs: 0,
    });
    return;
  }
  if (existingProviderOrder?.requestPayload) {
    logProviderEvent("duplicate_provider_order_prevented", {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: existingProviderOrder.provider,
      reason: "existing_provider_request_payload",
    });
    await markProviderManualReview(job, {
      provider: existingProviderOrder.provider,
      code: "EXISTING_PROVIDER_REQUEST",
      message: "Existing provider request found without provider order id",
    });
    throw new ProviderUnavailableError("Existing provider request found without provider order id");
  }

  const selected = await resolveOrderProvider({ preferredProvider: job.provider });
  if (!selected.provider) {
    await markProviderManualReview(job, {
      provider: job.provider,
      code: "NO_PROVIDER_AVAILABLE",
      message: "No enabled order provider is available",
    });
    logProviderEvent("manual_review_fallback", {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      reason: "no_provider_available",
    });
    throw new ProviderUnavailableError("No enabled order provider is available");
  }

  if (selected.failoverAttempted) {
    logProviderEvent("failover_attempted", {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      fromProvider: job.provider,
      toProvider: selected.providerName,
    });
  }

  const providerJob = { ...job, provider: selected.providerName };
  const providerOrder = await acquireProviderOrderLock(providerJob);
  if (!providerOrder) {
    logWorkerEvent("order_processing_lock_busy", providerJob);
    throw retryableError("Order processing lock is held by another worker", "LOCKED");
  }

  if (providerOrder.providerOrderId) {
    logWorkerEvent("provider_order_duplicate_skipped", providerJob, {
      providerOrderId: providerOrder.providerOrderId,
    });
    return;
  }

  const session = await getOfflineSession(job.shop);
  const order = await fetchShopifyOrder(job.shop, session.accessToken, job.shopifyOrderId);
  validateOrder(order);

  const orderInput = await buildProviderOrderInput(job.shop, order);
  let result;
  try {
    result = await selected.provider.createOrder(orderInput);
  } catch (err) {
    const normalizedError = normalizeProviderError(err, selected.providerName);
    await recordProviderFailure(selected.providerName, normalizedError);
    await updateProviderFailure(providerOrder.id, normalizedError);
    logProviderEvent(normalizedError.retryable ? "provider_retryable_failure" : "provider_permanent_failure", {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: selected.providerName,
      code: normalizedError.code,
      retryable: normalizedError.retryable,
      permanent: normalizedError.permanent,
    });
    throw normalizedError;
  }

  if (!result.providerOrderId) {
    throw new Error("Provider did not return an order id");
  }

  await recordProviderSuccess(selected.providerName);
  await prisma.providerOrder.update({
    where: { id: providerOrder.id },
    data: {
      providerOrderId: result.providerOrderId,
      status: selected.providerName === "zinc" ? "ZINC_SUBMITTED" : "ORDERED",
      requestPayload: JSON.stringify(result.requestPayload || {}),
      responsePayload: JSON.stringify(result.responsePayload || {}),
      processingLockedAt: null,
      lastError: null,
      providerFailureCode: null,
      providerFailureMessage: null,
    },
  });

  logWorkerEvent("provider_order_submitted", providerJob, {
    providerOrderId: result.providerOrderId,
    providerStatus: result.status || "submitted",
  });

  await enqueueTrackingPollJob({
    shop: job.shop,
    shopifyOrderId: job.shopifyOrderId,
    provider: selected.providerName,
  });
}

async function acquireProviderOrderLock(job) {
  const now = new Date();
  const staleLock = new Date(Date.now() - ORDER_LOCK_TTL_MS);
  const providerOrder = await prisma.providerOrder.upsert({
    where: {
      shop_shopifyOrderId_provider: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
      },
    },
    create: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      status: "pending",
    },
    update: {},
  });

  if (providerOrder.providerOrderId) return providerOrder;

  const claimed = await prisma.providerOrder.updateMany({
    where: {
      id: providerOrder.id,
      providerOrderId: null,
      OR: [
        { processingLockedAt: null },
        { processingLockedAt: { lt: staleLock } },
        { status: { in: ["pending", "failed"] } },
      ],
    },
    data: {
      status: "processing",
      processingLockedAt: now,
      lastError: null,
      providerAttemptCount: { increment: 1 },
      providerLastAttemptAt: now,
    },
  });

  if (claimed.count !== 1 && providerOrder.processingLockedAt) return null;
  return prisma.providerOrder.findUnique({ where: { id: providerOrder.id } });
}

async function releaseProviderOrderLock(job, error) {
  const message = error?.message || String(error);
  const retryable = isRetryableError(error);
  const provider = error?.provider || job.provider;
  const normalizedError = normalizeProviderError(error, provider);
  await prisma.providerOrder.updateMany({
    where: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider,
      providerOrderId: null,
    },
    data: {
      status: error?.manualReviewRequired ? "MANUAL_REVIEW" : retryable ? "pending" : "FAILED",
      processingLockedAt: null,
      lastError: message.slice(0, 1000),
      providerFailureCode: normalizedError.code,
      providerFailureMessage: normalizedError.message.slice(0, 1000),
    },
  });
}

async function findExistingProviderOrder(job) {
  return prisma.providerOrder.findFirst({
    where: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      OR: [
        { providerOrderId: { not: null } },
        { requestPayload: { not: null } },
      ],
    },
    orderBy: { updatedAt: "desc" },
  });
}

async function markProviderManualReview(job, failure) {
  await prisma.providerOrder.upsert({
    where: {
      shop_shopifyOrderId_provider: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: failure.provider || job.provider,
      },
    },
    create: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: failure.provider || job.provider,
      status: "MANUAL_REVIEW",
      lastError: failure.message,
      providerFailureCode: failure.code,
      providerFailureMessage: failure.message,
      providerAttemptCount: 0,
      providerLastAttemptAt: new Date(),
    },
    update: {
      status: "MANUAL_REVIEW",
      processingLockedAt: null,
      lastError: failure.message,
      providerFailureCode: failure.code,
      providerFailureMessage: failure.message,
      providerLastAttemptAt: new Date(),
    },
  });
}

async function updateProviderFailure(providerOrderId, normalizedError) {
  await prisma.providerOrder.update({
    where: { id: providerOrderId },
    data: {
      providerFailureCode: normalizedError.code,
      providerFailureMessage: normalizedError.message.slice(0, 1000),
      providerLastAttemptAt: new Date(),
    },
  });
}

async function getOfflineSession(shop) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) throw retryableError(`No offline access token found for ${shop}`);
  return session;
}

function validateOrder(order) {
  if (!order) throw new PermanentOrderError("Shopify order not found");
  if (order.cancelledAt) throw new PermanentOrderError("Shopify order is cancelled");
  if (order.displayFulfillmentStatus === "FULFILLED") {
    throw new PermanentOrderError("Shopify order is already fulfilled");
  }
}

async function buildProviderOrderInput(shop, order) {
  const shippingAddress = buildZincAddress(order.shippingAddress);
  if (!shippingAddress) throw new PermanentOrderError("Order shipping address is incomplete");

  const items = await mapOrderItemsToAsins(shop, order);
  if (items.length === 0) {
    throw new PermanentOrderError("No imported Amazon ASIN line items found on order");
  }

  return {
    shop,
    shopifyOrderId: order.id,
    orderName: order.name,
    shippingAddress,
    items,
  };
}

async function mapOrderItemsToAsins(shop, order) {
  const lineItems = order.lineItems?.nodes || [];
  const variantIds = lineItems.map((line) => line.variant?.id).filter(Boolean);
  const productIds = lineItems.map((line) => line.product?.id).filter(Boolean);
  const skuAsins = lineItems.map((line) => normalizeAsin(line.sku)).filter(Boolean);

  const importedProducts = await prisma.amazonProduct.findMany({
    where: {
      OR: [
        { shopifyVariantId: { in: variantIds } },
        { shopifyProductId: { in: productIds } },
        { asin: { in: skuAsins } },
      ],
    },
  });

  return lineItems
    .map((line) => {
      const asin = normalizeAsin(line.sku)
        || normalizeAsin(line.variant?.metafield?.value)
        || importedProducts.find((product) => product.shopifyVariantId === line.variant?.id)?.asin
        || importedProducts.find((product) => product.shopifyProductId === line.product?.id)?.asin;
      if (!asin) return null;
      return {
        asin,
        quantity: line.quantity,
        shopifyLineItemId: line.id,
      };
    })
    .filter(Boolean);
}

function buildZincAddress(address) {
  if (!address?.address1 || !address.city || !address.zip || !address.countryCodeV2) return null;
  return {
    first_name: address.firstName || "Customer",
    last_name: address.lastName || "Order",
    address_line1: address.address1,
    address_line2: address.address2 || undefined,
    city: address.city,
    state: address.provinceCode || "",
    zip_code: address.zip,
    country: address.countryCodeV2,
    phone_number: address.phone || undefined,
  };
}

function normalizeAsin(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(text) ? text : null;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(retryableError("Order job timed out", "TIMEOUT")), timeoutMs);
    }),
  ]);
}

function retryableError(message, code = "RETRYABLE") {
  const error = new Error(message);
  error.retryable = true;
  error.code = code;
  return error;
}

function isRetryableError(error) {
  if (error instanceof PermanentOrderError) return false;
  return classifyFailure(error).retryable;
}

function logWorkerEvent(event, job, details = {}) {
  console.log(JSON.stringify({
    event,
    layer: "order_worker",
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    ...details,
  }));
}
