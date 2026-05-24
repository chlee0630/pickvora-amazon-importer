const ZINC_API_BASE_URL = "https://api.zinc.io/v1";
const DEFAULT_TIMEOUT_MS = 30000;

function getZincConfig() {
  // eslint-disable-next-line no-undef
  const apiKey = process.env.ZINC_API_KEY;
  if (!apiKey) throw new Error("ZINC_API_KEY is not configured");

  return {
    apiKey,
    // eslint-disable-next-line no-undef
    retailer: process.env.ZINC_RETAILER || "amazon",
    // eslint-disable-next-line no-undef
    maxPriceCents: Number(process.env.ZINC_MAX_PRICE_CENTS || 0) || null,
  };
}

async function zincFetch(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { apiKey } = getZincConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${ZINC_API_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const message = data?.message || data?.error || `Zinc API returned ${res.status}`;
      const error = new Error(message);
      error.statusCode = res.status;
      error.retryable = [429, 500, 502, 503].includes(res.status);
      throw error;
    }

    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      err.retryable = true;
      err.code = "TIMEOUT";
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  if (["delivered", "shipped", "complete", "completed"].includes(status)) return "shipped";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["failed", "error"].includes(status)) return "failed";
  return status || "submitted";
}

function extractTracking(data) {
  const shipment = data?.shipments?.[0] || data?.shipment || data;
  const tracking = shipment?.tracking || shipment?.tracking_info || shipment;
  return {
    trackingNumber: tracking?.tracking_number || tracking?.number || data?.tracking_number || null,
    trackingUrl: tracking?.tracking_url || tracking?.url || data?.tracking_url || null,
    trackingCompany: tracking?.carrier || tracking?.company || data?.carrier || "Amazon",
  };
}

export function createZincProvider() {
  return {
    name: "zinc",

    async createOrder(orderInput) {
      const config = getZincConfig();
      const payload = {
        retailer: config.retailer,
        products: orderInput.items.map((item) => ({
          product_id: item.asin,
          quantity: item.quantity,
        })),
        shipping_address: orderInput.shippingAddress,
        is_gift: false,
        client_notes: {
          shop: orderInput.shop,
          shopify_order_id: orderInput.shopifyOrderId,
        },
      };

      if (config.maxPriceCents) {
        payload.max_price = config.maxPriceCents;
      }

      const response = await zincFetch("/orders", { method: "POST", body: payload });
      return {
        providerOrderId: response.request_id || response.order_id || response.id || null,
        status: normalizeStatus(response.status),
        requestPayload: payload,
        responsePayload: response,
      };
    },

    async getOrderStatus(providerOrderId) {
      const response = await zincFetch(`/orders/${providerOrderId}`);
      return {
        status: normalizeStatus(response.status),
        responsePayload: response,
      };
    },

    async getTracking(providerOrderId) {
      const response = await zincFetch(`/orders/${providerOrderId}`);
      return {
        status: normalizeStatus(response.status),
        ...extractTracking(response),
        responsePayload: response,
      };
    },

    async cancelOrder(providerOrderId) {
      const response = await zincFetch(`/orders/${providerOrderId}/cancel`, { method: "POST" });
      return {
        status: normalizeStatus(response.status),
        responsePayload: response,
      };
    },
  };
}
