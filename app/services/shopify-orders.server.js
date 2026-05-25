const API_VERSION = "2025-10";
const DEFAULT_TIMEOUT_MS = 30000;
import { trackApiCall } from "./monitoring/api-metrics.server.js";

async function adminFetch(shop, accessToken, query, variables = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return trackApiCall("shopify", "fetch_order", async () => {
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
        error.retryable = [429, 500, 502, 503].includes(res.status);
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
  }, { shop, timeoutMs });
}

export async function fetchShopifyOrder(shop, accessToken, shopifyOrderId) {
  const res = await adminFetch(shop, accessToken, `
    query orderForProvider($id: ID!) {
      order(id: $id) {
        id
        name
        cancelledAt
        displayFulfillmentStatus
        shippingAddress {
          firstName
          lastName
          address1
          address2
          city
          provinceCode
          countryCodeV2
          zip
          phone
        }
        lineItems(first: 100) {
          nodes {
            id
            quantity
            sku
            variant {
              id
              metafield(namespace: "amazon", key: "asin") { value }
            }
            product { id }
          }
        }
      }
    }
  `, { id: shopifyOrderId });

  if (res.errors?.length) {
    throw new Error(`Shopify order fetch failed: ${JSON.stringify(res.errors)}`);
  }

  return res.data?.order || null;
}
