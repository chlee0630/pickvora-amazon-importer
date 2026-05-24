const API_VERSION = "2025-10";
const DEFAULT_TIMEOUT_MS = 30000;

class ShopifyFulfillmentError extends Error {
  constructor(message, { retryable = false, statusCode = null, responsePayload = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.responsePayload = responsePayload;
  }
}

async function adminFetch(shop, accessToken, query, variables = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
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

    const data = await res.json();
    if (!res.ok) {
      throw new ShopifyFulfillmentError(`Shopify API returned ${res.status}`, {
        retryable: [429, 500, 502, 503].includes(res.status),
        statusCode: res.status,
        responsePayload: data,
      });
    }
    if (data.errors?.length) {
      throw new ShopifyFulfillmentError(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`, {
        retryable: false,
        responsePayload: data,
      });
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ShopifyFulfillmentError("Shopify fulfillment request timed out", {
        retryable: true,
        statusCode: "TIMEOUT",
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchFulfillmentContext(shop, accessToken, shopifyOrderId) {
  const res = await adminFetch(shop, accessToken, `
    query fulfillmentContext($id: ID!) {
      order(id: $id) {
        id
        displayFulfillmentStatus
        fulfillments(first: 20) {
          id
          status
          trackingInfo {
            number
            company
            url
          }
        }
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            lineItems(first: 100) {
              nodes {
                id
                remainingQuantity
              }
            }
          }
        }
      }
    }
  `, { id: shopifyOrderId });

  return res.data?.order || null;
}

export function hasMatchingFulfillment(order, tracking) {
  const normalizedTrackingNumber = normalizeTrackingValue(tracking.trackingNumber);
  const normalizedCarrier = normalizeTrackingValue(tracking.carrier);

  return (order?.fulfillments || []).some((fulfillment) =>
    (fulfillment.trackingInfo || []).some((item) =>
      normalizeTrackingValue(item.number) === normalizedTrackingNumber &&
      normalizeTrackingValue(item.company) === normalizedCarrier
    )
  );
}

export function buildFulfillmentInput(order, tracking) {
  const lineItemsByFulfillmentOrder = (order.fulfillmentOrders?.nodes || [])
    .filter((fulfillmentOrder) => ["OPEN", "IN_PROGRESS"].includes(fulfillmentOrder.status))
    .map((fulfillmentOrder) => ({
      fulfillmentOrderId: fulfillmentOrder.id,
      fulfillmentOrderLineItems: fulfillmentOrder.lineItems.nodes
        .filter((lineItem) => lineItem.remainingQuantity > 0)
        .map((lineItem) => ({
          id: lineItem.id,
          quantity: lineItem.remainingQuantity,
        })),
    }))
    .filter((entry) => entry.fulfillmentOrderLineItems.length > 0);

  if (lineItemsByFulfillmentOrder.length === 0) {
    throw new ShopifyFulfillmentError("No fulfillable Shopify fulfillment order line items found", {
      retryable: false,
    });
  }

  return {
    lineItemsByFulfillmentOrder,
    trackingInfo: {
      number: tracking.trackingNumber,
      company: tracking.carrier,
      url: tracking.trackingUrl || undefined,
    },
    notifyCustomer: true,
  };
}

export async function createTrackingFulfillment(shop, accessToken, fulfillmentInput) {
  const res = await adminFetch(shop, accessToken, `
    mutation createTrackingFulfillment($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo {
            number
            company
            url
          }
        }
        userErrors { field message }
      }
    }
  `, { fulfillment: fulfillmentInput });

  const userErrors = res.data?.fulfillmentCreate?.userErrors || [];
  if (userErrors.length) {
    throw new ShopifyFulfillmentError(`Shopify fulfillment validation failed: ${JSON.stringify(userErrors)}`, {
      retryable: false,
      responsePayload: res,
    });
  }

  return {
    fulfillment: res.data?.fulfillmentCreate?.fulfillment || null,
    responsePayload: res,
  };
}

function normalizeTrackingValue(value) {
  return String(value || "").trim().toUpperCase();
}
