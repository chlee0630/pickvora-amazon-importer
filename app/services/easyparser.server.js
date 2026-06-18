import { withApiRetry, truncateLogPayload } from "../utils/api-retry.server.js";
import { getScalingConfig } from "../utils/scaling-config.server.js";

const BASE_URL = "https://realtime.easyparser.com/v1/request";
const DEFAULT_DOMAIN = ".com";
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

export function buildEasyParserDetailUrl(asin, env = process.env) {
  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", env.EASYPARSER_API_KEY || "");
  url.searchParams.set("platform", "AMZ");
  url.searchParams.set("operation", "DETAIL");
  url.searchParams.set("domain", env.EASYPARSER_DOMAIN || DEFAULT_DOMAIN);
  url.searchParams.set("asin", asin);
  return url;
}

export function redactEasyParserUrl(url) {
  const redacted = new URL(url.toString());
  if (redacted.searchParams.has("api_key")) {
    redacted.searchParams.set("api_key", "[masked]");
  }
  return redacted.toString();
}

async function requestProductDetail(asin) {
  if (!process.env.EASYPARSER_API_KEY) {
    throw new Error("EasyParser API key is not configured");
  }

  const url = buildEasyParserDetailUrl(asin);
  const { easyparserTimeoutMs, easyparserMaxRetries } = getScalingConfig();

  return withApiRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), easyparserTimeoutMs);

    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};

      if (!res.ok) {
        const error = new Error(`EasyParser API ${res.status}: ${truncateLogPayload(data)}`);
        error.statusCode = res.status;
        error.retryAfter = res.headers.get("retry-after");
        error.retryable = RETRYABLE_STATUSES.includes(res.status);
        throw error;
      }

      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        err.code = "TIMEOUT";
        err.retryable = true;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }, {
    provider: "easyparser",
    operationName: "DETAIL",
    maxAttempts: easyparserMaxRetries + 1,
  });
}

export async function fetchProductDetails(asin) {
  const data = await requestProductDetail(asin);
  return normalizeEasyParserProduct(data, asin);
}

export function normalizeEasyParserProduct(data, requestedAsin) {
  const product = getProductPayload(data);
  if (!product) throw new Error(`Product not found for ASIN: ${requestedAsin}`);

  const asin = getFirstValue(product, ["asin", "ASIN"]) || requestedAsin;
  const title = getFirstValue(product, ["title", "name", "product_title"]);
  if (!title) throw new Error(`Product title not found for ASIN: ${asin}`);

  const buybox = getFirstObject(product, ["buybox_winner", "buybox", "buy_box"]) || {};
  const price = getPriceValue(
    getFirstValue(buybox, ["price", "buybox_price"]) ??
    getFirstValue(product, ["price", "current_price", "buybox_price"])
  );
  const salePrice = getPriceValue(getFirstValue(product, ["rrp", "list_price", "was_price"]));
  const shippingPrice = getPriceValue(
    getFirstValue(buybox, ["shipping", "shipping_price"]) ??
    getFirstValue(product, ["shipping", "shipping_price"])
  ) ?? 0;
  const availabilityStatus = getAvailabilityStatus(product, buybox);
  const inStock = availabilityStatus === "in_stock";
  const images = normalizeImages(product);
  const featureBullets = normalizeStringList(getFirstValue(product, [
    "feature_bullets",
    "features",
    "bullets",
    "featureBullets",
  ]));
  const reviews = normalizeReviews(getFirstValue(product, ["top_reviews", "reviews"]));
  const reviewSummary = normalizeReviewSummary(product);

  return {
    asin,
    title,
    brand: getFirstValue(product, ["brand", "manufacturer"]) || null,
    category: normalizeCategories(getFirstValue(product, ["categories", "category", "breadcrumbs"])),
    description: getFirstValue(product, ["description", "product_description"]) || "",
    featureBullets: JSON.stringify(featureBullets),
    price,
    salePrice,
    inStock,
    stockQuantity: getFirstValue(buybox, ["stock_level", "stockQuantity", "stock_quantity"]) ?? null,
    outOfStock: !inStock,
    availabilityStatus,
    cannotBeShipped: availabilityStatus === "cannot_be_shipped",
    shippingUnavailableReason: getShippingUnavailableReason(product, buybox),
    shippingPrice,
    primeEligible: Boolean(
      getFirstValue(buybox, ["is_prime", "prime", "prime_eligible"]) ??
      getFirstValue(product, ["is_prime", "prime", "prime_eligible"])
    ),
    mainImage: getMainImage(product, images),
    images: JSON.stringify(images),
    variants: JSON.stringify(normalizeVariants(product, asin, title)),
    rating: reviewSummary.rating,
    ratingsTotal: reviewSummary.ratingsTotal,
    reviewsUpdatedAt: reviewSummary.updatedAt,
    reviews: JSON.stringify(reviews),
    bestsellRank: normalizeRank(getFirstValue(product, ["bestsellers_rank", "bestseller_rank", "rank"])),
    amazonUrl: getFirstValue(product, ["link", "url", "amazon_url"]) || buildAmazonUrl(asin),
  };
}

function getProductPayload(data) {
  if (!data || typeof data !== "object") return null;
  return (
    data.product ||
    data.result?.product ||
    data.result?.detail ||
    data.results?.product ||
    data.data?.product ||
    data.data?.result?.product ||
    data.data?.result?.detail ||
    data.result ||
    data.data ||
    data
  );
}

function getFirstObject(source, keys) {
  const value = getFirstValue(source, keys);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function getFirstValue(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (source[key] != null) return source[key];
  }
  return null;
}

function getPriceValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    return getPriceValue(value.value ?? value.amount ?? value.raw ?? value.price);
  }
  const normalized = String(value).replace(/[^0-9.]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCategories(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value);
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      return item.name || item.title || item.label;
    })
    .filter(Boolean)
    .join(" > ");
}

function normalizeImages(product) {
  const rawImages = getFirstValue(product, ["images", "image_urls", "imageUrls"]) || [];
  const images = Array.isArray(rawImages) ? rawImages : [rawImages];
  return images
    .map((image) => {
      if (typeof image === "string") return image;
      return image?.link || image?.url || image?.src;
    })
    .filter(Boolean);
}

function getMainImage(product, images) {
  const mainImage = getFirstValue(product, ["main_image", "mainImage", "image"]);
  if (typeof mainImage === "string") return mainImage;
  return mainImage?.link || mainImage?.url || images[0] || null;
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [String(value)];
}

function normalizeReviews(value) {
  const reviews = Array.isArray(value) ? value : [];
  return reviews.slice(0, 10).map((review) => ({
    title: review.title,
    rating: parseRating(review.rating),
    body: review.body || review.text || review.content,
    date: review.date?.raw || review.date,
    author: review.profile?.name || review.author,
  }));
}

function normalizeReviewSummary(product) {
  const rating = parseRating(getFirstValue(product, ["rating", "stars", "review_rating"]));
  return {
    rating,
    ratingsTotal: parseRatingsTotal(getFirstValue(product, ["ratings_total", "reviews_count", "rating_count"])) ?? 0,
    updatedAt: rating != null ? new Date() : null,
  };
}

function parseRating(value) {
  if (value == null || value === "") return null;
  const rating = Number(String(value).match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return null;
  return Math.round(rating * 100) / 100;
}

function parseRatingsTotal(value) {
  if (value == null || value === "") return null;
  const count = Number(String(value).replace(/,/g, "").match(/\d+/)?.[0]);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function normalizeVariants(product, currentAsin, title) {
  const sourceVariants = getFirstValue(product, ["variants", "variation_asins", "variations"]) || [];
  if (!Array.isArray(sourceVariants)) return [];
  return sourceVariants
    .map((variant) => {
      const asin = variant.asin || variant.ASIN;
      if (!asin) return null;
      return {
        asin,
        title: variant.title || title,
        options: normalizeVariantOptions(variant.dimensions || variant.options || variant.attributes),
        price: getPriceValue(variant.price),
        image: variant.image?.link || variant.image?.url || variant.image || null,
        availability: getAvailabilityText(variant),
        isCurrent: Boolean(variant.is_current_product || asin === currentAsin),
      };
    })
    .filter((variant) => variant && variant.options.length > 0);
}

function normalizeVariantOptions(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === "string") return { name: `Option ${index + 1}`, value: item };
      const name = item.name || item.dimension || item.key || item.label;
      const optionValue = item.value || item.display_value || item.option;
      return name && optionValue ? { name: String(name), value: String(optionValue) } : null;
    }).filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([name, optionValue]) => ({
      name: String(name),
      value: String(typeof optionValue === "object" ? optionValue.value || optionValue.name : optionValue),
    })).filter((option) => option.value);
  }
  return [];
}

function getAvailabilityStatus(product, buybox) {
  if (hasCannotShipMessage(product) || hasCannotShipMessage(buybox)) return "cannot_be_shipped";

  const raw = normalizeStatusText([
    getAvailabilityText(buybox),
    getAvailabilityText(product),
    product.availability_status,
  ].filter(Boolean).join(" "));

  if (raw.includes("currently unavailable")) return "currently_unavailable";
  if (raw.includes("unavailable") || raw.includes("out of stock") || product.in_stock === false) return "unavailable";
  if (raw.includes("in stock") || buybox.availability?.in_stock === true || product.in_stock === true) return "in_stock";
  return "in_stock";
}

function getAvailabilityText(value) {
  const availability = value?.availability || value?.stock_status || value?.availability_status;
  if (!availability) return null;
  if (typeof availability === "string") return availability;
  return availability.raw || availability.type || availability.message || availability.text || null;
}

function getShippingUnavailableReason(product, buybox) {
  return findCannotShipMessage(product) || findCannotShipMessage(buybox) || null;
}

function hasCannotShipMessage(value) {
  return Boolean(findCannotShipMessage(value));
}

function findCannotShipMessage(value) {
  if (!value) return null;
  if (typeof value === "string") return isCannotShipText(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCannotShipMessage(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findCannotShipMessage(item);
      if (found) return found;
    }
  }
  return null;
}

function isCannotShipText(value) {
  const text = normalizeStatusText(value);
  return (
    text.includes("cannot be shipped to your selected location") ||
    text.includes("can't be shipped to your selected location") ||
    text.includes("cannot ship to your selected location") ||
    text.includes("not available for delivery to your location")
  );
}

function normalizeStatusText(value) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").trim();
}

function normalizeRank(value) {
  if (Array.isArray(value)) return normalizeRank(value[0]?.rank || value[0]);
  if (value && typeof value === "object") return normalizeRank(value.rank || value.value);
  const rank = Number(String(value || "").replace(/,/g, "").match(/\d+/)?.[0]);
  return Number.isInteger(rank) ? rank : null;
}

function buildAmazonUrl(asin) {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}
