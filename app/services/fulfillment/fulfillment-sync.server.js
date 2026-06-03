import prisma from "../../db.server.js";
import {
  buildFulfillmentInput,
  createTrackingFulfillment,
  fetchFulfillmentContext,
  hasMatchingFulfillment,
} from "../shopify-fulfillments.server.js";
import { classifyFailure } from "../../utils/failure-classifier.server.js";
import { recordFulfillmentMetric } from "../monitoring/monitoring-service.server.js";

const FULFILLMENT_LOCK_TTL_MS = 10 * 60 * 1000;

class PermanentFulfillmentError extends Error {}

export async function processFulfillmentJob(job) {
  let providerOrder = null;
  try {
    const payload = parseJobPayload(job);
    const tracking = sanitizeTracking(payload);
    validateTracking(tracking);

    providerOrder = await acquireFulfillmentLock(job);
    if (!providerOrder) {
      throw retryableError("Fulfillment lock is held by another worker", "LOCKED");
    }

    validateProviderOrder(providerOrder, tracking);

    const existingLog = await findExistingFulfillmentLog(job, tracking);
    if (existingLog) {
      recordFulfillmentMetric("fulfillment_duplicate_prevented", {
        jobId: job.id,
        shop: job.shop,
        type: job.type,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        source: "local_log",
      });
      logFulfillmentEvent("fulfillment_duplicate_log_skipped", job, {
        trackingNumber: maskTrackingNumber(tracking.trackingNumber),
        carrier: tracking.carrier,
        fulfillmentId: existingLog.shopifyFulfillmentId,
      });
      await markProviderOrderFulfilled(providerOrder.id, existingLog.shopifyFulfillmentId);
      return;
    }

    const session = await getOfflineSession(job.shop);
    const order = await fetchFulfillmentContext(job.shop, session.accessToken, job.shopifyOrderId);
    if (!order) throw new PermanentFulfillmentError("Shopify order not found");

    if (hasMatchingFulfillment(order, tracking)) {
      recordFulfillmentMetric("fulfillment_duplicate_prevented", {
        jobId: job.id,
        shop: job.shop,
        type: job.type,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        source: "shopify",
      });
      await saveFulfillmentLog(job, providerOrder, tracking, {
        status: "duplicate",
        message: "Matching Shopify fulfillment already exists",
      });
      await markProviderOrderFulfilled(providerOrder.id, null);
      logFulfillmentEvent("fulfillment_duplicate_shopify_skipped", job, {
        trackingNumber: maskTrackingNumber(tracking.trackingNumber),
        carrier: tracking.carrier,
      });
      return;
    }

    const fulfillmentInput = buildFulfillmentInput(order, tracking);
    logFulfillmentEvent("fulfillment_request", job, {
      trackingNumber: maskTrackingNumber(tracking.trackingNumber),
      carrier: tracking.carrier,
    });

    const result = await createTrackingFulfillment(job.shop, session.accessToken, fulfillmentInput);
    const fulfillmentId = result.fulfillment?.id || null;

    await saveFulfillmentLog(job, providerOrder, tracking, {
      status: "success",
      shopifyFulfillmentId: fulfillmentId,
      requestPayload: fulfillmentInput,
      responsePayload: result.responsePayload,
      message: "Shopify fulfillment created",
    });

    await markProviderOrderFulfilled(providerOrder.id, fulfillmentId);
    recordFulfillmentMetric("fulfillment_success", {
      jobId: job.id,
      shop: job.shop,
      type: job.type,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      fulfillmentId,
    });

    logFulfillmentEvent("fulfillment_response", job, {
      trackingNumber: maskTrackingNumber(tracking.trackingNumber),
      carrier: tracking.carrier,
      fulfillmentId,
    });
  } catch (error) {
    if (providerOrder && !providerOrder.fulfillmentSyncedAt) {
      await releaseFulfillmentLock(job, error);
    }
    throw error;
  }
}

async function acquireFulfillmentLock(job) {
  const now = new Date();
  const staleLock = new Date(Date.now() - FULFILLMENT_LOCK_TTL_MS);
  const providerOrder = await prisma.providerOrder.findUnique({
    where: {
      shop_shopifyOrderId_provider: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
      },
    },
  });

  if (!providerOrder) return null;
  if (providerOrder.fulfillmentSyncedAt) return providerOrder;

  const claimed = await prisma.providerOrder.updateMany({
    where: {
      id: providerOrder.id,
      trackingReceivedAt: { not: null },
      OR: [
        { processingLockedAt: null },
        { processingLockedAt: { lt: staleLock } },
      ],
    },
    data: {
      status: "PROCESSING",
      processingLockedAt: now,
      lastError: null,
    },
  });

  if (claimed.count !== 1) return null;
  return prisma.providerOrder.findUnique({ where: { id: providerOrder.id } });
}

async function releaseFulfillmentLock(job, error) {
  const message = error?.message || String(error);
  const retryable = isRetryableError(error);
  await prisma.providerOrder.updateMany({
    where: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      fulfillmentSyncedAt: null,
    },
    data: {
      status: retryable ? "TRACKING_RECEIVED" : "MANUAL_REVIEW",
      processingLockedAt: null,
      lastError: message.slice(0, 1000),
    },
  });
}

function validateProviderOrder(providerOrder, tracking) {
  if (!providerOrder.providerOrderId) {
    throw new PermanentFulfillmentError("Provider order id is missing");
  }
  if (!providerOrder.trackingReceivedAt) {
    throw new PermanentFulfillmentError("Tracking has not been received locally");
  }
  if (
    providerOrder.trackingNumber !== tracking.trackingNumber ||
    providerOrder.trackingCarrier !== tracking.carrier
  ) {
    throw new PermanentFulfillmentError("Fulfillment tracking payload does not match local tracking state");
  }
  if (providerOrder.fulfillmentSyncedAt) {
    throw new PermanentFulfillmentError("Fulfillment has already been synced");
  }
}

async function getOfflineSession(shop) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) throw retryableError(`No offline access token found for ${shop}`);
  return session;
}

async function findExistingFulfillmentLog(job, tracking) {
  return prisma.fulfillmentLog.findUnique({
    where: {
      shop_shopifyOrderId_provider_trackingNumber_carrier: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        trackingNumber: tracking.trackingNumber,
        carrier: tracking.carrier,
      },
    },
  });
}

async function saveFulfillmentLog(job, providerOrder, tracking, data) {
  try {
    return await prisma.fulfillmentLog.create({
      data: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        providerOrderId: providerOrder.providerOrderId,
        shopifyFulfillmentId: data.shopifyFulfillmentId || null,
        trackingNumber: tracking.trackingNumber,
        carrier: tracking.carrier,
        trackingUrl: tracking.trackingUrl,
        status: data.status,
        requestPayload: data.requestPayload ? JSON.stringify(maskPayload(data.requestPayload)) : null,
        responsePayload: data.responsePayload ? JSON.stringify(maskPayload(data.responsePayload)) : null,
        message: data.message || null,
      },
    });
  } catch (err) {
    if (err.code === "P2002") return findExistingFulfillmentLog(job, tracking);
    throw err;
  }
}

async function markProviderOrderFulfilled(providerOrderId, fulfillmentId) {
  await prisma.providerOrder.update({
    where: { id: providerOrderId },
    data: {
      status: "FULFILLED",
      fulfillmentSyncedAt: new Date(),
      shopifyFulfillmentId: fulfillmentId,
      processingLockedAt: null,
      lastError: null,
    },
  });
}

function parseJobPayload(job) {
  try {
    if (!job.payload) return {};
    if (typeof job.payload === "object") return job.payload;
    return JSON.parse(job.payload);
  } catch {
    throw new PermanentFulfillmentError("Malformed fulfillment job payload");
  }
}

function sanitizeTracking(payload) {
  return {
    providerOrderId: payload.providerOrderId ? String(payload.providerOrderId).trim() : null,
    trackingNumber: payload.trackingNumber ? String(payload.trackingNumber).trim().toUpperCase() : null,
    carrier: payload.carrier ? String(payload.carrier).trim() : null,
    trackingUrl: payload.trackingUrl ? String(payload.trackingUrl).trim() : null,
  };
}

function validateTracking(tracking) {
  if (!tracking.providerOrderId) throw new PermanentFulfillmentError("Provider order id is missing");
  if (!/^[A-Z0-9][A-Z0-9 -]{5,63}$/.test(tracking.trackingNumber || "")) {
    throw new PermanentFulfillmentError("Invalid tracking number");
  }
  if (!/^[A-Za-z0-9 .&'-]{2,60}$/.test(tracking.carrier || "")) {
    throw new PermanentFulfillmentError("Invalid carrier");
  }
  if (tracking.trackingUrl && !/^https?:\/\//i.test(tracking.trackingUrl)) {
    throw new PermanentFulfillmentError("Invalid tracking URL");
  }
}

function retryableError(message, code = "RETRYABLE") {
  const error = new Error(message);
  error.retryable = true;
  error.code = code;
  return error;
}

function isRetryableError(error) {
  if (error instanceof PermanentFulfillmentError) return false;
  return classifyFailure(error).retryable;
}

function maskPayload(value) {
  if (Array.isArray(value)) return value.map(maskPayload);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (["phone", "phoneNumber", "phone_number", "email"].includes(key)) {
        return [key, "[masked]"];
      }
      return [key, maskPayload(item)];
    })
  );
}

function maskTrackingNumber(value) {
  const text = String(value || "");
  if (text.length <= 4) return "[masked]";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function logFulfillmentEvent(event, job, details = {}) {
  console.log(JSON.stringify({
    event,
    layer: "fulfillment_update_worker",
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    ...details,
  }));
}
