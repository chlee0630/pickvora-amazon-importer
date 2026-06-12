import prisma from "../db.server.js";
import { enqueueFraudCancelPollJob } from "../queues/order-queue.server.js";
import { withApiRetry } from "../utils/api-retry.server.js";
import { canUseFraudTestSimulationForShop, isProductionRuntime } from "../utils/runtime-flags.server.js";
import { trackApiCall } from "./monitoring/api-metrics.server.js";
import { recordMonitoringEvent } from "./monitoring/monitoring-service.server.js";

const API_VERSION = "2025-10";
const DEFAULT_TIMEOUT_MS = 30000;
const FRAUD_HIGH_RISK_OVERRIDE_MARKER = "PICKVORA_FRAUD_HIGH_TEST";
const DEV_FRAUD_ORDER_CANCEL_SHOP = "pickvora-dev.myshopify.com";
const PRODUCTION_SHOP = "cmgpwd-ty.myshopify.com";
const FRAUD_ORDER_CANCEL_STAFF_NOTE = "Pickvora dev fraud protection test cancellation";
const DEV_RESTOCK_TEST_VARIANT_ID = "gid://shopify/ProductVariant/50836887994615";
const SAFE_ORDER_CANCEL_MESSAGE_MAX_LENGTH = 240;
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
  "#1015",
  "1015",
  "gid://shopify/Order/1015",
  "#1016",
  "1016",
  "gid://shopify/Order/1016",
  "#1017",
  "1017",
  "gid://shopify/Order/1017",
  "gid://shopify/Order/7706684489975",
  "#1018",
  "1018",
  "gid://shopify/Order/1018",
  "gid://shopify/Order/7722671603959",
  "#1019",
  "1019",
  "gid://shopify/Order/1019",
  "gid://shopify/Order/7722866049271",
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

export const DEV_FRAUD_REFUND_E2E_CONFIG = Object.freeze({
  enabled: true,
  dryRun: false,
  autoCancelHighRisk: true,
  autoCancelMediumRisk: false,
  blockZincOnHighRisk: true,
  restockInventory: true,
  refundPayment: true,
  notifyCustomer: false,
});

export const DEV_FRAUD_REFUND_E2E_ROLLBACK_CONFIG = Object.freeze({
  enabled: true,
  dryRun: true,
  autoCancelHighRisk: true,
  autoCancelMediumRisk: false,
  blockZincOnHighRisk: true,
  restockInventory: true,
  refundPayment: false,
  notifyCustomer: false,
});

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
  refundPayment,
  updatedBy,
}, deps = {}) {
  if (!shop) throw new Error("Shop is required to update fraud protection config.");

  const prismaClient = deps.prismaClient || prisma;
  const safeConfig = sanitizeFraudProtectionConfig({
    shop,
    enabled,
    dryRun,
    autoCancelHighRisk,
    autoCancelMediumRisk,
    blockZincOnHighRisk,
    restockInventory,
    refundPayment,
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
    shop,
    enabled,
    dryRun: true,
    autoCancelHighRisk: Boolean(blockZincOnHighRisk) ? true : current.autoCancelHighRisk,
    autoCancelMediumRisk: false,
    blockZincOnHighRisk,
    restockInventory: current.restockInventory,
    refundPayment: current.refundPayment,
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

export async function enableDevFraudRefundE2EConfig({
  shop,
  targetShop = process.env.TARGET_SHOP,
  confirm = process.env.CONFIRM_DEV_REFUND_E2E,
}, deps = {}) {
  assertCanEnableDevFraudRefundE2EConfig({ shop, targetShop, confirm });

  const prismaClient = deps.prismaClient || prisma;
  const configData = buildDevFraudRefundE2EConfigData();
  const config = await prismaClient.fraudProtectionConfig.upsert({
    where: { shop },
    create: {
      shop,
      ...configData,
    },
    update: configData,
  });

  return pickSafeFraudProtectionConfigFields(config);
}

export function buildDevFraudRefundE2EConfigPlan({ shop }) {
  assertDevFraudRefundE2EShop(shop);
  return {
    shop,
    ...buildDevFraudRefundE2EConfigData(),
  };
}

export async function disableDevFraudRefundE2EConfig({
  shop,
  targetShop = process.env.TARGET_SHOP,
  confirm = process.env.CONFIRM_DISABLE_DEV_REFUND_E2E,
}, deps = {}) {
  assertCanDisableDevFraudRefundE2EConfig({ shop, targetShop, confirm });

  const prismaClient = deps.prismaClient || prisma;
  const configData = buildDevFraudRefundE2ERollbackConfigData();
  const config = await prismaClient.fraudProtectionConfig.upsert({
    where: { shop },
    create: {
      shop,
      ...configData,
    },
    update: configData,
  });

  return pickSafeFraudProtectionConfigFields(config);
}

export function buildDevFraudRefundE2ERollbackConfigPlan({ shop }) {
  assertDevFraudRefundE2EShop(shop);
  return {
    shop,
    ...buildDevFraudRefundE2ERollbackConfigData(),
  };
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
      notifyCustomer: false,
      job: payload.job || null,
      userErrors: payload.userErrors || [],
      orderCancelUserErrors: payload.orderCancelUserErrors || [],
    }),
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
  const enqueueCancelPoll = deps.enqueueFraudCancelPollJob || enqueueFraudCancelPollJob;
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
    if (eligibility.reason === "fraud_order_cancel_already_recorded") {
      logEvent("fraud_order_cancel_skipped", {
        shop,
        shopifyOrderId: assessment.shopifyOrderId,
        orderName: assessment.orderName || order?.name || null,
        reason: eligibility.reason,
      });
      return { status: "SKIPPED", reason: eligibility.reason };
    }
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
    shop,
    order,
    fraudAssessment,
    shouldBlockZinc,
  });
  const refund = getFraudOrderRefundOption({
    shop,
    order,
    fraudAssessment,
    shouldBlockZinc,
  });
  const refundMethodType = refund ? "ORIGINAL_PAYMENT_METHODS" : null;
  const baseLogDetails = {
    shop,
    shopifyOrderId: assessment.shopifyOrderId,
    orderName: assessment.orderName || order?.name || null,
    riskLevel: result?.riskLevel || null,
    shouldBlockZinc,
    shouldRestock: restock,
    shouldRefund: refund,
    refundMethodType,
    notifyCustomer: false,
    refundPaymentUsed: refund,
    refundMethodUsed: refund,
  };
  logEvent("fraud_order_cancel_options_resolved", buildSafeFraudOrderCancelLogDetails(baseLogDetails));

  try {
    logEvent("fraud_order_cancel_request_prepared", buildSafeFraudOrderCancelLogDetails(baseLogDetails));
    const cancellation = await cancelOrder({
      shop,
      accessToken,
      shopifyOrderId: assessment.shopifyOrderId,
      restock,
      refundPayment: refund,
    });
    logEvent("fraud_order_cancel_response_received", buildSafeFraudOrderCancelLogDetails({
      ...baseLogDetails,
      ...buildSafeOrderCancelResponseLogDetails({
        ...cancellation.safeLog,
        shop,
        orderName: assessment.orderName || order?.name || null,
        shopifyOrderId: assessment.shopifyOrderId,
        shouldRestock: restock,
        shouldRefund: refund,
        refundMethodType,
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
      shouldRefund: refund,
      refundMethodType,
      refundPaymentUsed: refund,
      refundMethodUsed: refund,
      restock,
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
      shouldRefund: refund,
      refundMethodType,
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

  if (!canUseFraudOrderCancelForShop(job?.shop)) {
    logEvent("fraud_order_cancel_poll_skipped", {
      shop: job?.shop,
      shopifyOrderId,
      reason: "fraud_order_cancel_disabled",
    });
    return { status: "SKIPPED", reason: "fraud_order_cancel_disabled" };
  }
  if (!isValidShopifyOrderGid(shopifyOrderId)) {
    return { status: "SKIPPED", reason: "invalid_shopify_order_id" };
  }
  if (isBlockedFraudOrderCancelRef(shopifyOrderId)) {
    return { status: "SKIPPED", reason: "blocked_test_order" };
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
  if (isBlockedFraudOrderCancelRef(assessment.orderName)) {
    return { status: "SKIPPED", reason: "blocked_test_order" };
  }
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

export function canUseFraudOrderRestockForShop(shop) {
  if (!canUseFraudOrderCancelForShop(shop)) return false;
  if (String(process.env.FRAUD_ORDER_RESTOCK_ENABLED || "") !== "true") return false;
  return true;
}

export function canUseFraudOrderRefundForShop(shop) {
  if (!canUseFraudOrderCancelForShop(shop)) return false;
  if (String(process.env.FRAUD_ORDER_REFUND_ENABLED || "") !== "true") return false;
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
  if (assessment?.cancellationStatus) return { allowed: false, reason: "fraud_order_cancel_already_recorded" };
  if (isBlockedFraudOrderCancelRef(orderName) || isBlockedFraudOrderCancelRef(shopifyOrderId)) {
    return { allowed: false, reason: "blocked_test_order" };
  }
  if (!isValidShopifyOrderGid(shopifyOrderId)) return { allowed: false, reason: "invalid_shopify_order_id" };
  return { allowed: true, reason: "eligible" };
}

export function getFraudOrderRestockOption({ shop, order, fraudAssessment, shouldBlockZinc }) {
  const result = fraudAssessment?.result;
  const assessment = result?.assessment;
  const orderName = String(order?.name || assessment?.orderName || "").trim();
  const shopifyOrderId = String(order?.id || assessment?.shopifyOrderId || "").trim();

  if (!canUseFraudOrderRestockForShop(shop)) return false;
  if (!result?.config?.restockInventory) return false;
  if (fraudAssessment?.skipped) return false;
  if (result?.riskLevel !== "HIGH") return false;
  if (!shouldBlockZinc) return false;
  if (!isValidShopifyOrderGid(shopifyOrderId)) return false;
  if (isBlockedFraudOrderCancelRef(orderName) || isBlockedFraudOrderCancelRef(shopifyOrderId)) return false;
  return orderHasRestockTestVariant(order);
}

export function getFraudOrderRefundOption({ shop, order, fraudAssessment, shouldBlockZinc }) {
  const result = fraudAssessment?.result;
  const assessment = result?.assessment;
  const orderName = String(order?.name || assessment?.orderName || "").trim();
  const shopifyOrderId = String(order?.id || assessment?.shopifyOrderId || "").trim();

  if (!canUseFraudOrderRefundForShop(shop)) return false;
  if (!result?.config?.refundPayment) return false;
  if (result?.config?.dryRun) return false;
  if (fraudAssessment?.skipped) return false;
  if (result?.riskLevel !== "HIGH") return false;
  if (!shouldBlockZinc) return false;
  if (!isValidShopifyOrderGid(shopifyOrderId)) return false;
  if (isBlockedFraudOrderCancelRef(orderName) || isBlockedFraudOrderCancelRef(shopifyOrderId)) return false;
  return true;
}

export function isBlockedFraudOrderCancelRef(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  return FRAUD_ORDER_CANCEL_BLOCKED_ORDER_REFS.has(normalized);
}

function orderHasRestockTestVariant(order) {
  const lineItems = order?.lineItems?.nodes || [];
  return lineItems.some((line) => line?.variant?.id === DEV_RESTOCK_TEST_VARIANT_ID);
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
  if (isProductionRuntime()) return;
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
  shop,
  enabled,
  dryRun,
  autoCancelHighRisk,
  autoCancelMediumRisk,
  blockZincOnHighRisk,
  restockInventory,
  refundPayment,
}) {
  return {
    enabled: Boolean(enabled),
    dryRun: true,
    autoCancelHighRisk: Boolean(enabled && autoCancelHighRisk),
    autoCancelMediumRisk: false,
    blockZincOnHighRisk: Boolean(enabled && blockZincOnHighRisk),
    cancelReason: "FRAUD",
    restockInventory: Boolean(enabled && restockInventory && canUseFraudOrderRestockForShop(shop)),
    refundPayment: Boolean(enabled && refundPayment && canUseFraudOrderRefundForShop(shop)),
    notifyCustomer: false,
    delayMinutes: 2,
  };
}

function assertCanEnableDevFraudRefundE2EConfig({ shop, targetShop, confirm }) {
  assertDevFraudRefundE2EShop(shop);
  assertDevFraudRefundE2ERuntime({ shop, targetShop });
  if (String(confirm || "") !== "true") {
    throw new Error("CONFIRM_DEV_REFUND_E2E must be true.");
  }
}

function assertCanDisableDevFraudRefundE2EConfig({ shop, targetShop, confirm }) {
  assertDevFraudRefundE2EShop(shop);
  assertDevFraudRefundE2ERuntime({ shop, targetShop });
  if (String(confirm || "") !== "true") {
    throw new Error("CONFIRM_DISABLE_DEV_REFUND_E2E must be true.");
  }
}

function assertDevFraudRefundE2ERuntime({ shop, targetShop }) {
  if (String(targetShop || "").trim().toLowerCase() !== DEV_FRAUD_ORDER_CANCEL_SHOP) {
    throw new Error("TARGET_SHOP must be pickvora-dev.myshopify.com.");
  }
  if (isProductionRuntime()) {
    throw new Error("Refusing to change dev refund E2E config in production runtime.");
  }
  if (String(process.env.FRAUD_ORDER_CANCEL_ENABLED || "") !== "true") {
    throw new Error("FRAUD_ORDER_CANCEL_ENABLED must be true.");
  }
  if (String(process.env.FRAUD_ORDER_REFUND_ENABLED || "") !== "true") {
    throw new Error("FRAUD_ORDER_REFUND_ENABLED must be true.");
  }

  const customDomain = String(process.env.SHOP_CUSTOM_DOMAIN || "").trim().toLowerCase();
  if (customDomain === DEV_FRAUD_ORDER_CANCEL_SHOP || customDomain === PRODUCTION_SHOP) {
    throw new Error("Refusing to enable dev refund E2E config when SHOP_CUSTOM_DOMAIN is protected.");
  }
  if (!canUseFraudOrderRefundForShop(shop)) {
    throw new Error("Fraud order refund guard is not enabled for the target shop.");
  }
}

function assertDevFraudRefundE2EShop(shop) {
  if (String(shop || "").trim().toLowerCase() !== DEV_FRAUD_ORDER_CANCEL_SHOP) {
    throw new Error("Dev refund E2E config can only target pickvora-dev.myshopify.com.");
  }
}

function buildDevFraudRefundE2EConfigData() {
  return { ...DEV_FRAUD_REFUND_E2E_CONFIG };
}

function buildDevFraudRefundE2ERollbackConfigData() {
  return { ...DEV_FRAUD_REFUND_E2E_ROLLBACK_CONFIG };
}

export function pickSafeFraudProtectionConfigFields(config) {
  return {
    shop: config?.shop || null,
    enabled: Boolean(config?.enabled),
    dryRun: Boolean(config?.dryRun),
    autoCancelHighRisk: Boolean(config?.autoCancelHighRisk),
    autoCancelMediumRisk: Boolean(config?.autoCancelMediumRisk),
    blockZincOnHighRisk: Boolean(config?.blockZincOnHighRisk),
    restockInventory: Boolean(config?.restockInventory),
    refundPayment: Boolean(config?.refundPayment),
    notifyCustomer: Boolean(config?.notifyCustomer),
  };
}

async function getFraudProtectionConfigWithClient(shop, prismaClient) {
  const config = await prismaClient.fraudProtectionConfig.findUnique({ where: { shop } });
  return config || { shop, ...DEFAULT_FRAUD_PROTECTION_CONFIG };
}
