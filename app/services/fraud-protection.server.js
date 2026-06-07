import prisma from "../db.server.js";
import { withApiRetry } from "../utils/api-retry.server.js";
import { canUseFraudTestSimulationForShop, isProductionRuntime } from "../utils/runtime-flags.server.js";
import { trackApiCall } from "./monitoring/api-metrics.server.js";

const API_VERSION = "2025-10";
const DEFAULT_TIMEOUT_MS = 30000;
const FRAUD_HIGH_RISK_OVERRIDE_MARKER = "PICKVORA_FRAUD_HIGH_TEST";
const DEV_FRAUD_ORDER_CANCEL_SHOP = "pickvora-dev.myshopify.com";
const FRAUD_ORDER_CANCEL_STAFF_NOTE = "Pickvora dev fraud protection test cancellation";
const FRAUD_HIGH_RISK_OVERRIDE_EXCLUDED_ORDERS = new Set([
  "#1005",
  "1005",
  "#1006",
  "1006",
  "#1007",
  "1007",
  "#1008",
  "1008",
  "#1009",
  "1009",
]);
const FRAUD_ORDER_CANCEL_BLOCKED_ORDER_REFS = new Set([
  "#1005",
  "1005",
  "gid://shopify/Order/1005",
  "#1006",
  "1006",
  "gid://shopify/Order/1006",
  "#1007",
  "1007",
  "gid://shopify/Order/1007",
  "#1008",
  "1008",
  "gid://shopify/Order/1008",
  "#1009",
  "1009",
  "gid://shopify/Order/1009",
  "#1010",
  "1010",
  "gid://shopify/Order/1010",
  "#1011",
  "1011",
  "gid://shopify/Order/1011",
  "#1012",
  "1012",
  "gid://shopify/Order/1012",
  "#1013",
  "1013",
  "gid://shopify/Order/1013",
  "#1014",
  "1014",
  "gid://shopify/Order/1014",
]);

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

export async function updateFraudZincBlockConfig({
  shop,
  blockZincOnHighRisk,
  updatedBy,
}, deps = {}) {
  if (!shop) throw new Error("Shop is required to update fraud Zinc block config.");

  const prismaClient = deps.prismaClient || prisma;
  const current = await getFraudProtectionConfigWithClient(shop, prismaClient);
  const enabled = Boolean(blockZincOnHighRisk) ? true : current.enabled;
  const safeConfig = sanitizeFraudProtectionConfig({
    enabled,
    dryRun: true,
    autoCancelHighRisk: Boolean(blockZincOnHighRisk) ? true : current.autoCancelHighRisk,
    autoCancelMediumRisk: false,
    blockZincOnHighRisk,
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
    event: "fraud_zinc_block_config_updated",
    layer: "fraud_protection",
    shop,
    enabled: config.enabled,
    dryRun: config.dryRun,
    autoCancelHighRisk: config.autoCancelHighRisk,
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
        shippingAddress {
          address2
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
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

export async function cancelShopifyFraudOrder({ shop, accessToken, shopifyOrderId }, deps = {}) {
  const fetchFn = deps.adminFetch || adminFetch;
  if (!isValidShopifyOrderGid(shopifyOrderId)) {
    throw new Error("Invalid Shopify order id for fraud cancellation.");
  }

  const res = await fetchFn(shop, accessToken, `
    mutation cancelFraudOrder(
      $orderId: ID!
      $notifyCustomer: Boolean
      $restock: Boolean!
      $reason: OrderCancelReason!
      $staffNote: String
    ) {
      orderCancel(
        orderId: $orderId
        notifyCustomer: $notifyCustomer
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
  `, {
    orderId: shopifyOrderId,
    notifyCustomer: false,
    restock: false,
    reason: "FRAUD",
    staffNote: FRAUD_ORDER_CANCEL_STAFF_NOTE,
  }, DEFAULT_TIMEOUT_MS, "fraud_order_cancel");

  if (res.errors?.length) {
    const error = new Error("Shopify orderCancel returned GraphQL errors.");
    error.code = "ORDER_CANCEL_GRAPHQL_ERRORS";
    error.userErrors = res.errors.map((item) => ({
      message: item?.message || "Shopify GraphQL error",
    }));
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
    throw error;
  }

  return {
    job: payload.job || null,
    responsePayload: {
      job: payload.job
        ? {
          id: payload.job.id || null,
          done: Boolean(payload.job.done),
        }
        : null,
    },
  };
}

export async function assessOrderFraudRisk({ shop, accessToken, shopifyOrderId }, deps = {}) {
  const getConfig = deps.getFraudProtectionConfig || getFraudProtectionConfig;
  const fetchRisk = deps.fetchShopifyOrderRisk || fetchShopifyOrderRisk;
  const prismaClient = deps.prismaClient || prisma;
  const logDebug = deps.logFraudHighRiskOverrideDebug || logFraudHighRiskOverrideDebug;

  const [config, order] = await Promise.all([
    getConfig(shop),
    fetchRisk(shop, accessToken, shopifyOrderId),
  ]);

  if (!order) {
    throw new Error(`Shopify order not found for fraud assessment: ${shopifyOrderId}`);
  }

  const address2 = String(order.shippingAddress?.address2 || "").trim();
  const actualRiskLevel = getHighestRiskLevel(order.risk?.assessments || []);
  const fraudOverride = getFraudHighRiskOverrideForOrder({ shop, order, actualRiskLevel });
  const riskLevel = fraudOverride ? "HIGH" : actualRiskLevel;
  logDebug({
    shop,
    orderName: order.name || null,
    hasAddress2: Boolean(address2),
    address2MarkerMatched: address2 === FRAUD_HIGH_RISK_OVERRIDE_MARKER,
    fraudTestSimulationAllowed: canUseFraudTestSimulationForShop(shop),
    overrideApplied: Boolean(fraudOverride),
    actualRiskLevel,
    finalRiskLevel: riskLevel,
  });
  const decision = getFraudDecision({ config, riskLevel });
  const actionMode = getActionMode({ config, decision });
  const riskPayload = fraudOverride
    ? {
      ...order.risk,
      override: fraudOverride,
    }
    : order.risk || {};

  const totalPrice = Number(order.totalPriceSet?.shopMoney?.amount || 0);
  const currencyCode = order.totalPriceSet?.shopMoney?.currencyCode || null;

  const assessment = await prismaClient.fraudOrderAssessment.upsert({
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
      riskPayload: JSON.stringify(riskPayload),
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
      riskPayload: JSON.stringify(riskPayload),
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
    fraudOverride,
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
  const logEvent = deps.logEvent || logFraudOrderCancelEvent;
  const result = fraudAssessment?.result;
  const order = result?.order;
  const assessment = result?.assessment;

  if (fraudAssessment?.skipped || !assessment?.shopifyOrderId || result?.riskLevel !== "HIGH" || !shouldBlockZinc) {
    return { status: "SKIPPED", reason: "not_cancel_candidate" };
  }

  const eligibility = getFraudOrderCancelEligibility({
    shop,
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

  try {
    const cancellation = await cancelOrder({
      shop,
      accessToken,
      shopifyOrderId: assessment.shopifyOrderId,
    });
    const cancellationStatus = cancellation.job?.done ? "CANCELLED" : "REQUESTED";
    await updateFraudCancellationStatus({
      prismaClient,
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      cancellationStatus,
      cancellationError: null,
    });
    logEvent("fraud_order_cancel_requested", {
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      orderName: assessment.orderName || order?.name || null,
      cancellationStatus,
      jobId: cancellation.job?.id || null,
      jobDone: Boolean(cancellation.job?.done),
    });
    return {
      status: cancellationStatus,
      job: cancellation.job || null,
    };
  } catch (err) {
    const cancellationError = summarizeOrderCancelError(err);
    await updateFraudCancellationStatus({
      prismaClient,
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      cancellationStatus: "FAILED",
      cancellationError,
    });
    logEvent("fraud_order_cancel_failed", {
      shop,
      shopifyOrderId: assessment.shopifyOrderId,
      orderName: assessment.orderName || order?.name || null,
      error: cancellationError,
    });
    return { status: "FAILED", error: cancellationError };
  }
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

export function getFraudHighRiskOverrideForOrder({ shop, order, actualRiskLevel }) {
  if (!shop || !order) return null;
  if (actualRiskLevel === "HIGH") return null;
  if (!canUseFraudTestSimulationForShop(shop)) return null;

  const orderName = String(order.name || "").trim();
  if (FRAUD_HIGH_RISK_OVERRIDE_EXCLUDED_ORDERS.has(orderName)) return null;

  const markerValue = String(order.shippingAddress?.address2 || "").trim();
  if (markerValue !== FRAUD_HIGH_RISK_OVERRIDE_MARKER) return null;

  return {
    source: "pickvora_dev_test_high_override",
    markerField: "shippingAddress.address2",
    markerValue,
    excludedOrders: Array.from(FRAUD_HIGH_RISK_OVERRIDE_EXCLUDED_ORDERS),
    actualRiskLevel,
    overriddenRiskLevel: "HIGH",
    devTestOnly: true,
  };
}

export function canUseFraudOrderCancelForShop(shop) {
  if (isProductionRuntime()) return false;
  if (String(process.env.FRAUD_ORDER_CANCEL_ENABLED || "") !== "true") return false;
  if (!shop) return false;
  const normalizedShop = String(shop).trim().toLowerCase();
  if (normalizedShop !== DEV_FRAUD_ORDER_CANCEL_SHOP) return false;
  const protectedShop = String(process.env.SHOP_CUSTOM_DOMAIN || "").trim().toLowerCase();
  if (protectedShop && normalizedShop === protectedShop) return false;
  return true;
}

export function getFraudOrderCancelEligibility({ shop, order, fraudAssessment, shouldBlockZinc }) {
  const result = fraudAssessment?.result;
  const assessment = result?.assessment;
  const orderName = String(order?.name || assessment?.orderName || "").trim();
  const shopifyOrderId = String(order?.id || assessment?.shopifyOrderId || "").trim();

  if (fraudAssessment?.skipped) return { allowed: false, reason: "fraud_assessment_skipped" };
  if (!canUseFraudOrderCancelForShop(shop)) return { allowed: false, reason: "fraud_order_cancel_disabled" };
  if (result?.riskLevel !== "HIGH") return { allowed: false, reason: "risk_not_high" };
  if (!shouldBlockZinc) return { allowed: false, reason: "zinc_block_not_enabled" };
  if (isBlockedFraudOrderCancelRef(orderName) || isBlockedFraudOrderCancelRef(shopifyOrderId)) {
    return { allowed: false, reason: "blocked_test_order" };
  }
  if (!isValidShopifyOrderGid(shopifyOrderId)) return { allowed: false, reason: "invalid_shopify_order_id" };
  return { allowed: true, reason: "eligible" };
}

export function isBlockedFraudOrderCancelRef(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return FRAUD_ORDER_CANCEL_BLOCKED_ORDER_REFS.has(normalized);
}

export function buildFraudHighRiskOverrideDebugDetails({
  shop,
  orderName,
  hasAddress2,
  address2MarkerMatched,
  fraudTestSimulationAllowed,
  overrideApplied,
  actualRiskLevel,
  finalRiskLevel,
}) {
  return {
    shop,
    orderName,
    hasAddress2: Boolean(hasAddress2),
    address2MarkerMatched: Boolean(address2MarkerMatched),
    fraudTestSimulationAllowed: Boolean(fraudTestSimulationAllowed),
    overrideApplied: Boolean(overrideApplied),
    actualRiskLevel,
    finalRiskLevel,
  };
}

export function logFraudHighRiskOverrideDebug(details) {
  if (isProductionRuntime()) return;
  console.log(JSON.stringify({
    event: "fraud_high_risk_override_debug",
    layer: "fraud_protection",
    ...buildFraudHighRiskOverrideDebugDetails(details),
  }));
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

function isValidShopifyOrderGid(value) {
  return /^gid:\/\/shopify\/Order\/[0-9]+$/.test(String(value || "").trim());
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

function logFraudOrderCancelEvent(event, details = {}) {
  if (isProductionRuntime()) return;
  console.log(JSON.stringify({
    event,
    layer: "fraud_protection",
    shop: details.shop,
    shopifyOrderId: details.shopifyOrderId,
    orderName: details.orderName,
    reason: details.reason,
    cancellationStatus: details.cancellationStatus,
    jobId: details.jobId,
    jobDone: details.jobDone,
    error: details.error,
  }));
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
}) {
  return {
    enabled: Boolean(enabled),
    dryRun: true,
    autoCancelHighRisk: Boolean(enabled && autoCancelHighRisk),
    autoCancelMediumRisk: false,
    blockZincOnHighRisk: Boolean(enabled && blockZincOnHighRisk),
    cancelReason: "FRAUD",
    restockInventory: false,
    refundPayment: false,
    notifyCustomer: false,
    delayMinutes: 2,
  };
}

async function getFraudProtectionConfigWithClient(shop, prismaClient) {
  const config = await prismaClient.fraudProtectionConfig.findUnique({ where: { shop } });
  return config || { shop, ...DEFAULT_FRAUD_PROTECTION_CONFIG };
}
