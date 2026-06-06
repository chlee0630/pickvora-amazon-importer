import prisma from "../db.server.js";
import { withApiRetry } from "../utils/api-retry.server.js";
import { trackApiCall } from "./monitoring/api-metrics.server.js";

const API_VERSION = "2025-10";
const DEFAULT_TIMEOUT_MS = 30000;

export const DEFAULT_FRAUD_PROTECTION_CONFIG = {
  enabled: false,
  dryRun: true,
  autoCancelHighRisk: false,
  autoCancelMediumRisk: false,
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

async function adminFetch(shop, accessToken, query, variables = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return withApiRetry(() => trackApiCall("shopify", "fraud_risk_fetch", async () => {
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
    operationName: "fraud_risk_fetch",
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
  updatedBy,
}, deps = {}) {
  if (!shop) throw new Error("Shop is required to update fraud protection config.");

  const prismaClient = deps.prismaClient || prisma;
  const safeConfig = sanitizeFraudProtectionConfig({
    enabled,
    dryRun,
    autoCancelHighRisk,
    autoCancelMediumRisk,
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
}) {
  return {
    enabled: Boolean(enabled),
    dryRun: true,
    autoCancelHighRisk: Boolean(enabled && autoCancelHighRisk),
    autoCancelMediumRisk: false,
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
