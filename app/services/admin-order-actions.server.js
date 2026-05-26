import prisma from "../db.server.js";
import {
  enqueueFulfillmentUpdateJob,
  enqueueOrderProcessingJob,
  enqueueTrackingPollJob,
} from "../queues/order-queue.server.js";
import { maskSensitivePayload } from "../utils/failure-audit-log.server.js";

const ADMIN_ACTIONS = {
  RETRY_ZINC: "retry_zinc_order",
  RETRY_TRACKING: "retry_tracking",
  RETRY_FULFILLMENT: "retry_fulfillment",
  MOVE_MANUAL_REVIEW: "move_manual_review",
  RESOLVE_MANUAL_REVIEW: "resolve_manual_review",
  ADD_NOTE: "add_note",
};

export async function runAdminOrderAction({ shop, orderId, actionType, note, createdBy }) {
  const providerOrder = await loadProviderOrder(shop, orderId);
  const previousStatus = currentStatus(providerOrder);

  if (actionType === ADMIN_ACTIONS.RETRY_ZINC) {
    await validateRetryZinc(providerOrder);
    const job = await enqueueOrderProcessingJob({
      shop,
      shopifyOrderId: providerOrder.shopifyOrderId,
      provider: providerOrder.provider,
      payload: { adminRetry: true, requestedAt: new Date().toISOString() },
    });
    await auditAction({ shop, providerOrder, actionType, previousStatus, newStatus: "pending", note, createdBy, payload: { jobId: job.id } });
    return { success: true, message: "Zinc order retry queued." };
  }

  if (actionType === ADMIN_ACTIONS.RETRY_TRACKING) {
    await validateRetryTracking(providerOrder);
    const job = await enqueueTrackingPollJob({
      shop,
      shopifyOrderId: providerOrder.shopifyOrderId,
      provider: providerOrder.provider,
      delayMs: 0,
    });
    await auditAction({ shop, providerOrder, actionType, previousStatus, newStatus: "pending", note, createdBy, payload: { jobId: job.id } });
    return { success: true, message: "Tracking retry queued." };
  }

  if (actionType === ADMIN_ACTIONS.RETRY_FULFILLMENT) {
    await validateRetryFulfillment(providerOrder);
    const job = await enqueueFulfillmentUpdateJob({
      shop,
      shopifyOrderId: providerOrder.shopifyOrderId,
      provider: providerOrder.provider,
      payload: {
        providerOrderId: providerOrder.providerOrderId,
        trackingNumber: providerOrder.trackingNumber,
        carrier: providerOrder.trackingCarrier,
        trackingUrl: providerOrder.trackingUrl,
        adminRetry: true,
      },
    });
    await auditAction({ shop, providerOrder, actionType, previousStatus, newStatus: "pending", note, createdBy, payload: { jobId: job.id } });
    return { success: true, message: "Fulfillment retry queued." };
  }

  if (actionType === ADMIN_ACTIONS.MOVE_MANUAL_REVIEW) {
    await ensureNoProcessingLock(providerOrder);
    const updated = await prisma.providerOrder.update({
      where: { id: providerOrder.id },
      data: { status: "MANUAL_REVIEW", processingLockedAt: null },
    });
    await auditAction({ shop, providerOrder, actionType, previousStatus, newStatus: updated.status, note, createdBy });
    return { success: true, message: "Order moved to manual review." };
  }

  if (actionType === ADMIN_ACTIONS.RESOLVE_MANUAL_REVIEW) {
    await validateResolveManualReview(providerOrder);
    const nextStatus = safeResolvedStatus(providerOrder);
    const updated = await prisma.providerOrder.update({
      where: { id: providerOrder.id },
      data: { status: nextStatus, lastError: null },
    });
    await auditAction({ shop, providerOrder, actionType, previousStatus, newStatus: updated.status, note, createdBy });
    return { success: true, message: "Manual review marked resolved." };
  }

  if (actionType === ADMIN_ACTIONS.ADD_NOTE) {
    if (!note) throw new Error("Admin note is required.");
    await auditAction({ shop, providerOrder, actionType, previousStatus, newStatus: previousStatus, note, createdBy });
    return { success: true, message: "Admin note saved." };
  }

  throw new Error("Unsupported admin action.");
}

export function getAllowedAdminActions(order) {
  return {
    retryZinc: canRetryZinc(order),
    retryTracking: canRetryTracking(order),
    retryFulfillment: canRetryFulfillment(order),
    moveManualReview: !order.processingLockedAt,
    resolveManualReview: canResolveManualReview(order),
    addNote: true,
  };
}

async function loadProviderOrder(shop, orderId) {
  if (!orderId || typeof orderId !== "string" || orderId.length > 128) {
    throw new Error("Invalid order id.");
  }

  const providerOrder = await prisma.providerOrder.findFirst({
    where: {
      shop,
      OR: [{ id: orderId }, { shopifyOrderId: orderId }],
    },
  });

  if (!providerOrder) throw new Error("Order not found.");
  return providerOrder;
}

async function validateRetryZinc(order) {
  if (!canRetryZinc(order)) {
    throw new Error("Zinc retry is not allowed for the current order state.");
  }
  await ensureNoProcessingLock(order);
  await ensureNoActiveJob(order, "order.create");
}

async function validateRetryTracking(order) {
  if (!canRetryTracking(order)) {
    throw new Error("Tracking retry is not allowed for the current order state.");
  }
  await ensureNoProcessingLock(order);
  await ensureNoActiveJob(order, "tracking.poll");
}

async function validateRetryFulfillment(order) {
  if (!canRetryFulfillment(order)) {
    throw new Error("Fulfillment retry is not allowed for the current order state.");
  }
  await ensureNoProcessingLock(order);
  await ensureNoActiveJob(order, "fulfillment.update");

  const existingFulfillment = await prisma.fulfillmentLog.findUnique({
    where: {
      shop_shopifyOrderId_provider_trackingNumber_carrier: {
        shop: order.shop,
        shopifyOrderId: order.shopifyOrderId,
        provider: order.provider,
        trackingNumber: order.trackingNumber,
        carrier: order.trackingCarrier,
      },
    },
  });
  if (existingFulfillment) {
    throw new Error("Fulfillment retry is blocked because a matching fulfillment log already exists.");
  }
}

async function validateResolveManualReview(order) {
  if (!canResolveManualReview(order)) {
    throw new Error("Manual review cannot be resolved safely for the current order state.");
  }
  await ensureNoProcessingLock(order);
}

function canRetryZinc(order) {
  return ["FAILED", "MANUAL_REVIEW", "failed"].includes(currentStatus(order)) &&
    !order.providerOrderId &&
    !order.requestPayload &&
    !order.processingLockedAt;
}

function canRetryTracking(order) {
  return ["ORDERED", "ZINC_SUBMITTED"].includes(currentStatus(order)) &&
    Boolean(order.providerOrderId) &&
    !order.trackingReceivedAt &&
    !order.processingLockedAt;
}

function canRetryFulfillment(order) {
  return ["TRACKING_RECEIVED", "FAILED"].includes(currentStatus(order)) &&
    Boolean(order.providerOrderId) &&
    Boolean(order.trackingReceivedAt) &&
    Boolean(order.trackingNumber) &&
    Boolean(order.trackingCarrier) &&
    !order.fulfillmentSyncedAt &&
    !order.processingLockedAt;
}

function canResolveManualReview(order) {
  return currentStatus(order) === "MANUAL_REVIEW" && !order.processingLockedAt && safeResolvedStatus(order) !== "MANUAL_REVIEW";
}

async function ensureNoProcessingLock(order) {
  if (order.processingLockedAt) {
    throw new Error("Order has an active processing lock.");
  }
}

async function ensureNoActiveJob(order, type) {
  const existingJob = await prisma.orderQueueJob.findUnique({
    where: {
      shop_type_shopifyOrderId: {
        shop: order.shop,
        type,
        shopifyOrderId: order.shopifyOrderId,
      },
    },
  });

  if (existingJob && ["pending", "processing"].includes(existingJob.status)) {
    throw new Error("A retry job is already queued or processing for this order.");
  }
}

async function auditAction({ shop, providerOrder, actionType, previousStatus, newStatus, note, createdBy, payload = {} }) {
  const maskedPayload = maskSensitivePayload(payload);
  await prisma.adminOrderAction.create({
    data: {
      shop,
      orderId: providerOrder.id,
      shopifyOrderId: providerOrder.shopifyOrderId,
      actionType,
      previousStatus,
      newStatus,
      adminNote: note || null,
      actionPayload: JSON.stringify(maskedPayload),
      createdBy: createdBy || null,
    },
  });

  console.log(JSON.stringify(maskSensitivePayload({
    event: "admin_order_action",
    layer: "operations_dashboard",
    shop,
    orderId: providerOrder.id,
    shopifyOrderId: providerOrder.shopifyOrderId,
    actionType,
    previousStatus,
    newStatus,
    createdBy,
  })));
}

function safeResolvedStatus(order) {
  if (order.fulfillmentSyncedAt) return "FULFILLED";
  if (order.trackingReceivedAt && order.trackingNumber && order.trackingCarrier) return "TRACKING_RECEIVED";
  if (order.providerOrderId) return "ORDERED";
  return "pending";
}

function currentStatus(order) {
  return order?.status || "unknown";
}
