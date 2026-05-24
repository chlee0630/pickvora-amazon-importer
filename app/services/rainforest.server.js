const RAINFOREST_API_KEY = process.env.RAINFOREST_API_KEY;
const BASE_URL = "https://api.rainforestapi.com/request";
const AMAZON_DOMAIN = "amazon.com";

async function request(params) {
  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", RAINFOREST_API_KEY);
  url.searchParams.set("amazon_domain", AMAZON_DOMAIN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rainforest API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function fetchProductDetails(asin) {
  const data = await request({ type: "product", asin, variant_prices: "true" });
  const p = data.product;
  if (!p) throw new Error(`Product not found for ASIN: ${asin}`);

  const buybox = p.buybox_winner || {};
  const priceVal = buybox.price?.value ?? p.price?.value ?? null;
  const salePriceVal = p.rrp?.value ?? null;
  const shippingVal = buybox.shipping?.price?.value ?? 0;
  const availabilityStatus = getAvailabilityStatus(p, buybox);
  const inStock = availabilityStatus === "in_stock";
  const stockQty = buybox.stock_level ?? null;

  const categories = (p.categories || []).map((c) => c.name).join(" > ");
  const bestsellRank =
    p.bestsellers_rank?.[0]?.rank ?? p.rank ?? null;

  const images = (p.images || []).map((img) => img.link).filter(Boolean);
  const featureBullets = p.feature_bullets || [];

  const reviews = (p.top_reviews || []).slice(0, 10).map((r) => ({
    title: r.title,
    rating: r.rating,
    body: r.body,
    date: r.date?.raw,
    author: r.profile?.name,
  }));

  const variants = normalizeVariants(p);

  return {
    asin: p.asin,
    title: p.title,
    brand: p.brand,
    category: categories,
    description: p.description || "",
    featureBullets: JSON.stringify(featureBullets),
    price: priceVal,
    salePrice: salePriceVal,
    inStock,
    stockQuantity: stockQty,
    outOfStock: !inStock,
    availabilityStatus,
    cannotBeShipped: availabilityStatus === "cannot_be_shipped",
    shippingUnavailableReason: getShippingUnavailableReason(p, buybox),
    shippingPrice: shippingVal,
    primeEligible: buybox.fulfillment?.is_sold_by_amazon ?? false,
    mainImage: p.main_image?.link ?? images[0] ?? null,
    images: JSON.stringify(images),
    variants: JSON.stringify(variants),
    rating: p.rating,
    ratingsTotal: p.ratings_total,
    reviews: JSON.stringify(reviews),
    bestsellRank,
    amazonUrl: p.link,
  };
}

function getAvailabilityStatus(product, buybox) {
  if (hasCannotShipMessage(product) || hasCannotShipMessage(buybox)) {
    return "cannot_be_shipped";
  }

  const type = normalizeStatusText(buybox.availability?.type);
  const raw = normalizeStatusText(buybox.availability?.raw);
  const productAvailability = normalizeStatusText(product.availability?.type || product.availability?.raw);

  if (
    type.includes("currently unavailable") ||
    raw.includes("currently unavailable") ||
    productAvailability.includes("currently unavailable")
  ) {
    return "currently_unavailable";
  }

  if (
    type.includes("unavailable") ||
    raw.includes("unavailable") ||
    productAvailability.includes("unavailable") ||
    buybox.availability?.in_stock === false ||
    product.in_stock === false
  ) {
    return "unavailable";
  }

  if (type === "in stock" || buybox.availability?.in_stock === true || product.in_stock === true) {
    return "in_stock";
  }

  return "in_stock";
}

function getShippingUnavailableReason(product, buybox) {
  return findCannotShipMessage(product) || findCannotShipMessage(buybox) || null;
}

function hasCannotShipMessage(value) {
  return Boolean(findCannotShipMessage(value));
}

function findCannotShipMessage(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return isCannotShipText(value) ? value : null;
  }
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

function normalizeVariants(product) {
  const sourceVariants = Array.isArray(product.variants) ? product.variants : [];
  const variants = sourceVariants
    .map((variant) => normalizeVariant(variant, product))
    .filter((variant) => variant.asin && variant.options.length > 0);

  if (
    variants.length === 0 ||
    variants.some((variant) => variant.asin === product.asin)
  ) {
    return variants;
  }

  const currentOptions = variants[0]?.options.map((option) => ({
    name: option.name,
    value: option.value,
  })) || [];

  if (currentOptions.length === 0) return variants;

  return [
    normalizeVariant(
      {
        asin: product.asin,
        title: product.title,
        dimensions: currentOptions,
        price: product.price,
        image: product.main_image,
        availability: product.availability,
        is_current_product: true,
      },
      product,
    ),
    ...variants,
  ];
}

function normalizeVariant(variant, product) {
  const options = normalizeVariantOptions(variant.dimensions || variant.options || variant.attributes);
  const image = variant.image?.link || variant.image || variant.main_image?.link || variant.main_image || null;
  const price = variant.price?.value ?? variant.buybox_winner?.price?.value ?? null;
  const availability = getVariantAvailabilityText(variant);

  return {
    asin: variant.asin,
    title: variant.title || product.title,
    options,
    price,
    image,
    availability,
    isCurrent: Boolean(variant.is_current_product || variant.asin === product.asin),
  };
}

function getVariantAvailabilityText(variant) {
  const availability = variant.availability || variant.buybox_winner?.availability || null;
  if (!availability) return null;
  if (typeof availability === "string") return availability;
  return availability.raw || availability.type || availability.message || null;
}

function normalizeVariantOptions(dimensions) {
  if (!dimensions) return [];

  if (Array.isArray(dimensions)) {
    return dimensions
      .map((item, index) => {
        if (typeof item === "string") {
          return { name: `Option ${index + 1}`, value: item };
        }
        const name = item.name || item.dimension || item.key || item.label;
        const value = item.value || item.display_value || item.option || item.name;
        return name && value ? { name: String(name), value: String(value) } : null;
      })
      .filter(Boolean);
  }

  if (typeof dimensions === "object") {
    return Object.entries(dimensions)
      .map(([name, value]) => {
        const optionValue = typeof value === "object"
          ? value.value || value.name || value.display_value || value.label
          : value;
        return optionValue ? { name: String(name), value: String(optionValue) } : null;
      })
      .filter(Boolean);
  }

  return [];
}

export async function fetchBestSellers(categoryId = null) {
  const params = { type: "bestsellers" };
  if (categoryId) params.category_id = categoryId;
  const data = await request(params);
  return (data.bestsellers || []).map(mapListItem);
}

export async function fetchMostWishedFor(categoryId = null) {
  const params = { type: "most_wished_for" };
  if (categoryId) params.category_id = categoryId;
  const data = await request(params);
  return (data.most_wished_for || data.bestsellers || []).map(mapListItem);
}

export async function fetchNewReleases(categoryId = null) {
  const params = { type: "new_releases" };
  if (categoryId) params.category_id = categoryId;
  const data = await request(params);
  return (data.new_releases || data.bestsellers || []).map(mapListItem);
}

function mapListItem(item) {
  return {
    position: item.position,
    asin: item.asin,
    title: item.title,
    link: item.link,
    image: item.image,
    price: item.price?.value ?? null,
    rating: item.rating,
    ratingsTotal: item.ratings_total,
  };
}

export const AMAZON_CATEGORIES = [
  { label: "Electronics", id: "172282" },
  { label: "Books", id: "283155" },
  { label: "Home & Kitchen", id: "1055398" },
  { label: "Clothing", id: "7141123011" },
  { label: "Sports & Outdoors", id: "3375251" },
  { label: "Toys & Games", id: "165793011" },
  { label: "Beauty", id: "11055981" },
  { label: "Health", id: "3760901" },
  { label: "Kitchen", id: "284507" },
  { label: "Pet Supplies", id: "2619533011" },
];
