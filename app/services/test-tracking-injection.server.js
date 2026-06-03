import prisma from "../db.server.js";
import { processTrackingReceipt, buildSyntheticZincTrackingResponse, parseZincTrackingResponse } from "./tracking/tracking-receipt.server.js";
import { processFulfillmentJob } from "./fulfillment/fulfillment-sync.server.js";
import { recordMonitoringEvent } from "./monitoring/monitoring-service.server.js";
import { canUseTestTrackingInjectionForShop, isProductionRuntime } from "../utils/runtime-flags.server.js";

const BLOCKED_TEST_ORDERS = new Set(["#1005", "1005", "#1006", "1006"]);

export async function injectTestTracking({
  shop,
  orderRef,
  trackingNumber,
  carrier,
  providerOrderId = null,
  trackingUrl = null,
  createdBy = null,
  deps = {},
}) {
  if (!canUseTestTrackingInjectionForShop(shop)) {
    throw new Error("Test tracking injection is disabled.");
  }
  if (isProductionRuntime()) {
    throw new Error("Test tracking injection is blocked in production.");
  }

  const normalizedOrderRef = normalizeOrderRef(orderRef);
  if (!normalizedOrderRef) {
    throw new Error("Shopify order number or shopifyOrderId is required.");
  }
  if (!trackingNumber) {
    throw new Error("Tracking number is required.");
  }
  if (!carrier) {
    throw new Error("Carrier is required.");
  }

  const providerOrder = await resolveProviderOrder({
    shop,
    orderRef: normalizedOrderRef,
    providerOrderId,
    prismaClient: deps.prismaClient || prisma,
  });

  if (providerOrderId && !doesOrderRefMatchProviderOrder(normalizedOrderRef, providerOrder)) {
    throw new Error("orderRef and providerOrderId do not refer to the same order.");
  }

  assertInjectableProviderOrder(providerOrder, normalizedOrderRef, providerOrderId);
  await assertQueueStateAllowed({
    shop,
    shopifyOrderId: providerOrder.shopifyOrderId,
    prismaClient: deps.prismaClient || prisma,
  });

  const syntheticResponse = buildSyntheticZincTrackingResponse({
    trackingNumber,
    carrier,
    trackingUrl,
    providerOrderId: providerOrder.providerOrderId,
  });
  const syntheticTracking = parseZincTrackingResponse(syntheticResponse);
  const trackingJob = syntheticJob(providerOrder, "tracking.poll");
  const fulfillmentPayload = {
    providerOrderId: providerOrder.providerOrderId,
    trackingNumber: syntheticTracking.trackingNumber,
    carrier: syntheticTracking.trackingCompany,
    trackingUrl: syntheticTracking.trackingUrl,
  };
  const fulfillmentJob = syntheticJob(providerOrder, "fulfillment.update", {
    payload: JSON.stringify(fulfillmentPayload),
  });

  const processTrackingReceiptFn = deps.processTrackingReceiptFn || processTrackingReceipt;
  const processFulfillmentJobFn = deps.processFulfillmentJobFn || processFulfillmentJob;

  await processTrackingReceiptFn({
    job: trackingJob,
    providerOrder,
    tracking: syntheticTracking,
    providerState: "ORDERED",
    skipFulfillmentEnqueue: true,
    source: "test_tracking_injection",
    recordMonitoringEventFn: deps.recordMonitoringEventFn || recordMonitoringEvent,
  });

  await processFulfillmentJobFn(fulfillmentJob);

  await (deps.recordMonitoringEventFn || recordMonitoringEvent)("test_tracking_injected", {
    shop,
    shopifyOrderId: providerOrder.shopifyOrderId,
    provider: providerOrder.provider,
    providerOrderId: providerOrder.providerOrderId,
    trackingNumber: maskTrackingNumber(trackingNumber),
    carrier,
    createdBy,
  }, { persist: true });

  const finalProviderOrder = await (deps.prismaClient || prisma).providerOrder.findUnique({
    where: { id: providerOrder.id },
  });

  return {
    success: true,
    message: "Test tracking injected successfully. Tracking received and fulfillment synced.",
    order: summarizeOrder(finalProviderOrder),
  };
}

async function resolveProviderOrder({ shop, orderRef, providerOrderId, prismaClient }) {
  if (providerOrderId) {
    const byProviderOrderId = await prismaClient.providerOrder.findFirst({
      where: {
        shop,
        provider: "zinc",
        providerOrderId,
      },
    });
    if (byProviderOrderId) return byProviderOrderId;
  }

  if (/^gid:\/\/shopify\/Order\/\d+$/i.test(orderRef)) {
    const byShopifyOrderId = await prismaClient.providerOrder.findFirst({
      where: {
        shop,
        provider: "zinc",
        shopifyOrderId: orderRef,
      },
    });
    if (byShopifyOrderId) return byShopifyOrderId;
  }

  const byRequestPayload = await prismaClient.providerOrder.findFirst({
    where: {
      shop,
      provider: "zinc",
      OR: buildProviderOrderSearchClauses(orderRef, providerOrderId),
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!byRequestPayload) {
    throw new Error("Provider order not found for the specified order.");
  }

  return byRequestPayload;
}

function assertInjectableProviderOrder(providerOrder, orderRef, providerOrderId) {
  if (!providerOrder) {
    throw new Error("Provider order not found.");
  }
  if (providerOrder.provider !== "zinc") {
    throw new Error("Test tracking injection is only available for Zinc provider orders.");
  }
  if (!providerOrder.providerOrderId) {
    throw new Error("Provider order id is missing on the selected order.");
  }
  if (BLOCKED_TEST_ORDERS.has(orderRef) || BLOCKED_TEST_ORDERS.has(providerOrderId || "") || isBlockedProviderOrder(providerOrder)) {
    throw new Error("This order is explicitly blocked from test tracking injection.");
  }
  if (!["ZINC_SUBMITTED", "ORDERED"].includes(providerOrder.status)) {
    throw new Error("Order is not in an injectable tracking state.");
  }
  if (providerOrder.status === "MANUAL_REVIEW" || providerOrder.status === "FAILED") {
    throw new Error("Order is not eligible for test tracking injection.");
  }
  if (providerOrder.trackingNumber || providerOrder.trackingCarrier || providerOrder.trackingReceivedAt) {
    throw new Error("Order already has tracking data.");
  }
  if (providerOrder.fulfillmentSyncedAt || providerOrder.shopifyFulfillmentId) {
    throw new Error("Order already has fulfillment synced.");
  }
}

async function assertQueueStateAllowed({ shop, shopifyOrderId, prismaClient }) {
  const [queueJobs, dlqJobs] = await Promise.all([
    prismaClient.orderQueueJob.findMany({
      where: {
        shop,
        shopifyOrderId,
        OR: [
          { type: "order.create" },
          { type: "tracking.poll" },
          { type: "fulfillment.update" },
        ],
      },
      select: {
        status: true,
        dlqStatus: true,
      },
    }),
    prismaClient.deadLetterQueueJob.findMany({
      where: {
        shop,
        shopifyOrderId,
        status: "open",
      },
      select: { id: true },
    }),
  ]);

  if (dlqJobs.length > 0) {
    throw new Error("Order is in an open DLQ state and cannot be used for test tracking injection.");
  }

  if (queueJobs.some((job) => job.status === "failed" || job.dlqStatus === "open")) {
    throw new Error("Order has a failed or open DLQ queue job and cannot be used for test tracking injection.");
  }
}

function normalizeOrderRef(orderRef) {
  const text = String(orderRef || "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) return `#${text}`;
  return text;
}

function buildProviderOrderSearchClauses(orderRef, providerOrderId) {
  const clauses = [{ shopifyOrderId: orderRef }, { requestPayload: { contains: orderRef } }];
  if (providerOrderId) clauses.push({ providerOrderId });
  return clauses;
}

function isBlockedProviderOrder(providerOrder) {
  const orderName = extractOrderName(providerOrder.requestPayload);
  return BLOCKED_TEST_ORDERS.has(orderName);
}

function doesOrderRefMatchProviderOrder(orderRef, providerOrder) {
  const orderName = extractOrderName(providerOrder.requestPayload);
  const normalizedOrderRef = normalizeOrderRef(orderRef);
  const orderNameDigits = orderName.replace(/^#/, "");
  const orderRefDigits = normalizedOrderRef.replace(/^#/, "");

  return normalizedOrderRef === providerOrder.shopifyOrderId ||
    normalizedOrderRef === orderName ||
    orderRefDigits === orderNameDigits ||
    normalizedOrderRef === providerOrder.providerOrderId;
}

function extractOrderName(payload) {
  if (!payload) return "";
  try {
    const parsed = JSON.parse(payload);
    return String(parsed.orderName || parsed.name || "").trim();
  } catch {
    return "";
  }
}

function syntheticJob(providerOrder, type, extra = {}) {
  return {
    id: `test-${type}-${providerOrder.id}`,
    shop: providerOrder.shop,
    type,
    shopifyOrderId: providerOrder.shopifyOrderId,
    provider: providerOrder.provider,
    attempts: 0,
    maxAttempts: 1,
    payload: JSON.stringify(extra.payload || {}),
    ...extra,
  };
}

function summarizeOrder(providerOrder) {
  if (!providerOrder) return null;
  return {
    id: providerOrder.id,
    shopifyOrderId: providerOrder.shopifyOrderId,
    providerOrderId: providerOrder.providerOrderId,
    status: providerOrder.status,
    trackingNumber: providerOrder.trackingNumber,
    trackingCarrier: providerOrder.trackingCarrier,
    trackingReceivedAt: providerOrder.trackingReceivedAt,
    fulfillmentSyncedAt: providerOrder.fulfillmentSyncedAt,
    shopifyFulfillmentId: providerOrder.shopifyFulfillmentId,
  };
}

function maskTrackingNumber(value) {
  const text = String(value || "");
  if (text.length <= 4) return "[masked]";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}
