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
  const data = await request({ type: "product", asin });
  const p = data.product;
  if (!p) throw new Error(`Product not found for ASIN: ${asin}`);

  const buybox = p.buybox_winner || {};
  const priceVal = buybox.price?.value ?? p.price?.value ?? null;
  const salePriceVal = p.rrp?.value ?? null;
  const shippingVal = buybox.shipping?.price?.value ?? 0;
  const inStock = buybox.availability?.in_stock ?? p.in_stock ?? true;
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

  const variants = (p.variants || []).map((v) => ({
    asin: v.asin,
    title: v.title,
    dimensions: v.dimensions || [],
    isCurrent: v.is_current_product,
  }));

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
