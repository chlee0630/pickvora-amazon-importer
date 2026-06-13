import prisma from "../db.server.js";
import { enqueueFraudCancelPollJob } from "../queues/order-queue.server.js";
import { withApiRetry } from "../utils/api-retry.server.js";
import { isProductionRuntime } from "../utils/runtime-flags.server.js";
import { trackApiCall } from "./monitoring/api-metrics.server.js";
import { recordMonitoringEvent } from "./monitoring/monitoring-service.server.js";

const API_VERSION = "2025-10";
const DEFAULT_TIMEOUT_MS = 30000;
const FRAUD_ORDER_CANCEL_STAFF_NOTE = "Pickvora fraud protection cancellation";
const SAFE_ORDER_CANCEL_MESSAGE_MAX_LENGTH = 240;
const PRODUCTION_FRAUD_REFUND_SHOP = "cmgpwd-ty.myshopify.com";
const DEV_FRAUD_REFUND_SHOP = "pickvora-dev.myshopify.com";
const FRAUD_ORDER_CANCEL_BLOCKED_ORDER_NAMES = new Set(
  Array.from({ length: 19 }, (_, index) => {
    const orderNumber = String(1005 + index);
    return [`#${orderNumber}`, orderNumber];
  }).flat()
);

export const DEFAULT_FRAUD_PROTECTION_CONFIG = {
  enabled: false,
  dryRun: true,
  autoCancelHighRisk: false,
  autoCancelMediumRisk: false,
  blockZincOnHighRisk: false,
  cancelReason: "FRAUD",
  restockInventory: true,
  refundPayment: true,
  notifyCustomer: false,
  delayMinutes: 2,
};

export const EMPTY_FRAUD_ANALYTICS = {
  totalAssessments: 0,
  highRiskCount: 0,
  mediumRiskCount: 0,
  lowRiskCount: 0,
  pendingRiskCount: 0,
  reviewCount: 0,
  wouldCancelCount: 0,
  cancelledCount: 0,
  recent: [],
};

const RISK_PRIORITY = {
  HIGH: 5,
  MEDIUM: 4,
  LOW: 3,
  NONE: 2,
  PENDING: 1,
  UNKNOWN: 0,
};

async function adminFetch(shop, accessToken, query, variables = {}, timeoutMs = DEFAULT_TIMEOUT_MS, operationName = "fraud_risk_fetch") {
  return withApiRetry(() => trackApiCall("shopify", operationName, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const error = new Error(`Shopify API returned ${res.status}`);
        error.statusCode = res.status;
        error.retryAfter = res.headers.get("retry-after");
        error.retryable = [429, 500, 502, 503, 504].includes(res.status);
        throw error;
      }

      return res.json();
    } catch (err) {
      if (err.name === "AbortError") {
        err.retryable = true;
        err.code = "TIMEOUT";
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }, { shop, timeoutMs }), {
    provider: "shopify",
    operationName,
  });
}

export async function getFraudProtectionConfig(shop) {
  const config = await prisma.fraudProtectionConfig.findUnique({ where: { shop } });
  return config || { shop, ...DEFAULT_FRAUD_PROTECTION_CONFIG };
}

export async function updateFraudProtectionConfig({
  shop,
  enabled,
  dryRun,
  autoCancelHighRisk,
  autoCancelMediumRisk,
  blockZincOnHighRisk,
  restockInventory,
  updatedBy,
}, deps = {}) {
  if (!shop) throw new Error("Shop is required to update fraud protection config.");

  const prismaClient = deps.prismaClient || prisma;
  const safeConfig = sanitizeFraudProtectionConfig({
    enabled,
    dryRun,
    autoCancelHighRisk,
    autoCancelMediumRisk,
    blockZincOnHighRisk,
    restockInventory,
  });

  const config = await prismaClient.fraudProtectionConfig.upsert({
    where: { shop },
    create: {
      shop,
      ...safeConfig,
    },
    update: safeConfig,
  });

  console.log(JSON.stringify({
    event: "fraud_protection_config_updated",
    layer: "fraud_protection",
    shop,
    enabled: config.enabled,
    dryRun: config.dryRun,
    autoCancelHighRisk: config.autoCancelHighRisk,
    autoCancelMediumRisk: config.autoCancelMediumRisk,
    blockZincOnHighRisk: config.blockZincOnHighRisk,
    updatedBy: updatedBy ? "admin" : null,
  }));

  return config;
}

export async function createFraudTestAssessment({ shop, createdBy }, deps = {}) {
  if (!shop) throw new Error("Shop is required to create fraud test assessment.");

  const prismaClient = deps.prismaClient || prisma;
  const now = deps.now || new Date();
  const timestamp = now.getTime();
  const config = await getFraudProtectionConfigWithClient(shop, prismaClient);
  const riskLevel = "HIGH";
  const decision = getFraudDecision({ config, riskLevel });
  const orderName = `FRAUD-TEST-${timestamp}`;
  const shopifyOrderId = `gid://shopify/Order/fraud-test-${timestamp}`;

  const assessment = await prismaClient.fraudOrderAssessment.create({
    data: {
      shop,
      shopifyOrderId,
      orderName,
      riskLevel,
      recommendation: "CANCEL",
      totalPrice: null,
      currencyCode: null,
      displayFinancialStatus: "SIMULATED",
      displayFulfillmentStatus: "SIMULATED",
      cancelledAt: null,
      assessmentStatus: "ASSESSED",
      decision,
      actionMode: "DRY_RUN",
      cancellationStatus: null,
      cancellationError: null,
      riskPayload: JSON.stringify({
        source: "pickvora_internal_fraud_test",
        simulated: true,
        note: "No Shopify order was created",
        createdBy: createdBy ? "admin" : null,
      }),
      assessedAt: now,
    },
  });

  console.log(JSON.stringify({
    event: "fraud_test_assessment_created",
    layer: "fraud_protection",
    shop,
    shopifyOrderId,
    orderName,
    riskLevel,
    decision,
    actionMode: "DRY_RUN",
    createdBy: createdBy ? "admin" : null,
  }));

  return assessment;
}

export async function fetchShopifyOrderRisk(shop, accessToken, shopifyOrderId) {
  const res = await adminFetch(shop, accessToken, `
    query fraudOrderAssessment($id: ID!) {
      order(id: $id) {
        id
        name
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          nodes {
            variant {
              id
            }
          }
        }
        risk {
          assessments {
            riskLevel
            provider {
              title
            }
            facts {
              description
              sentiment
            }
          }
          recommendation
        }
      }
    }
  `, { id: shopifyOrderId });

  if (res.errors?.length) {
    throw new Error(`Shopify fraud risk fetch failed: ${JSON.stringify(res.errors)}`);
  }

  return res.data?.order || null;
}

export async function cancelShopifyFraudOrder({
  shop,
  accessToken,
  shopifyOrderId,
  restock = false,
  refundPayment = false,
}, deps = {}) {
  const fetchFn = deps.adminFetch || adminFetch;
  if (!isValidShopifyOrderGid(shopifyOrderId)) {
    throw new Error("Invalid Shopify order id for fraud cancellation.");
  }
  const shouldRestock = Boolean(restock);
  const shouldRefund = Boolean(refundPayment && canUseFraudOrderRefundForShop(shop));
  const refundMethodDefinition = shouldRefund ? "\n      $refundMethod: OrderCancelRefundMethodInput" : "";
  const refundMethodArgument = shouldRefund ? "\n        refundMethod: $refundMethod" : "";
  const variables = {
    orderId: shopifyOrderId,
    notifyCustomer: false,
    restock: shouldRestock,
    reason: "FRAUD",
    staffNote: FRAUD_ORDER_CANCEL_STAFF_NOTE,
  };
  if (shouldRefund) {
    variables.refundMethod = { originalPaymentMethodsRefund: true };
  }

  const res = await fetchFn(shop, accessToken, `
    mutation cancelFraudOrder(
      $orderId: ID!
      $notifyCustomer: Boolean
      ${refundMethodDefinition}
      $restock: Boolean!
      $reason: OrderCancelReason!
      $staffNote: String
    ) {
      orderCancel(
        orderId: $orderId
        notifyCustomer: $notifyCustomer
        ${refundMethodArgument}
        restock: $restock
        reason: $reason
        staffNote: $staffNote
      ) {
        job {
          id
          done
        }
        orderCancelUserErrors {
          field
          message
          code
        }
        userErrors {
          field
          message
        }
      }
    }
  `, variables, DEFAULT_TIMEOUT_MS, "fraud_order_cancel");

  if (res.errors?.length) {
    const error = new Error("Shopify orderCancel returned GraphQL errors.");
    error.code = "ORDER_CANCEL_GRAPHQL_ERRORS";
    error.userErrors = res.errors.map((item) => ({
      message: item?.message || "Shopify GraphQL error",
    }));
    error.safeOrderCancelSummary = buildSafeOrderCancelResponseLogDetails({
      shop,
      shopifyOrderId,
      shouldRestock,
      shouldRefund,
      refundMethodType: shouldRefund ? "ORIGINAL_PAYMENT_METHODS" : null,
      notifyCustomer: false,
      graphQLErrors: res.errors,
    });
    throw error;
  }

  const payload = res.data?.orderCancel || {};
  const userErrors = [
    ...(payload.orderCancelUserErrors || []),
    ...(payload.userErrors || []),
  ];
  if (userErrors.length) {
    const error = new Error("Shopify orderCancel returned user errors.");
    error.code = "ORDER_CANCEL_USER_ERRORS";
    error.userErrors = userErrors;
    error.safeOrderCancelSummary = buildSafeOrderCancelResponseLogDetails({
      shop,
      shopifyOrderId,
      shouldRestock,
      shouldRefund,
      refundMethodType: shouldRefund ? "ORIGINAL_PAYMENT_METHODS" : null,
      notifyCustomer: false,
      job: payload.job || null,
      userErrors: payload.userErrors || [],
      orderCancelUserErrors: payload.orderCancelUserErrors || [],
    });
    throw error;
  }

  return {
    job: payload.job || null,
    safeLog: buildSafeOrderCancelResponseLogDetails({
      shop,
      shopifyOrderId,
      shouldRestock,
      shouldRefund,
      refundMethodType: shouldRefund ? "ORIGINAL_PAYMENT_METHODS" : null,
      notifyCustomer: false,
      job: payload.job || null,
      userErrors: payload.userErrors || [],
      orderCancelUserErrors: payload.orderCancelUserErrors || [],
    }),
  };
}

export async function fetchShopifyCancelJobStatus({ shop, accessToken, cancelJobId }, deps = {}) {
  const fetchFn = deps.adminFetch || adminFetch;
  if (!isValidShopifyJobGid(cancelJobId)) {
    throw new Error("Invalid Shopify job id for fraud cancellation polling.");
  }

  const res = await fetchFn(shop, accessToken, `
    query fraudCancelJobStatus($id: ID!) {
      job(id: $id) {
        id
        done
      }
    }
  `, { id: cancelJobId }, DEFAULT_TIMEOUT_MS, "fraud_order_cancel_job_poll");

  if (res.errors?.length) {
    const error = new Error("Shopify cancel job lookup returned GraphQL errors.");
    error.code = "ORDER_CANCEL_JOB_GRAPHQL_ERRORS";
    error.userErrors = res.errors.map((item) => ({
      message: item?.message || "Shopify GraphQL error",
    }));
    throw error;
  }

  return res.data?.job || null;
}

export async function fetchShopifyOrderCancellationStatus({ shop, accessToken, shopifyOrderId }, deps = {}) {
  const fetchFn = deps.adminFetch || adminFetch;
  if (!isValidShopifyOrderGid(shopifyOrderId)) {
    throw new Error("Invalid Shopify order id for fraud cancellation polling.");
  }

  const res = await fetchFn(shop, accessToken, `
    query fraudCancelOrderStatus($id: ID!) {
      order(id: $id) {
        id
        name
        cancelledAt
        cancelReason
      }
    }
  `, { id: shopifyOrderId }, DEFAULT_TIMEOUT_MS, "fraud_order_cancel_order_poll");

  if (res.errors?.length) {
    const error = new Error("Shopify order cancellation lookup returned GraphQL errors.");
    error.code = "ORDER_CANCEL_STATUS_GRAPHQL_ERRORS";
    error.userErrors = res.errors.map((item) => ({
      message: item?.message || "Shopify GraphQL error",
    }));
    throw error;
  }

  return res.data?.order || null;
}

export async function assessOrderFraudRisk({ shop, accessToken, shopifyOrderId }) {
  const [config, order] = await Promise.all([
    getFraudProtectionConfig(shop),
    fetchShopifyOrderRisk(shop, accessToken, shopifyOrderId),
  ]);

  if (!order) {
    throw new Error(`Shopify order not found for fraud assessment: ${shopifyOrderId}`);
  }

  const riskLevel = getHighestRiskLevel(order.risk?.assessments || []);
  const decision = getFraudDecision({ config, riskLevel });
  const actionMode = getActionMode({ config, decision });

  const totalPrice = Number(order.totalPriceSet?.shopMoney?.amount || 0);
  const currencyCode = order.totalPriceSet?.shopMoney?.currencyCode || null;

  const assessment = await prisma.fraudOrderAssessment.upsert({
    where: {
      shop_shopifyOrderId: {
        shop,
        shopifyOrderId,
      },
    },
    create: {
      shop,
      shopifyOrderId,
      orderName: order.name,
      riskLevel,
      recommendation: order.risk?.recommendation || null,
      totalPrice: Number.isFinite(totalPrice) ? totalPrice : null,
      currencyCode,
      displayFinancialStatus: order.displayFinancialStatus || null,
      displayFulfillmentStatus: order.displayFulfillmentStatus || null,
      cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
      assessmentStatus: "ASSESSED",
      decision,
      actionMode,
      riskPayload: JSON.stringify(order.risk || {}),
      assessedAt: new Date(),
    },
    update: {
      orderName: order.name,
      riskLevel,
      recommendation: order.risk?.recommendation || null,
      totalPrice: Number.isFinite(totalPrice) ? totalPrice : null,
      currencyCode,
      displayFinancialStatus: order.displayFinancialStatus || null,
      displayFulfillmentStatus: order.displayFulfillmentStatus || null,
      cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
      assessmentStatus: "ASSESSED",
      decision,
      actionMode,
      riskPayload: JSON.stringify(order.risk || {}),
      assessedAt: new Date(),
      cancellationError: null,
    },
  });

  console.log(JSON.stringify({
    event: "fraud_order_assessed",
    layer: "fraud_protection",
    shop,
    shopifyOrderId,
    orderName: order.name,
    riskLevel,
    recommendation: order.risk?.recommendation || null,
    decision,
    actionMode,
  }));

  return {
    config,
    order,
    assessment,
    riskLevel,
    decision,
    actionMode,
  };
}

export async function handleFraudOrderCancellation({
  shop,
  accessToken,
  fraudAssessment,
  shouldBlockZinc,
}, deps = {}) {
  const prismaClient = deps.prismaClient || prisma;
  const cancelOrder = deps.cancelShopifyFraudOrder || cancelShopifyFraudOrder;
  const enqueueCancelPoll = deps.enqueueFraudCancelPollJob || enqueueFraudCancelPollJob;
  const logEvent = deps.logEvent || logFraudOrderCancelEvent;
  const result = fraudAssessment?.result;
  const order = result?.order;
  const assessment = result?.assessment;

  if (fraudAssessment?.skipped || !assessment?.shopifyOrderId || result?.riskLevel !== "HIGH" || !shouldBlockZinc) {
    return { status: "SKIPPED", reason: "not_cancel_candidate" };
  }

  const eligibility = getFraudOrderCancelEligibility({
    order,
    fraudAssessment,
    shouldBlockZinc,
  });

  if (!eligibility.allowed) {
    await updateFraudCancellationStatus({
      prismaClient,
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      cancellationStatus: "SKIPPED",
      cancellationError: eligibility.reason,
    });
    logEvent("fraud_order_cancel_skipped", {
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      orderName: assessment.orderName || order?.name || null,
      reason: eligibility.reason,
    });
    return { status: "SKIPPED", reason: eligibility.reason };
  }

  const restock = getFraudOrderRestockOption({
    order,
    fraudAssessment,
    shouldBlockZinc,
  });
  const refundPayment = getFraudOrderRefundOption({
    shop,
    order,
    fraudAssessment,
    shouldBlockZinc,
  });
  const baseLogDetails = {
    shop,
    shopifyOrderId: assessment.shopifyOrderId,
    orderName: assessment.orderName || order?.name || null,
    riskLevel: result?.riskLevel || null,
    shouldBlockZinc,
    shouldRestock: restock,
    shouldRefund: refundPayment,
    refundMethodType: refundPayment ? "ORIGINAL_PAYMENT_METHODS" : null,
    notifyCustomer: false,
    refundPaymentUsed: refundPayment,
    refundMethodUsed: refundPayment,
  };
  logEvent("fraud_order_cancel_options_resolved", buildSafeFraudOrderCancelLogDetails(baseLogDetails));

  try {
    logEvent("fraud_order_cancel_request_prepared", buildSafeFraudOrderCancelLogDetails(baseLogDetails));
    const cancellation = await cancelOrder({
      shop,
      accessToken,
      shopifyOrderId: assessment.shopifyOrderId,
      restock,
      refundPayment,
    });
    logEvent("fraud_order_cancel_response_received", buildSafeFraudOrderCancelLogDetails({
      ...baseLogDetails,
      ...buildSafeOrderCancelResponseLogDetails({
        ...cancellation.safeLog,
        shop,
        orderName: assessment.orderName || order?.name || null,
        shopifyOrderId: assessment.shopifyOrderId,
        shouldRestock: restock,
        shouldRefund: refundPayment,
        refundMethodType: refundPayment ? "ORIGINAL_PAYMENT_METHODS" : null,
        notifyCustomer: false,
        job: cancellation.job || null,
      }),
    }));
    const cancellationStatus = cancellation.job?.done ? "CANCELLED" : "REQUESTED";
    await updateFraudCancellationStatus({
      prismaClient,
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      cancellationStatus,
      cancellationError: null,
    });
    if (cancellationStatus === "REQUESTED" && cancellation.job?.id) {
      await enqueueCancelPoll({
        shop,
        shopifyOrderId: assessment.shopifyOrderId,
        provider: "zinc",
        cancelJobId: cancellation.job.id,
        requestedAt: new Date().toISOString(),
      });
    }
    logEvent("fraud_order_cancel_requested", buildSafeFraudOrderCancelLogDetails({
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      orderName: assessment.orderName || order?.name || null,
      cancellationStatus,
      jobId: cancellation.job?.id || null,
      jobDone: Boolean(cancellation.job?.done),
      shouldRestock: restock,
      shouldRefund: refundPayment,
      refundMethodType: refundPayment ? "ORIGINAL_PAYMENT_METHODS" : null,
      refundPaymentUsed: refundPayment,
      refundMethodUsed: refundPayment,
      orderCancelJobDone: Boolean(cancellation.job?.done),
      hasCancellationError: false,
    }));
    return {
      status: cancellationStatus,
      job: cancellation.job || null,
    };
  } catch (err) {
    const cancellationError = summarizeOrderCancelError(err);
    const responseLog = err?.safeOrderCancelSummary || buildSafeOrderCancelResponseLogDetails({
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      shouldRestock: restock,
      shouldRefund: refundPayment,
      refundMethodType: refundPayment ? "ORIGINAL_PAYMENT_METHODS" : null,
      notifyCustomer: false,
      userErrors: err?.userErrors || [],
    });
    logEvent("fraud_order_cancel_response_received", buildSafeFraudOrderCancelLogDetails({
      ...responseLog,
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      orderName: assessment.orderName || order?.name || null,
    }));
    await updateFraudCancellationStatus({
      prismaClient,
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      cancellationStatus: "FAILED",
      cancellationError,
    });
    logEvent("fraud_order_cancel_failed", buildSafeFraudOrderCancelLogDetails({
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      orderName: assessment.orderName || order?.name || null,
      error: cancellationError,
      hasCancellationError: true,
    }));
    return { status: "FAILED", error: cancellationError };
  }
}

export async function processFraudCancelPoll({ job, accessToken }, deps = {}) {
  const prismaClient = deps.prismaClient || prisma;
  const fetchJobStatus = deps.fetchShopifyCancelJobStatus || fetchShopifyCancelJobStatus;
  const fetchOrderStatus = deps.fetchShopifyOrderCancellationStatus || fetchShopifyOrderCancellationStatus;
  const enqueueCancelPoll = deps.enqueueFraudCancelPollJob || enqueueFraudCancelPollJob;
  const logEvent = deps.logEvent || logFraudOrderCancelEvent;
  const shopifyOrderId = String(job?.shopifyOrderId || "").trim();

  if (!isValidShopifyOrderGid(shopifyOrderId)) {
    return { status: "SKIPPED", reason: "invalid_shopify_order_id" };
  }

  const assessment = await prismaClient.fraudOrderAssessment.findUnique({
    where: {
      shop_shopifyOrderId: {
        shop: job.shop,
        shopifyOrderId,
      },
    },
  });
  if (!assessment) return { status: "SKIPPED", reason: "assessment_missing" };
  if (assessment.cancellationStatus !== "REQUESTED") {
    return { status: "SKIPPED", reason: "status_not_requested" };
  }

  const payload = parseFraudCancelPollPayload(job.payload);
  const cancelJobId = payload.cancelJobId;
  let jobDone = false;
  let jobLookupFailed = false;

  if (cancelJobId) {
    try {
      const cancelJob = await fetchJobStatus({
        shop: job.shop,
        accessToken,
        cancelJobId,
      });
      jobDone = Boolean(cancelJob?.done);
    } catch (err) {
      jobLookupFailed = true;
      logEvent("fraud_order_cancel_job_poll_failed", {
        shop: job.shop,
        shopifyOrderId,
        error: summarizeOrderCancelError(err),
      });
    }
  }

  if (jobDone || jobLookupFailed || !cancelJobId) {
    const order = await fetchOrderStatus({
      shop: job.shop,
      accessToken,
      shopifyOrderId,
    });
    if (order?.cancelledAt || order?.cancelReason) {
      await updateFraudCancellationStatus({
        prismaClient,
        shop: job.shop,
        shopifyOrderId,
        cancellationStatus: "CANCELLED",
        cancellationError: null,
      });
      logEvent("fraud_order_cancel_confirmed", {
        shop: job.shop,
        shopifyOrderId,
        orderName: assessment.orderName || order?.name || null,
        cancellationStatus: "CANCELLED",
        jobId: cancelJobId || null,
        jobDone,
      });
      return { status: "CANCELLED" };
    }
    if (jobLookupFailed) {
      if (isFraudCancelPollExhausted(job)) {
        return markFraudCancelPollStale({
          prismaClient,
          shop: job.shop,
          shopifyOrderId,
          reason: "Shopify cancel job lookup failed and order is not cancelled.",
        });
      }
      const error = new Error("Shopify cancel job lookup failed and order is not cancelled yet.");
      error.retryable = true;
      error.code = "ORDER_CANCEL_JOB_LOOKUP_RETRY";
      throw error;
    }
  }

  if (isFraudCancelPollExhausted(job)) {
    return markFraudCancelPollStale({
      prismaClient,
      shop: job.shop,
      shopifyOrderId,
      reason: "Shopify order cancellation was not confirmed before poll timeout.",
    });
  }

  await enqueueCancelPoll({
    shop: job.shop,
    shopifyOrderId,
    provider: job.provider,
    cancelJobId,
    requestedAt: payload.requestedAt || new Date().toISOString(),
    delayMs: getFraudCancelPollDelayMs(job.attempts),
    rescheduleExisting: true,
  });
  logEvent("fraud_order_cancel_poll_pending", {
    shop: job.shop,
    shopifyOrderId,
    cancellationStatus: "REQUESTED",
    jobId: cancelJobId || null,
    jobDone,
  });
  return { status: "REQUESTED", retryScheduled: true };
}

export async function getFraudAnalyticsDashboard(shop) {
  const [
    totalAssessments,
    highRiskCount,
    mediumRiskCount,
    lowRiskCount,
    pendingRiskCount,
    reviewCount,
    wouldCancelCount,
    cancelledCount,
    recent,
  ] = await Promise.all([
    prisma.fraudOrderAssessment.count({ where: { shop } }),
    prisma.fraudOrderAssessment.count({ where: { shop, riskLevel: "HIGH" } }),
    prisma.fraudOrderAssessment.count({ where: { shop, riskLevel: "MEDIUM" } }),
    prisma.fraudOrderAssessment.count({ where: { shop, riskLevel: "LOW" } }),
    prisma.fraudOrderAssessment.count({ where: { shop, riskLevel: "PENDING" } }),
    prisma.fraudOrderAssessment.count({ where: { shop, decision: "REVIEW" } }),
    prisma.fraudOrderAssessment.count({ where: { shop, decision: "WOULD_CANCEL" } }),
    prisma.fraudOrderAssessment.count({ where: { shop, decision: "CANCELLED" } }),
    prisma.fraudOrderAssessment.findMany({
      where: { shop },
      orderBy: { assessedAt: "desc" },
      take: 20,
      select: {
        id: true,
        shopifyOrderId: true,
        orderName: true,
        riskLevel: true,
        recommendation: true,
        totalPrice: true,
        currencyCode: true,
        displayFinancialStatus: true,
        displayFulfillmentStatus: true,
        decision: true,
        actionMode: true,
        cancellationStatus: true,
        cancellationError: true,
        assessedAt: true,
      },
    }),
  ]);

  return {
    totalAssessments,
    highRiskCount,
    mediumRiskCount,
    lowRiskCount,
    pendingRiskCount,
    reviewCount,
    wouldCancelCount,
    cancelledCount,
    recent,
  };
}

function getHighestRiskLevel(assessments) {
  if (!assessments.length) return "UNKNOWN";

  return assessments
    .map((assessment) => String(assessment.riskLevel || "UNKNOWN").toUpperCase())
    .sort((a, b) => (RISK_PRIORITY[b] || 0) - (RISK_PRIORITY[a] || 0))[0] || "UNKNOWN";
}

export function getFraudOrderCancelEligibility({ order, fraudAssessment, shouldBlockZinc }) {
  const result = fraudAssessment?.result;
  const assessment = result?.assessment;
  const orderName = String(order?.name || assessment?.orderName || "").trim();
  const shopifyOrderId = String(order?.id || assessment?.shopifyOrderId || "").trim();

  if (fraudAssessment?.skipped) return { allowed: false, reason: "fraud_assessment_skipped" };
  if (!result?.config?.enabled) return { allowed: false, reason: "fraud_protection_disabled" };
  if (!result?.config?.autoCancelHighRisk) return { allowed: false, reason: "high_risk_auto_cancel_disabled" };
  if (result?.riskLevel !== "HIGH") return { allowed: false, reason: "risk_not_high" };
  if (!shouldBlockZinc) return { allowed: false, reason: "zinc_block_not_enabled" };
  if (assessment?.cancellationStatus) return { allowed: false, reason: "fraud_order_cancel_already_recorded" };
  if (isBlockedFraudOrderCancelName(orderName)) return { allowed: false, reason: "blocked_test_order" };
  if (!isValidShopifyOrderGid(shopifyOrderId)) return { allowed: false, reason: "invalid_shopify_order_id" };
  return { allowed: true, reason: "eligible" };
}

export function getFraudOrderRestockOption({ fraudAssessment, shouldBlockZinc }) {
  const result = fraudAssessment?.result;
  if (fraudAssessment?.skipped) return false;
  if (!result?.config?.enabled) return false;
  if (!result?.config?.restockInventory) return false;
  if (result?.riskLevel !== "HIGH") return false;
  if (!shouldBlockZinc) return false;
  return true;
}

export function getFraudOrderRefundOption({ shop, order, fraudAssessment, shouldBlockZinc }) {
  const result = fraudAssessment?.result;
  const assessment = result?.assessment;
  const orderName = String(order?.name || assessment?.orderName || "").trim();
  const shopifyOrderId = String(order?.id || assessment?.shopifyOrderId || "").trim();

  if (!canUseFraudOrderRefundForShop(shop)) return false;
  if (fraudAssessment?.skipped) return false;
  if (!result?.config?.enabled) return false;
  if (result.config.dryRun) return false;
  if (!result.config.autoCancelHighRisk) return false;
  if (!result.config.blockZincOnHighRisk) return false;
  if (!result.config.refundPayment) return false;
  if (result.config.notifyCustomer !== false) return false;
  if (result.riskLevel !== "HIGH") return false;
  if (result.decision !== "CANCEL_REQUIRED") return false;
  if (!shouldBlockZinc) return false;
  if (assessment?.cancellationStatus) return false;
  if (isBlockedFraudOrderCancelName(orderName)) return false;
  if (!isValidShopifyOrderGid(shopifyOrderId)) return false;
  return true;
}

export function canUseFraudOrderRefundForShop(shop) {
  if (!shop) return false;
  if (String(process.env.FRAUD_ORDER_CANCEL_ENABLED || "") !== "true") return false;
  if (String(process.env.FRAUD_ORDER_REFUND_ENABLED || "") !== "true") return false;

  const normalizedShop = String(shop).trim().toLowerCase();
  if (isProductionRuntime()) {
    return normalizedShop === PRODUCTION_FRAUD_REFUND_SHOP;
  }

  const protectedShop = String(process.env.SHOP_CUSTOM_DOMAIN || "").trim().toLowerCase();
  if (protectedShop && normalizedShop === protectedShop) return false;
  return normalizedShop === DEV_FRAUD_REFUND_SHOP;
}

export function isBlockedFraudOrderCancelName(value) {
  const normalized = String(value || "").trim();
  return Boolean(normalized && FRAUD_ORDER_CANCEL_BLOCKED_ORDER_NAMES.has(normalized));
}

function isValidShopifyOrderGid(value) {
  return /^gid:\/\/shopify\/Order\/[0-9]+$/.test(String(value || "").trim());
}

function isValidShopifyJobGid(value) {
  return /^gid:\/\/shopify\/Job\/[A-Za-z0-9-]+$/.test(String(value || "").trim());
}

function parseFraudCancelPollPayload(payload) {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return {};
    return {
      cancelJobId: typeof parsed.cancelJobId === "string" ? parsed.cancelJobId : null,
      requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : null,
      source: typeof parsed.source === "string" ? parsed.source : null,
    };
  } catch {
    return {};
  }
}

function isFraudCancelPollExhausted(job) {
  return Number(job?.attempts || 0) >= Number(job?.maxAttempts || 8);
}

function getFraudCancelPollDelayMs(attempts) {
  const delays = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
  return delays[Math.min(Math.max(Number(attempts || 1) - 1, 0), delays.length - 1)];
}

async function markFraudCancelPollStale({ prismaClient, shop, shopifyOrderId, reason }) {
  const cancellationError = String(reason || "Shopify order cancellation was not confirmed.").slice(0, 1000);
  await updateFraudCancellationStatus({
    prismaClient,
    shop,
    shopifyOrderId,
    cancellationStatus: "STALE",
    cancellationError,
  });
  return { status: "STALE", error: cancellationError };
}

async function updateFraudCancellationStatus({
  prismaClient,
  shop,
  shopifyOrderId,
  cancellationStatus,
  cancellationError,
}) {
  await prismaClient.fraudOrderAssessment.update({
    where: {
      shop_shopifyOrderId: {
        shop,
        shopifyOrderId,
      },
    },
    data: {
      cancellationStatus,
      cancellationError,
    },
  });
}

function summarizeOrderCancelError(err) {
  const userErrors = Array.isArray(err?.userErrors) ? err.userErrors : [];
  if (userErrors.length) {
    return userErrors
      .slice(0, 3)
      .map((item) => {
        const code = item?.code ? `${String(item.code).slice(0, 80)}: ` : "";
        return `${code}${String(item?.message || "Shopify orderCancel user error").slice(0, 240)}`;
      })
      .join("; ")
      .slice(0, 1000);
  }

  const code = err?.code ? `${String(err.code).slice(0, 80)}: ` : "";
  return `${code}${String(err?.message || err || "Shopify orderCancel failed").slice(0, 900)}`.slice(0, 1000);
}

function buildSafeOrderCancelResponseLogDetails({
  shop,
  orderName,
  shopifyOrderId,
  shouldRestock,
  shouldRefund,
  refundMethodType,
  notifyCustomer,
  job,
  orderCancelJobId,
  orderCancelJobDone,
  userErrors,
  orderCancelUserErrors,
  graphQLErrors,
}) {
  const safeUserErrors = sanitizeOrderCancelUserErrors(userErrors || graphQLErrors);
  const safeOrderCancelUserErrors = sanitizeOrderCancelUserErrors(orderCancelUserErrors);
  return buildSafeFraudOrderCancelLogDetails({
    shop,
    orderName,
    shopifyOrderId,
    shouldRestock,
    shouldRefund,
    refundMethodType,
    notifyCustomer: Boolean(notifyCustomer),
    refundPaymentUsed: Boolean(shouldRefund),
    refundMethodUsed: Boolean(shouldRefund),
    orderCancelJobId: orderCancelJobId || job?.id || null,
    orderCancelJobDone: Boolean(orderCancelJobDone ?? job?.done),
    userErrors: safeUserErrors,
    orderCancelUserErrors: safeOrderCancelUserErrors,
    hasUserErrors: safeUserErrors.length > 0,
    hasOrderCancelUserErrors: safeOrderCancelUserErrors.length > 0,
  });
}

function sanitizeOrderCancelUserErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 5).map((item) => {
    const safe = {};
    if (item?.code) safe.code = String(item.code).slice(0, 80);
    safe.message = String(item?.message || "Shopify orderCancel error")
      .slice(0, SAFE_ORDER_CANCEL_MESSAGE_MAX_LENGTH);
    return safe;
  });
}

function buildSafeFraudOrderCancelLogDetails(details = {}) {
  const userErrors = sanitizeOrderCancelUserErrors(details.userErrors);
  const orderCancelUserErrors = sanitizeOrderCancelUserErrors(details.orderCancelUserErrors);
  return {
    shop: details.shop || null,
    orderName: details.orderName || null,
    shopifyOrderId: details.shopifyOrderId || null,
    riskLevel: details.riskLevel || null,
    shouldBlockZinc: Boolean(details.shouldBlockZinc),
    shouldRestock: Boolean(details.shouldRestock),
    shouldRefund: Boolean(details.shouldRefund),
    refundMethodType: details.refundMethodType || null,
    notifyCustomer: Boolean(details.notifyCustomer),
    refundPaymentUsed: Boolean(details.refundPaymentUsed),
    refundMethodUsed: Boolean(details.refundMethodUsed),
    orderCancelJobId: details.orderCancelJobId || details.jobId || null,
    orderCancelJobDone: Boolean(details.orderCancelJobDone ?? details.jobDone),
    userErrors,
    orderCancelUserErrors,
    hasUserErrors: Boolean(details.hasUserErrors || userErrors.length),
    hasOrderCancelUserErrors: Boolean(details.hasOrderCancelUserErrors || orderCancelUserErrors.length),
    cancellationStatus: details.cancellationStatus || null,
    hasCancellationError: Boolean(details.hasCancellationError),
    reason: details.reason || null,
    error: details.error ? String(details.error).slice(0, 1000) : null,
  };
}

function logFraudOrderCancelEvent(event, details = {}) {
  const safeDetails = buildSafeFraudOrderCancelLogDetails(details);
  const payload = {
    event,
    layer: "fraud_protection",
    ...safeDetails,
  };
  console.log(JSON.stringify(payload));
  recordMonitoringEvent(event, {
    layer: "fraud_protection",
    ...safeDetails,
  }, { persist: true });
}

function getFraudDecision({ config, riskLevel }) {
  if (!config.enabled) return "ALLOW";

  if (riskLevel === "HIGH") {
    if (config.autoCancelHighRisk) return config.dryRun ? "WOULD_CANCEL" : "CANCEL_REQUIRED";
    return "REVIEW";
  }

  if (riskLevel === "MEDIUM") {
    if (config.autoCancelMediumRisk) return config.dryRun ? "WOULD_CANCEL" : "CANCEL_REQUIRED";
    return "REVIEW";
  }

  if (riskLevel === "PENDING" || riskLevel === "UNKNOWN") return "REVIEW";

  return "ALLOW";
}

function getActionMode({ config, decision }) {
  if (!config.enabled) return "DISABLED";
  if (config.dryRun) return "DRY_RUN";
  if (decision === "CANCEL_REQUIRED") return "LIVE_PENDING_CANCEL";
  return "LIVE";
}

function sanitizeFraudProtectionConfig({
  enabled,
  dryRun,
  autoCancelHighRisk,
  autoCancelMediumRisk,
  blockZincOnHighRisk,
  restockInventory,
}) {
  return {
    enabled: Boolean(enabled),
    dryRun: true,
    autoCancelHighRisk: Boolean(enabled && autoCancelHighRisk),
    autoCancelMediumRisk: false,
    blockZincOnHighRisk: Boolean(enabled && blockZincOnHighRisk),
    cancelReason: "FRAUD",
    restockInventory: Boolean(enabled && restockInventory !== false),
    refundPayment: false,
    notifyCustomer: false,
    delayMinutes: 2,
  };
}

async function getFraudProtectionConfigWithClient(shop, prismaClient) {
  const config = await prismaClient.fraudProtectionConfig.findUnique({ where: { shop } });
  return config || { shop, ...DEFAULT_FRAUD_PROTECTION_CONFIG };
}
