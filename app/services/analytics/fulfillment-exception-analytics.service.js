import prisma from "../../db.server.js";
import { readNumberEnv } from "../../utils/scaling-config.server.js";
import { redactDashboardText } from "../../utils/dashboard-filters.server.js";
import { parseMetricPayload } from "./analytics-utils.server.js";

export const FULFILLMENT_EXCEPTION_TYPES = {
  INVALID_TRACKING: "INVALID_TRACKING",
  DUPLICATE_FULFILLMENT_SKIPPED: "DUPLICATE_FULFILLMENT_SKIPPED",
  SHOPIFY_FULFILLMENT_API_FAILED: "SHOPIFY_FULFILLMENT_API_FAILED",
  TRACKING_RECEIVED_NOT_FULFILLED: "TRACKING_RECEIVED_NOT_FULFILLED",
  FULFILLMENT_UPDATE_DELAYED: "FULFILLMENT_UPDATE_DELAYED",
  CARRIER_MISSING: "CARRIER_MISSING",
  TRACKING_COMPANY_UNKNOWN: "TRACKING_COMPANY_UNKNOWN",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
  RETRY_EXHAUSTED: "RETRY_EXHAUSTED",
  PARTIAL_SHIPMENT_PENDING: "PARTIAL_SHIPMENT_PENDING",
};

const UNKNOWN_CARRIERS = new Set(["unknown", "other", "n/a", "na", "none", "null"]);
const MAX_ANALYTICS_ROWS = 1000;

export async function getFulfillmentExceptionSummary(filters = {}) {
  const [
    failureReasons,
    invalidTracking,
    duplicatePrevention,
    apiFailureTrend,
    pendingTracking,
    delayedFulfillment,
    carrierIssues,
    manualReview,
  ] = await Promise.all([
    getFulfillmentFailureReasons(filters),
    getInvalidTrackingStats(filters),
    getDuplicateFulfillmentPreventionStats(filters),
    getShopifyFulfillmentApiFailureTrend(filters),
    getPendingTrackingFulfillmentExceptions(filters),
    getDelayedFulfillmentStats(filters),
    getCarrierIssueSummary(filters),
    getManualReviewFulfillmentSummary(filters),
  ]);

  const shopifyApiFailureCount = apiFailureTrend.reduce((total, item) => total + item.failureCount, 0);
  const totalExceptions =
    invalidTracking.count +
    duplicatePrevention.count +
    shopifyApiFailureCount +
    pendingTracking.count +
    delayedFulfillment.count +
    carrierIssues.total +
    manualReview.count;

  return {
    totalExceptions,
    invalidTrackingCount: invalidTracking.count,
    duplicateFulfillmentPreventionCount: duplicatePrevention.count,
    shopifyFulfillmentApiFailureCount: shopifyApiFailureCount,
    trackingReceivedNotFulfilledCount: pendingTracking.count,
    delayedFulfillmentCount: delayedFulfillment.count,
    carrierIssueCount: carrierIssues.total,
    manualReviewFulfillmentCount: manualReview.count,
    failureReasons,
    invalidTracking,
    duplicatePrevention,
    apiFailureTrend,
    pendingTracking,
    delayedFulfillment,
    carrierIssues,
    manualReview,
  };
}

export async function getFulfillmentFailureReasons(filters = {}) {
  const normalized = normalizeFilters(filters);
  const [events, logs, queueJobs, dlqJobs] = await Promise.all([
    prisma.monitoringEvent.findMany({
      where: {
        ...shopWhere(normalized),
        eventType: "fulfillment_failure",
        ...dateWhere(normalized, "createdAt"),
      },
      select: { payload: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.fulfillmentLog.findMany({
      where: {
        ...shopWhere(normalized),
        status: { not: "success" },
        ...dateWhere(normalized, "createdAt"),
      },
      select: { status: true, message: true, responsePayload: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.orderQueueJob.findMany({
      where: {
        ...shopWhere(normalized),
        type: "fulfillment.update",
        status: "failed",
        ...dateWhere(normalized, "updatedAt"),
      },
      select: { failureReason: true, lastError: true, failureCategory: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.deadLetterQueueJob.findMany({
      where: {
        ...shopWhere(normalized),
        type: "fulfillment.update",
        ...dateWhere(normalized, "lastFailureAt"),
      },
      select: { failureReason: true, failureCategory: true, lastFailureAt: true },
      orderBy: { lastFailureAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
  ]);

  const reasons = [
    ...events.map((event) => reasonFromPayload(event.payload)),
    ...logs.map((log) => log.message || responseErrorMessage(log.responsePayload) || log.status),
    ...queueJobs.map((job) => job.failureReason || job.lastError || job.failureCategory),
    ...dlqJobs.map((job) => job.failureReason || job.failureCategory),
  ].filter(Boolean);

  return countBy(reasons.map(normalizeReason)).map(([reason, count]) => ({ reason, count }));
}

export async function getInvalidTrackingStats(filters = {}) {
  const normalized = normalizeFilters(filters);
  const [events, providerOrders] = await Promise.all([
    prisma.monitoringEvent.findMany({
      where: {
        ...shopWhere(normalized),
        eventType: "fulfillment_failure",
        ...dateWhere(normalized, "createdAt"),
      },
      select: { payload: true },
      orderBy: { createdAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.providerOrder.findMany({
      where: {
        ...shopWhere(normalized),
        status: { in: ["TRACKING_RECEIVED", "MANUAL_REVIEW", "FAILED"] },
        ...dateWhere(normalized, "updatedAt"),
      },
      select: { trackingNumber: true, trackingCarrier: true, lastError: true, providerFailureMessage: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
  ]);

  const loggedInvalid = events.filter((event) => isInvalidTrackingMessage(reasonFromPayload(event.payload))).length;
  const malformedStored = providerOrders.filter((order) =>
    isMalformedTracking(order.trackingNumber) ||
    isInvalidTrackingMessage(order.lastError || order.providerFailureMessage)
  ).length;

  return { count: loggedInvalid + malformedStored };
}

export async function getDuplicateFulfillmentPreventionStats(filters = {}) {
  const normalized = normalizeFilters(filters);
  const [events, duplicateLogs] = await Promise.all([
    prisma.monitoringEvent.count({
      where: {
        ...shopWhere(normalized),
        eventType: "fulfillment_duplicate_prevented",
        ...dateWhere(normalized, "createdAt"),
      },
    }),
    prisma.fulfillmentLog.count({
      where: {
        ...shopWhere(normalized),
        status: "duplicate",
        ...dateWhere(normalized, "createdAt"),
      },
    }),
  ]);

  return { count: events + duplicateLogs };
}

export async function getShopifyFulfillmentApiFailureTrend(filters = {}) {
  const normalized = normalizeFilters(filters);
  const events = await prisma.monitoringEvent.findMany({
    where: {
      ...shopWhere(normalized),
      eventType: { in: ["api_failure", "api_timeout", "fulfillment_failure"] },
      ...dateWhere(normalized, "createdAt"),
      OR: [
        { provider: "shopify" },
        { eventType: "fulfillment_failure" },
      ],
    },
    select: { eventType: true, payload: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_ANALYTICS_ROWS,
  });

  const rows = events
    .filter((event) => isFulfillmentApiFailure(event))
    .map((event) => ({
      bucket: event.createdAt.toISOString().slice(0, 10),
      statusGroup: statusGroupFromPayload(event.payload, event.eventType),
    }));

  return Array.from(groupBy(rows, (row) => `${row.bucket}:${row.statusGroup}`).entries())
    .map(([key, items]) => {
      const [bucket, statusGroup] = key.split(":");
      return { bucket, statusGroup, failureCount: items.length };
    })
    .sort((a, b) => b.bucket.localeCompare(a.bucket));
}

export async function getPendingTrackingFulfillmentExceptions(filters = {}) {
  const normalized = normalizeFilters(filters);
  const threshold = trackingFulfillmentThresholdDate();
  const count = await prisma.providerOrder.count({
    where: {
      ...shopWhere(normalized),
      status: "TRACKING_RECEIVED",
      trackingNumber: { not: null },
      ...dateWhereWith(normalized, "trackingReceivedAt", { lt: threshold }),
      fulfillmentSyncedAt: null,
    },
  });

  return { count, thresholdMinutes: delayedFulfillmentThresholdMinutes() };
}

export async function getDelayedFulfillmentStats(filters = {}) {
  const normalized = normalizeFilters(filters);
  const threshold = trackingFulfillmentThresholdDate();
  const [providerOrders, queueJobs] = await Promise.all([
    prisma.providerOrder.count({
      where: {
        ...shopWhere(normalized),
        status: { in: ["TRACKING_RECEIVED", "PROCESSING"] },
        trackingReceivedAt: { lt: threshold },
        fulfillmentSyncedAt: null,
        ...dateWhere(normalized, "updatedAt"),
      },
    }),
    prisma.orderQueueJob.count({
      where: {
        ...shopWhere(normalized),
        type: "fulfillment.update",
        status: { in: ["pending", "processing", "failed"] },
        runAt: { lt: threshold },
        ...dateWhere(normalized, "updatedAt"),
      },
    }),
  ]);

  return { count: providerOrders + queueJobs, providerOrders, queueJobs, thresholdMinutes: delayedFulfillmentThresholdMinutes() };
}

export async function getCarrierIssueSummary(filters = {}) {
  const normalized = normalizeFilters(filters);
  const orders = await prisma.providerOrder.findMany({
    where: {
      ...shopWhere(normalized),
      ...dateWhereWith(normalized, "trackingReceivedAt", { not: null }),
    },
    select: { trackingCarrier: true },
    orderBy: { trackingReceivedAt: "desc" },
    take: MAX_ANALYTICS_ROWS,
  });
  const missingCarrierCount = orders.filter((order) => !order.trackingCarrier).length;
  const unknownCarrierCount = orders.filter((order) =>
    order.trackingCarrier && UNKNOWN_CARRIERS.has(String(order.trackingCarrier).trim().toLowerCase())
  ).length;

  return {
    total: missingCarrierCount + unknownCarrierCount,
    missingCarrierCount,
    unknownCarrierCount,
  };
}

export async function getManualReviewFulfillmentSummary(filters = {}) {
  const normalized = normalizeFilters(filters);
  const [providerOrders, queueJobs] = await Promise.all([
    prisma.providerOrder.count({
      where: {
        ...shopWhere(normalized),
        status: "MANUAL_REVIEW",
        OR: [
          { trackingNumber: { not: null } },
          { trackingReceivedAt: { not: null } },
          { lastError: { contains: "fulfillment" } },
          { lastError: { contains: "tracking" } },
          { providerFailureMessage: { contains: "fulfillment" } },
          { providerFailureMessage: { contains: "tracking" } },
        ],
        ...dateWhere(normalized, "updatedAt"),
      },
    }),
    prisma.orderQueueJob.count({
      where: {
        ...shopWhere(normalized),
        type: "fulfillment.update",
        status: "failed",
        ...dateWhere(normalized, "updatedAt"),
      },
    }),
  ]);

  return { count: providerOrders + queueJobs, providerOrders, queueJobs };
}

export async function getFulfillmentExceptionDetails(filters = {}, pagination = {}) {
  const normalized = normalizeFilters({ ...filters, ...pagination });
  const [events, providerOrders, queueJobs, dlqJobs] = await Promise.all([
    prisma.monitoringEvent.findMany({
      where: {
        ...shopWhere(normalized),
        eventType: { in: ["fulfillment_failure", "fulfillment_duplicate_prevented", "api_failure", "api_timeout"] },
        ...dateWhere(normalized, "createdAt"),
      },
      select: {
        id: true,
        eventType: true,
        severity: true,
        shopifyOrderId: true,
        provider: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.providerOrder.findMany({
      where: {
        ...shopWhere(normalized),
        OR: [
          { status: { in: ["TRACKING_RECEIVED", "MANUAL_REVIEW", "FAILED"] } },
          { trackingReceivedAt: { not: null }, fulfillmentSyncedAt: null },
        ],
        ...dateWhere(normalized, "updatedAt"),
      },
      select: {
        id: true,
        shopifyOrderId: true,
        provider: true,
        status: true,
        trackingNumber: true,
        trackingCarrier: true,
        trackingReceivedAt: true,
        fulfillmentSyncedAt: true,
        lastError: true,
        providerFailureMessage: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.orderQueueJob.findMany({
      where: {
        ...shopWhere(normalized),
        type: "fulfillment.update",
        status: { in: ["pending", "processing", "failed"] },
        ...dateWhere(normalized, "updatedAt"),
      },
      select: {
        id: true,
        shopifyOrderId: true,
        provider: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        failureReason: true,
        lastError: true,
        runAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
    prisma.deadLetterQueueJob.findMany({
      where: {
        ...shopWhere(normalized),
        type: "fulfillment.update",
        ...dateWhere(normalized, "lastFailureAt"),
      },
      select: {
        id: true,
        shopifyOrderId: true,
        provider: true,
        status: true,
        failureReason: true,
        attempts: true,
        maxAttempts: true,
        lastFailureAt: true,
      },
      orderBy: { lastFailureAt: "desc" },
      take: MAX_ANALYTICS_ROWS,
    }),
  ]);

  const details = [
    ...events.map(detailFromMonitoringEvent).filter(Boolean),
    ...providerOrders.map(detailFromProviderOrder).filter(Boolean),
    ...queueJobs.map(detailFromQueueJob).filter(Boolean),
    ...dlqJobs.map(detailFromDlqJob),
  ].filter((item) => matchesDetailFilters(item, normalized))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    rows: details.slice(normalized.skip, normalized.skip + normalized.limit),
    total: details.length,
    page: normalized.page,
    limit: normalized.limit,
  };
}

export function parseFulfillmentExceptionRequest(request, defaults = {}) {
  const url = new URL(request.url);
  return normalizeFilters({
    ...defaults,
    dateFrom: url.searchParams.get("dateFrom") || url.searchParams.get("from"),
    dateTo: url.searchParams.get("dateTo") || url.searchParams.get("to"),
    status: url.searchParams.get("status"),
    exceptionType: url.searchParams.get("exceptionType"),
    severity: url.searchParams.get("severity"),
    page: url.searchParams.get("page"),
    limit: url.searchParams.get("limit") || url.searchParams.get("pageSize"),
  });
}

function normalizeFilters(filters = {}) {
  const page = positiveInteger(filters.page, 1);
  const limit = Math.min(positiveInteger(filters.limit || filters.pageSize, 25), 50);
  return {
    shop: filters.shop || null,
    dateFrom: parseDate(filters.dateFrom || filters.from),
    dateTo: parseDate(filters.dateTo || filters.to),
    status: filters.status || "",
    exceptionType: Object.values(FULFILLMENT_EXCEPTION_TYPES).includes(filters.exceptionType) ? filters.exceptionType : "",
    severity: ["info", "warning", "error", "critical"].includes(filters.severity) ? filters.severity : "",
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function detailFromMonitoringEvent(event) {
  if (event.provider === "shopify" && !isFulfillmentApiFailure(event)) return null;
  const message = reasonFromPayload(event.payload);
  const exceptionType = event.eventType === "fulfillment_duplicate_prevented"
    ? FULFILLMENT_EXCEPTION_TYPES.DUPLICATE_FULFILLMENT_SKIPPED
    : event.provider === "shopify"
      ? FULFILLMENT_EXCEPTION_TYPES.SHOPIFY_FULFILLMENT_API_FAILED
      : classifyExceptionType(message, event.eventType);

  return {
    id: `monitoring:${event.id}`,
    source: "monitoring",
    exceptionType,
    severity: event.severity || severityForException(exceptionType),
    status: event.eventType,
    shopifyOrderId: event.shopifyOrderId,
    provider: event.provider,
    message: redactDashboardText(message || event.eventType),
    createdAt: event.createdAt,
  };
}

function detailFromProviderOrder(order) {
  const delayed = order.trackingReceivedAt &&
    !order.fulfillmentSyncedAt &&
    order.trackingReceivedAt < trackingFulfillmentThresholdDate();
  let exceptionType = null;
  let message = order.lastError || order.providerFailureMessage || "";

  if (order.status === "MANUAL_REVIEW") exceptionType = FULFILLMENT_EXCEPTION_TYPES.MANUAL_REVIEW_REQUIRED;
  if (!exceptionType && isMalformedTracking(order.trackingNumber)) exceptionType = FULFILLMENT_EXCEPTION_TYPES.INVALID_TRACKING;
  if (!exceptionType && order.trackingReceivedAt && !order.trackingCarrier) exceptionType = FULFILLMENT_EXCEPTION_TYPES.CARRIER_MISSING;
  if (!exceptionType && isUnknownCarrier(order.trackingCarrier)) exceptionType = FULFILLMENT_EXCEPTION_TYPES.TRACKING_COMPANY_UNKNOWN;
  if (!exceptionType && delayed) exceptionType = FULFILLMENT_EXCEPTION_TYPES.TRACKING_RECEIVED_NOT_FULFILLED;
  if (!exceptionType) return null;

  if (!message) message = exceptionType.replaceAll("_", " ").toLowerCase();

  return {
    id: `provider-order:${order.id}`,
    source: "provider_order",
    exceptionType,
    severity: severityForException(exceptionType),
    status: order.status,
    shopifyOrderId: order.shopifyOrderId,
    provider: order.provider,
    message: redactDashboardText(message),
    createdAt: order.updatedAt,
  };
}

function detailFromQueueJob(job) {
  const delayed = job.runAt && job.runAt < trackingFulfillmentThresholdDate();
  if (job.status !== "failed" && !delayed) return null;
  const exceptionType = job.status === "failed" && job.attempts >= job.maxAttempts
    ? FULFILLMENT_EXCEPTION_TYPES.RETRY_EXHAUSTED
    : FULFILLMENT_EXCEPTION_TYPES.FULFILLMENT_UPDATE_DELAYED;

  return {
    id: `queue:${job.id}`,
    source: "order_queue",
    exceptionType,
    severity: severityForException(exceptionType),
    status: job.status,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    message: redactDashboardText(job.failureReason || job.lastError || `Fulfillment update job ${job.status}`),
    createdAt: job.updatedAt,
  };
}

function detailFromDlqJob(job) {
  return {
    id: `dlq:${job.id}`,
    source: "dlq",
    exceptionType: FULFILLMENT_EXCEPTION_TYPES.RETRY_EXHAUSTED,
    severity: "error",
    status: job.status,
    shopifyOrderId: job.shopifyOrderId,
    provider: job.provider,
    message: redactDashboardText(job.failureReason),
    createdAt: job.lastFailureAt,
  };
}

function matchesDetailFilters(item, filters) {
  if (filters.exceptionType && item.exceptionType !== filters.exceptionType) return false;
  if (filters.severity && item.severity !== filters.severity) return false;
  if (filters.status && item.status !== filters.status) return false;
  return true;
}

function classifyExceptionType(message, eventType) {
  if (eventType === "fulfillment_duplicate_prevented") return FULFILLMENT_EXCEPTION_TYPES.DUPLICATE_FULFILLMENT_SKIPPED;
  if (isInvalidTrackingMessage(message)) return FULFILLMENT_EXCEPTION_TYPES.INVALID_TRACKING;
  if (/shopify|graphql|fulfillment request timed out|validation failed|api returned/i.test(message || "")) {
    return FULFILLMENT_EXCEPTION_TYPES.SHOPIFY_FULFILLMENT_API_FAILED;
  }
  if (/manual review/i.test(message || "")) return FULFILLMENT_EXCEPTION_TYPES.MANUAL_REVIEW_REQUIRED;
  return FULFILLMENT_EXCEPTION_TYPES.FULFILLMENT_UPDATE_DELAYED;
}

function isFulfillmentApiFailure(event) {
  const payload = parseMetricPayload(event.payload);
  const text = JSON.stringify(payload).toLowerCase();
  return event.provider === "shopify" && (
    payload.operation === "fulfillment_graphql" ||
    text.includes("fulfillment") ||
    event.eventType === "api_timeout"
  );
}

function statusGroupFromPayload(payloadValue, eventType) {
  const payload = parseMetricPayload(payloadValue);
  const status = Number(payload.status);
  if (eventType === "api_timeout" || payload.timedOut) return "timeout";
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (/validation|usererrors/i.test(JSON.stringify(payload))) return "validation";
  return "unknown";
}

function reasonFromPayload(payloadValue) {
  const payload = parseMetricPayload(payloadValue);
  return payload.error || payload.failureReason || payload.message || payload.event || "";
}

function responseErrorMessage(payloadValue) {
  const payload = parseMetricPayload(payloadValue);
  return payload.errors?.[0]?.message || payload.data?.fulfillmentCreate?.userErrors?.[0]?.message || "";
}

function normalizeReason(reason) {
  const value = redactDashboardText(reason || "unknown");
  if (isInvalidTrackingMessage(value)) return "Invalid tracking data";
  if (/duplicate/i.test(value)) return "Duplicate fulfillment skipped";
  if (/timed out|timeout/i.test(value)) return "Shopify fulfillment timeout";
  if (/validation|userErrors/i.test(value)) return "Shopify fulfillment validation failed";
  if (/api returned|graphql|shopify/i.test(value)) return "Shopify fulfillment API failed";
  if (/carrier/i.test(value)) return "Carrier or tracking company issue";
  return value || "Unknown fulfillment exception";
}

function isInvalidTrackingMessage(message) {
  return /invalid tracking|malformed tracking|invalid carrier|invalid tracking url|tracking payload/i.test(message || "");
}

function isMalformedTracking(trackingNumber) {
  return Boolean(trackingNumber) && !/^[A-Z0-9][A-Z0-9 -]{5,63}$/.test(String(trackingNumber).trim().toUpperCase());
}

function isUnknownCarrier(carrier) {
  return Boolean(carrier) && UNKNOWN_CARRIERS.has(String(carrier).trim().toLowerCase());
}

function severityForException(exceptionType) {
  if ([FULFILLMENT_EXCEPTION_TYPES.RETRY_EXHAUSTED, FULFILLMENT_EXCEPTION_TYPES.SHOPIFY_FULFILLMENT_API_FAILED].includes(exceptionType)) {
    return "error";
  }
  if (exceptionType === FULFILLMENT_EXCEPTION_TYPES.DUPLICATE_FULFILLMENT_SKIPPED) return "info";
  return "warning";
}

function shopWhere(filters) {
  return filters.shop ? { shop: filters.shop } : {};
}

function dateWhere(filters, field) {
  if (!filters.dateFrom && !filters.dateTo) return {};
  return {
    [field]: {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    },
  };
}

function dateWhereWith(filters, field, base) {
  return {
    [field]: {
      ...base,
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    },
  };
}

function trackingFulfillmentThresholdDate() {
  return new Date(Date.now() - delayedFulfillmentThresholdMinutes() * 60 * 1000);
}

function delayedFulfillmentThresholdMinutes() {
  return readNumberEnv("FULFILLMENT_EXCEPTION_DELAY_WARNING_MINUTES", {
    defaultValue: 60,
    min: 5,
    max: 10080,
  });
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function countBy(values) {
  const counts = values.reduce((result, value) => {
    result.set(value, (result.get(value) || 0) + 1);
    return result;
  }, new Map());
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}
