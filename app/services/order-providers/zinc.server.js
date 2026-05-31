import { createHash } from "node:crypto";
import { trackApiCall } from "../monitoring/api-metrics.server.js";
import { normalizeProviderError } from "../../utils/provider-errors.server.js";
import { getZincConfig, requireZincApiKey } from "../../config/zinc.server.js";
import { withApiRetry, truncateLogPayload } from "../../utils/api-retry.server.js";
import { maskSensitivePayload } from "../../utils/failure-audit-log.server.js";

const ZINC_RETRY_POLICY = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

const TEST_SUCCESS_PRODUCT_URL = "https://zinc.com/shop/products/test-success";

async function zincFetch(path, { method = "GET", body, timeoutMs } = {}) {
  const zincConfig = getZincConfig();
  const apiKey = requireZincApiKey(zincConfig.apiKey);
  const requestPayload = body ? maskSensitivePayload(body) : null;

  return withApiRetry(() => trackApiCall("zinc", `${method} ${path}`, async () => {
    logZincEvent("zinc_request_started", {
      method,
      path,
      timeoutMs: timeoutMs || zincConfig.timeoutMs,
      requestPayload,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || zincConfig.timeoutMs);

    try {
      const res = await fetch(`${zincConfig.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      const data = text ? parseJsonResponse(text) : {};
      if (isZincErrorResponse(data)) {
        const error = buildZincResponseError(data, {
          statusCode: res.status,
          method,
          path,
          requestPayload,
        });
        logZincEvent("zinc_request_failed", {
          method,
          path,
          statusCode: res.status,
          errorCode: error.code,
          responsePayload: data,
          message: error.message,
        });
        throw error;
      }

      if (!res.ok) {
        const message = data?.message || data?.error || `Zinc API returned ${res.status}`;
        const error = new Error(message);
        error.statusCode = res.status;
        error.code = data?.code || data?.error_code || `ZINC_${res.status}`;
        error.retryable = [429, 500, 502, 503].includes(res.status);
        error.rawResponse = data;
        logZincEvent("zinc_request_failed", {
          method,
          path,
          statusCode: res.status,
          errorCode: error.code,
          responsePayload: data,
          message: error.message,
        });
        throw error;
      }

      logZincEvent("zinc_request_completed", {
        method,
        path,
        statusCode: res.status,
        responsePayload: data,
      });

      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        err.retryable = true;
        err.code = "TIMEOUT";
        logZincEvent("zinc_request_failed", {
          method,
          path,
          statusCode: "TIMEOUT",
          errorCode: err.code,
          message: "Zinc request timed out",
        });
      }
      throw normalizeProviderError(err, "zinc");
    } finally {
      clearTimeout(timeout);
    }
  }, { timeoutMs }), ZINC_RETRY_POLICY);
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
      const idempotencyKey = orderInput.idempotencyKey || buildZincIdempotencyKey(orderInput.shop, orderInput.shopifyOrderId);
      const payload = buildZincCreatePayload(orderInput, idempotencyKey, config);
      logZincEvent("zinc_idempotency_key_used", {
        shop: orderInput.shop,
        shopifyOrderId: orderInput.shopifyOrderId,
        idempotencyKey,
      });

      if (config.dryRun) {
        const dryRunResponse = {
          request_id: `dry_run_${orderInput.shopifyOrderId}`,
          status: "dry_run",
          dryRun: true,
        };

        logZincEvent("zinc_request_dry_run", {
          method: "POST",
          path: "/orders",
          requestPayload: payload,
          responsePayload: dryRunResponse,
        });

        return {
          providerOrderId: dryRunResponse.request_id,
          status: normalizeStatus(dryRunResponse.status),
          dryRun: true,
          requestPayload: maskSensitivePayload(payload),
          responsePayload: dryRunResponse,
        };
      }

      requireZincApiKey(config.apiKey);

      const response = await zincFetch("/orders", { method: "POST", body: payload });
      return {
        providerOrderId: response.request_id || response.order_id || response.id || null,
        status: normalizeStatus(response.status),
        requestPayload: maskSensitivePayload(payload),
        responsePayload: maskSensitivePayload(response),
      };
    },

    async getOrderStatus(providerOrderId) {
      const response = await zincFetch(`/orders/${providerOrderId}`);
      return {
        status: normalizeStatus(response.status),
        responsePayload: maskSensitivePayload(response),
      };
    },

    async getTracking(providerOrderId) {
      const response = await zincFetch(`/orders/${providerOrderId}`);
      return {
        status: normalizeStatus(response.status),
        ...extractTracking(response),
        responsePayload: maskSensitivePayload(response),
      };
    },

    async cancelOrder(providerOrderId) {
      const response = await zincFetch(`/orders/${providerOrderId}/cancel`, { method: "POST" });
      return {
        status: normalizeStatus(response.status),
        responsePayload: maskSensitivePayload(response),
      };
    },
  };
}

export function buildZincIdempotencyKey(shop, shopifyOrderId, action = "create") {
  const hash = createHash("sha256")
    .update(`${shop}:${shopifyOrderId}:zinc:${action}`)
    .digest("hex")
    .slice(0, 32);
  return `z:${hash}`;
}

export function buildZincCreatePayload(orderInput, idempotencyKey, config = getZincConfig()) {
  const shippingAddress = buildZincShippingAddress(orderInput.shippingAddress);
  const maxPriceCents = resolveMaxPriceCents(orderInput, config);
  const payload = {
    retailer: config.retailer,
    products: orderInput.items.map((item) => buildZincProduct(item)),
    shipping_address: shippingAddress,
    is_gift: false,
    client_notes: {
      shop: orderInput.shop,
      shopify_order_id: orderInput.shopifyOrderId,
    },
    idempotency_key: idempotencyKey,
    max_price: maxPriceCents,
  };

  return payload;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: truncateLogPayload(text) };
  }
}

export function isZincErrorResponse(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      (data._type === "error" || data.error || data.error_code)
  );
}

export function buildZincResponseError(data, { statusCode, method, path, requestPayload } = {}) {
  const errorPayload = data?.error && typeof data.error === "object" ? data.error : data;
  const sanitizedPayload = sanitizeSensitiveStrings(data);
  const error = new Error(
    sanitizeSensitiveText(
      errorPayload?.message ||
        data?.message ||
      data?.error ||
        `Zinc API returned an error response`
    )
  );
  error.statusCode = Number.isFinite(statusCode) ? statusCode : 200;
  error.code = errorPayload?.code || data?.error_code || data?.code || "ZINC_RESPONSE_ERROR";
  error.retryable = false;
  error.manualReviewRequired = true;
  error.rawResponse = sanitizedPayload;
  error.responsePayload = sanitizedPayload;
  error.method = method;
  error.path = path;
  error.requestPayload = requestPayload;
  return normalizeProviderError(error, "zinc");
}

export function buildZincProduct(item) {
  const asin = normalizeAsin(item?.asin);
  if (!asin) {
    throw createManualReviewError("Invalid or missing ASIN for Zinc product payload");
  }

  const productUrl = normalizeAmazonProductUrl(item?.amazonUrl, asin);
  if (!productUrl) {
    throw createManualReviewError("Invalid Amazon product URL for Zinc product payload");
  }

  const product = {
    url: productUrl,
    quantity: item.quantity,
  };

  if (item.variantId) {
    product.variant_id = item.variantId;
  }

  return product;
}

function normalizeAsin(value) {
  const text = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(text) ? text : null;
}

export function buildZincShippingAddress(address) {
  const postalCode = normalizePostalCode(
    address?.postal_code || address?.postalCode || address?.zip || address?.zipCode || address?.zip_code
  );
  const normalized = {
    first_name: String(address?.first_name || address?.firstName || "").trim(),
    last_name: String(address?.last_name || address?.lastName || "").trim(),
    address_line1: String(address?.address_line1 || address?.addressLine1 || address?.address1 || "").trim(),
    address_line2: String(address?.address_line2 || address?.addressLine2 || address?.address2 || "").trim() || undefined,
    city: String(address?.city || "").trim(),
    state: normalizeStateCode(address?.state || address?.province || address?.provinceCode || ""),
    postal_code: postalCode,
    country: normalizeCountryCode(address?.country || address?.countryCodeV2 || address?.country_code || "US"),
    phone_number: String(address?.phone_number || address?.phoneNumber || address?.phone || "").trim(),
  };

  if (!normalized.first_name || !normalized.last_name || !normalized.address_line1 || !normalized.city || !normalized.state || !normalized.postal_code || !normalized.phone_number || !normalized.country) {
    throw createManualReviewError("Missing required Zinc shipping address fields");
  }

  if (normalized.country !== "US") {
    throw createManualReviewError("Unsupported destination for Zinc order");
  }

  return normalized;
}

export function resolveMaxPriceCents(orderInput, config = getZincConfig()) {
  const configured = Number.isFinite(config?.maxPriceCents) && config.maxPriceCents > 0
    ? Math.round(config.maxPriceCents)
    : null;
  if (configured) return configured;

  const itemTotals = (orderInput?.items || []).map((item) => {
    const unit = Number.isFinite(item?.maxPriceCents) && item.maxPriceCents > 0
      ? Math.round(item.maxPriceCents)
      : null;
    if (!unit) return null;
    const quantity = Number.parseInt(String(item.quantity || 0), 10);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    return unit * quantity;
  });

  if (itemTotals.some((value) => value == null)) {
    throw createManualReviewError("Missing max price for Zinc order");
  }

  const total = itemTotals.reduce((sum, value) => sum + value, 0);
  if (!Number.isInteger(total) || total <= 0) {
    throw createManualReviewError("Missing max price for Zinc order");
  }

  return total;
}

export function normalizeAmazonProductUrl(value, asin) {
  const candidate = String(value || "").trim();
  if (!candidate) {
    return `https://www.amazon.com/dp/${asin}`;
  }

  if (isAllowedTestSuccessProductUrl(candidate)) {
    return TEST_SUCCESS_PRODUCT_URL;
  }

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    if (!host.includes("amazon.")) return null;
    if (url.pathname.includes("/dp/") || url.pathname.includes("/gp/product/")) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAllowedTestSuccessProductUrl(value) {
  return String(value || "").trim() === TEST_SUCCESS_PRODUCT_URL
    && process.env.NODE_ENV !== "production"
    && process.env.ZINC_ALLOW_TEST_PRODUCT_URL === "true"
    && String(process.env.ZINC_API_KEY || "").trim().startsWith("zn_test_");
}

function normalizePostalCode(value) {
  return String(value || "").trim();
}

function normalizeStateCode(value) {
  const state = String(value || "").trim().toUpperCase();
  if (!state) return "";
  if (state.length === 2) return state;

  const map = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    NEW_HAMPSHIRE: "NH",
    NEW_JERSEY: "NJ",
    NEW_MEXICO: "NM",
    NEW_YORK: "NY",
    NORTH_CAROLINA: "NC",
    NORTH_DAKOTA: "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    RHODE_ISLAND: "RI",
    SOUTH_CAROLINA: "SC",
    SOUTH_DAKOTA: "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    WEST_VIRGINIA: "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
  };

  return map[state.replace(/\s+/g, "_")] || "";
}

function normalizeCountryCode(value) {
  const country = String(value || "").trim().toUpperCase();
  if (!country) return "";
  if (country === "US" || country === "USA" || country === "UNITED STATES") return "US";
  return country;
}

function createManualReviewError(message) {
  const error = new Error(message);
  error.code = "ZINC_PAYLOAD_INVALID";
  error.retryable = false;
  error.manualReviewRequired = true;
  return error;
}

function sanitizeSensitiveStrings(value) {
  if (Array.isArray(value)) return value.map(sanitizeSensitiveStrings);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeSensitiveText(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeSensitiveStrings(item)])
  );
}

function sanitizeSensitiveText(value) {
  return String(value || "").replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    "[masked]"
  );
}

function logZincEvent(event, details = {}) {
  console.log(JSON.stringify(maskSensitivePayload({
    event,
    layer: "zinc_provider",
    timestamp: new Date().toISOString(),
    ...details,
  })));
}
