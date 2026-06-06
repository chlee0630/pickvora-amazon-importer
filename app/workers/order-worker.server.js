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
import {
  buildZincCreatePayload,
  buildZincIdempotencyKey,
} from "../services/order-providers/zinc.server.js";
import { classifyFailure } from "../utils/failure-classifier.server.js";
import { normalizeProviderError, logProviderEvent } from "../utils/provider-errors.server.js";
import { maskSensitivePayload } from "../utils/failure-audit-log.server.js";
import { getScalingConfig } from "../utils/scaling-config.server.js";
import { trackWorkerJob } from "../services/monitoring/worker-latency.server.js";
import { recordWorkerHeartbeat } from "../services/monitoring/health-monitor.service.js";
import { recordMonitoringEvent } from "../services/monitoring/monitoring-service.server.js";
import {
  assessOrderFraudRisk,
  getFraudProtectionConfig,
} from "../services/fraud-protection.server.js";

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
  recordWorkerHeartbeat("order_worker").catch((err) =>
    console.error("Order worker heartbeat error:", err?.message || err)
  );

  try {
    const { orderWorkerConcurrency } = getScalingConfig();
    // Safe default is intentionally low; DB row locks still provide idempotency.
    await Promise.all(
      Array.from({ length: orderWorkerConcurrency }, () => drainOrderJobs())
    );
  } finally {
    workerRunning = false;
  }
}

async function drainOrderJobs() {
  let job = await claimNextOrderJob({ types: ["order.create"] });
  while (job) {
    recordWorkerHeartbeat("order_worker", { shop: job.shop }).catch((err) =>
      console.error("Order worker heartbeat error:", err?.message || err)
    );
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
  if (shouldSkipZincOrderSubmission(existingProviderOrder)) {
    if (existingProviderOrder?.providerOrderId) {
      logProviderEvent("duplicate_provider_order_prevented", {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: existingProviderOrder.provider,
        providerOrderId: existingProviderOrder.providerOrderId,
      });
      if (existingProviderOrder.status === "ZINC_DRY_RUN") {
        logWorkerEvent("dry_run_provider_order_skipped", job, {
          providerOrderId: existingProviderOrder.providerOrderId,
        });
        return;
      }
      await enqueueTrackingPollJob({
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: existingProviderOrder.provider,
        delayMs: 0,
      });
      return;
    }

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
    if (providerOrder.status === "ZINC_DRY_RUN") {
      logWorkerEvent("dry_run_provider_order_skipped", providerJob, {
        providerOrderId: providerOrder.providerOrderId,
      });
      return;
    }
    return;
  }

  const session = await getOfflineSession(job.shop);
  const order = await fetchShopifyOrder(job.shop, session.accessToken, job.shopifyOrderId);
  validateOrder(order);
  await runFraudAssessmentForOrder({
    job: providerJob,
    accessToken: session.accessToken,
    shopifyOrderId: order.id || job.shopifyOrderId,
  });

  const orderInput = await buildProviderOrderInput(job.shop, order);
  const idempotencyKey = selected.providerName === "zinc"
    ? buildZincIdempotencyKey(job.shop, job.shopifyOrderId)
    : null;
  if (selected.providerName === "zinc") {
    await persistZincSubmitIntent(providerOrder.id, orderInput, idempotencyKey);
  }

  let result;
  try {
    result = await selected.provider.createOrder(
      selected.providerName === "zinc"
        ? { ...orderInput, idempotencyKey }
        : orderInput
    );
  } catch (err) {
    const normalizedError = normalizeProviderError(err, selected.providerName);
    await recordProviderFailure(selected.providerName, normalizedError);
    await updateProviderFailure(providerOrder.id, normalizedError);
    recordMonitoringEvent("zinc_api_error", {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: selected.providerName,
      code: normalizedError.code,
      retryable: normalizedError.retryable,
      manualReviewRequired: normalizedError.manualReviewRequired,
      failureReason: normalizedError.message,
    }, { persist: true });
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
  const isDryRunResult = isDryRunProviderSubmission(result);
  await prisma.providerOrder.update({
    where: { id: providerOrder.id },
    data: {
      providerOrderId: result.providerOrderId,
      status: selected.providerName === "zinc"
        ? (isDryRunResult ? "ZINC_DRY_RUN" : "ZINC_SUBMITTED")
        : "ORDERED",
      requestPayload: JSON.stringify(maskSensitivePayload(result.requestPayload || {})),
      responsePayload: JSON.stringify(maskSensitivePayload(result.responsePayload || {})),
      processingLockedAt: null,
      lastError: null,
      providerFailureCode: null,
      providerFailureMessage: null,
    },
  });

  logWorkerEvent("provider_order_submitted", providerJob, {
    providerOrderId: result.providerOrderId,
    providerStatus: result.status || "submitted",
    dryRun: Boolean(isDryRunResult),
  });

  if (isDryRunResult) {
    logWorkerEvent("dry_run_tracking_poll_skipped", providerJob, {
      providerOrderId: result.providerOrderId,
    });
    return;
  }

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
      status: getProviderFailureStatus(normalizedError),
      providerFailureCode: normalizedError.code,
      providerFailureMessage: normalizedError.message.slice(0, 1000),
      lastError: buildProviderFailureSummary(normalizedError),
      responsePayload: normalizedError.raw_response
        ? JSON.stringify(maskSensitivePayload(normalizedError.raw_response))
        : null,
      processingLockedAt: null,
      providerLastAttemptAt: new Date(),
    },
  });
}

async function persistZincSubmitIntent(providerOrderId, orderInput, idempotencyKey) {
  const requestPayload = buildZincCreatePayload(orderInput, idempotencyKey);
  await prisma.providerOrder.update({
    where: { id: providerOrderId },
    data: {
      status: "SUBMITTING",
      requestPayload: JSON.stringify(maskSensitivePayload(requestPayload)),
      providerLastAttemptAt: new Date(),
      lastError: null,
    },
  });

  logWorkerEvent("zinc_submit_intent_created", {
    providerOrderId,
    shop: orderInput.shop,
    shopifyOrderId: orderInput.shopifyOrderId,
    idempotencyKey,
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
      const matchedProduct = importedProducts.find((product) => product.shopifyVariantId === line.variant?.id)
        || importedProducts.find((product) => product.shopifyProductId === line.product?.id)
        || importedProducts.find((product) => product.asin === normalizeAsin(line.sku))
        || importedProducts.find((product) => product.asin === normalizeAsin(line.variant?.metafield?.value));
      const asin = normalizeAsin(line.sku)
        || normalizeAsin(line.variant?.metafield?.value)
        || matchedProduct?.asin;
      if (!asin || !matchedProduct) return null;
      return {
        asin,
        quantity: line.quantity,
        shopifyLineItemId: line.id,
        amazonUrl: matchedProduct.amazonUrl || null,
        maxPriceCents: toPriceCents(
          matchedProduct.salePrice ?? matchedProduct.price,
          matchedProduct.shippingPrice
        ),
      };
    })
    .filter(Boolean);
}

function toPriceCents(value, shippingValue = 0) {
  const amount = Number(value);
  const shippingAmount = Number(shippingValue || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isFinite(shippingAmount) || shippingAmount < 0) return null;
  return Math.round((amount + shippingAmount) * 100);
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

export async function runFraudAssessmentForOrder({ job, accessToken, shopifyOrderId }, deps = {}) {
  const getConfig = deps.getFraudProtectionConfig || getFraudProtectionConfig;
  const assessRisk = deps.assessOrderFraudRisk || assessOrderFraudRisk;
  const logEvent = deps.logWorkerEvent || logWorkerEvent;
  const logError = deps.logError || console.error;

  try {
    const config = await getConfig(job.shop);
    if (!config.enabled) {
      logEvent("fraud_assessment_skipped", job, {
        reason: "fraud_protection_disabled",
      });
      return { skipped: true, reason: "fraud_protection_disabled" };
    }

    const result = await assessRisk({
      shop: job.shop,
      accessToken,
      shopifyOrderId,
    });

    logEvent("fraud_assessment_completed", job, {
      riskLevel: result.riskLevel,
      decision: result.decision,
      actionMode: result.actionMode,
    });

    if (result.decision === "WOULD_CANCEL") {
      logEvent("fraud_order_would_cancel_dry_run", job, {
        riskLevel: result.riskLevel,
        actionMode: result.actionMode,
      });
    }

    return { skipped: false, result };
  } catch (err) {
    logError("fraud_assessment_failed_non_blocking:", err?.message || err);
    logEvent("fraud_assessment_failed_non_blocking", job, {
      error: err?.message || String(err),
    });
    return { skipped: true, reason: "assessment_failed" };
  }
}

export function shouldSkipZincOrderSubmission(providerOrder) {
  return Boolean(providerOrder?.providerOrderId || providerOrder?.requestPayload);
}

export function isDryRunProviderSubmission(result) {
  return Boolean(result?.dryRun || result?.status === "dry_run");
}

export function getProviderFailureStatus(normalizedError) {
  if (normalizedError?.manualReviewRequired) return "MANUAL_REVIEW";
  if (normalizedError?.retryable) return "pending";
  return "FAILED";
}

export function buildProviderFailureSummary(normalizedError) {
  const code = normalizedError?.code || "PROVIDER_ERROR";
  const message = normalizedError?.message || "Provider submission failed";
  return `${code}: ${message}`.slice(0, 1000);
}
