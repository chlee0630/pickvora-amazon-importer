const API_VERSION = "2025-10";

async function adminFetch(shop, accessToken, query, variables = {}) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
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
