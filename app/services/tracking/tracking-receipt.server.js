import prisma from "../../db.server.js";
import { enqueueFulfillmentUpdateJob } from "../../queues/order-queue.server.js";
import { recordMonitoringEvent } from "../monitoring/monitoring-service.server.js";

export function buildSyntheticZincTrackingResponse({ trackingNumber, carrier, trackingUrl = null, providerOrderId = null }) {
  return {
    _type: "order",
    request_id: providerOrderId || "synthetic_tracking_injection",
    status: "shipped",
    shipments: [
      {
        tracking: {
          tracking_number: trackingNumber,
          tracking_url: trackingUrl || undefined,
          carrier,
        },
      },
    ],
  };
}

export function parseZincTrackingResponse(response) {
  const shipment = response?.shipments?.[0] || response?.shipment || response;
  const tracking = shipment?.tracking || shipment?.tracking_info || shipment;

  return sanitizeTracking({
    status: normalizeStatus(response?.status),
    trackingNumber: tracking?.tracking_number || tracking?.number || response?.tracking_number || null,
    trackingCompany: tracking?.carrier || tracking?.company || response?.carrier || "Amazon",
    trackingUrl: tracking?.tracking_url || tracking?.url || response?.tracking_url || null,
    responsePayload: response || {},
  });
}

export async function processTrackingReceipt({
  job,
  providerOrder,
  tracking,
  providerState,
  enqueueFulfillmentUpdateJobFn = enqueueFulfillmentUpdateJob,
  recordMonitoringEventFn = recordMonitoringEvent,
  updateProviderOrderFn = async (data) => prisma.providerOrder.update({
    where: { id: providerOrder.id },
    data,
  }),
  createTrackingLogFn = async (data) => prisma.trackingLog.create({ data }),
  findExistingTrackingFn = (jobArg, trackingArg) => findExistingTracking(jobArg, trackingArg),
  logTrackingEventFn = logTrackingEvent,
  skipFulfillmentEnqueue = false,
  source = "tracking.poll",
  recordTrackingMonitoringEvent = false,
}) {
  const normalizedTracking = sanitizeTracking(tracking);
  validateTracking(normalizedTracking);

  await updateProviderOrderFn({
    responsePayload: JSON.stringify(normalizedTracking.responsePayload || {}),
    status: providerState || normalizeStatus(normalizedTracking.status),
    processingLockedAt: null,
    lastError: null,
  });

  const existingTracking = await findExistingTrackingFn(job, normalizedTracking);
  if (existingTracking) {
    logTrackingEventFn("tracking_log_duplicate_skipped", job, {
      providerOrderId: providerOrder.providerOrderId,
      trackingNumber: maskTrackingNumber(normalizedTracking.trackingNumber),
      carrier: normalizedTracking.trackingCompany,
    });
    return { duplicate: true, tracking: normalizedTracking };
  }

  await createTrackingLogFn({
    shop: job.shop,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    providerOrderId: providerOrder.providerOrderId,
    trackingNumber: normalizedTracking.trackingNumber,
    carrier: normalizedTracking.trackingCompany,
    trackingUrl: normalizedTracking.trackingUrl,
    status: "TRACKING_RECEIVED",
    payload: JSON.stringify(normalizedTracking.responsePayload || {}),
  });

  await updateProviderOrderFn({
    status: "TRACKING_RECEIVED",
    trackingNumber: normalizedTracking.trackingNumber,
    trackingCarrier: normalizedTracking.trackingCompany,
    trackingUrl: normalizedTracking.trackingUrl,
    trackingReceivedAt: new Date(),
    processingLockedAt: null,
    lastError: null,
  });

  if (!skipFulfillmentEnqueue) {
    await enqueueFulfillmentUpdateJobFn({
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      payload: {
        providerOrderId: providerOrder.providerOrderId,
        trackingNumber: normalizedTracking.trackingNumber,
        carrier: normalizedTracking.trackingCompany,
        trackingUrl: normalizedTracking.trackingUrl,
      },
    });
  }

  logTrackingEventFn("tracking_received", job, {
    providerOrderId: providerOrder.providerOrderId,
    trackingNumber: maskTrackingNumber(normalizedTracking.trackingNumber),
    carrier: normalizedTracking.trackingCompany,
    source,
  });

  if (recordTrackingMonitoringEvent) {
    recordMonitoringEventFn("tracking_received", {
      shop: job.shop,
      type: job.type,
      provider: job.provider,
      shopifyOrderId: job.shopifyOrderId,
      providerOrderId: providerOrder.providerOrderId,
      trackingNumber: maskTrackingNumber(normalizedTracking.trackingNumber),
      carrier: normalizedTracking.trackingCompany,
      source,
    });
  }

  return { duplicate: false, tracking: normalizedTracking };
}

export function sanitizeTracking(tracking) {
  return {
    status: tracking?.status ? String(tracking.status).trim() : null,
    trackingNumber: tracking?.trackingNumber ? String(tracking.trackingNumber).trim().toUpperCase() : null,
    trackingCompany: tracking?.trackingCompany ? String(tracking.trackingCompany).trim() : null,
    trackingUrl: tracking?.trackingUrl ? String(tracking.trackingUrl).trim() : null,
    responsePayload: tracking?.responsePayload || {},
  };
}

export function validateTracking(tracking) {
  if (!/^[A-Z0-9][A-Z0-9 -]{5,63}$/.test(tracking.trackingNumber || "")) {
    throw new Error("Malformed tracking number");
  }
  if (!/^[A-Za-z0-9 .&'-]{2,60}$/.test(tracking.trackingCompany || "")) {
    throw new Error("Invalid tracking carrier");
  }
  if (tracking.trackingUrl && !/^https?:\/\//i.test(tracking.trackingUrl)) {
    throw new Error("Invalid tracking URL");
  }
}

async function findExistingTracking(job, tracking) {
  const existingProviderOrder = await prisma.providerOrder.findFirst({
    where: {
      shop: job.shop,
      shopifyOrderId: job.shopifyOrderId,
      provider: job.provider,
      trackingNumber: tracking.trackingNumber,
      trackingCarrier: tracking.trackingCompany,
    },
  });
  if (existingProviderOrder?.trackingReceivedAt) return existingProviderOrder;

  return prisma.trackingLog.findUnique({
    where: {
      shop_shopifyOrderId_provider_trackingNumber_carrier: {
        shop: job.shop,
        shopifyOrderId: job.shopifyOrderId,
        provider: job.provider,
        trackingNumber: tracking.trackingNumber,
        carrier: tracking.trackingCompany,
      },
    },
  });
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (["delivered", "shipped", "complete", "completed"].includes(status)) return "shipped";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["failed", "error"].includes(status)) return "failed";
  return status || "submitted";
}

function logTrackingEvent(event, job, details = {}) {
  console.log(JSON.stringify({
    event,
    layer: "tracking_receipt",
    jobId: job.id,
    shop: job.shop,
    type: job.type,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    attempts: job.attempts,
    ...details,
  }));
}

function maskTrackingNumber(value) {
  const text = String(value || "");
  if (text.length <= 4) return "[masked]";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}
