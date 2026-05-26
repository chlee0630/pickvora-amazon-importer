const API_VERSION = "2025-10";
// eslint-disable-next-line no-undef
const ASSOCIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || "pickvora-20";

// Per-shop cache for the Online Store publication ID
const publicationIdCache = {};

const DISCLAIMER_HTML = `
<div style="margin-top:24px;padding:14px 16px;background:#fff8e1;border-left:4px solid #f59e0b;border-radius:4px;font-size:13px;color:#444;">
  <strong>안내:</strong> 본 제품은 Amazon.com에서 판매되는 상품입니다. 구매 시 Amazon으로 이동합니다.
  당사는 Amazon Associates 프로그램 참여자로서 적격 구매에 대해 수수료를 받습니다.<br>
  <em>Note: This product is sold on Amazon.com. Clicking purchase will redirect you to Amazon.
  We participate in the Amazon Associates Program and earn commissions on qualifying purchases.</em>
</div>`;

function adminFetch(shop, accessToken, query, variables = {}) {
  return fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());
}

export async function createShopifyProduct(shop, accessToken, amazonData, settings) {
  const shopifyPrice = calcPrice(amazonData, settings);
  const tags = buildTags(amazonData, settings);
  const descHtml = buildDescription(amazonData, settings);
  const variantImport = buildVariantImport(amazonData, settings);

  const createRes = await adminFetch(shop, accessToken, `
    mutation productCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          handle
          options {
            id
            name
            position
            optionValues { id name }
          }
          variants(first: 1) {
            nodes { id }
          }
        }
        userErrors { field message }
      }
    }
  `, {
    product: {
      title: amazonData.title,
      descriptionHtml: descHtml,
      vendor: amazonData.brand || "Amazon",
      tags,
      status: getShopifyStatus(amazonData),
      productType: amazonData.category?.split(" > ")[0] || "",
      ...(variantImport.productOptions.length > 0
        ? { productOptions: variantImport.productOptions }
        : {}),
    },
  });

  const errors = createRes.data?.productCreate?.userErrors;
  if (errors?.length) throw new Error(errors.map((e) => e.message).join(", "));

  const product = createRes.data?.productCreate?.product;
  if (!product) throw new Error("Product creation returned no product");

  const productId = product.id;
  const variantId = product.variants?.nodes?.[0]?.id;

  let primaryVariantId = variantId;

  if (variantImport.variants.length > 0) {
    const createdVariants = await createShopifyVariants(
      shop,
      accessToken,
      productId,
      variantImport.variants,
    );
    primaryVariantId = findCurrentVariantId(createdVariants, amazonData.asin) || createdVariants[0]?.id || variantId;
  } else if (variantId) {
    await adminFetch(shop, accessToken, `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
    `, {
      productId,
      variants: [{
        id: variantId,
        price: shopifyPrice.toFixed(2),
        ...getVariantInventoryPayload({ asin: amazonData.asin }),
        metafields: [amazonAsinMetafield(amazonData.asin)],
      }],
    });
  }

  const images = safeParseJSON(amazonData.images, []);
  const productImages = uniqueImageUrls(images)
    .filter((url) => !variantImport.uploadedImageUrls.includes(url));
  if (productImages.length > 0) {
    await adminFetch(shop, accessToken, `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          userErrors { field message }
        }
      }
    `, {
      productId,
      media: productImages.slice(0, 10).map((url) => ({
        originalSource: url,
        mediaContentType: "IMAGE",
      })),
    });
  }

  if (!amazonData.outOfStock) {
    await publishToOnlineStore(shop, accessToken, productId);
  }

  await updateAmazonReviewMetafields(shop, accessToken, productId, amazonData);

  return {
    shopifyProductId: productId,
    shopifyVariantId: primaryVariantId,
    shopifyHandle: product.handle,
    shopifyPrice,
  };
}

export async function updateShopifyProduct(shop, accessToken, shopifyProductId, shopifyVariantId, amazonData, settings) {
  const shopifyPrice = calcPrice(amazonData, settings);
  const tags = buildTags(amazonData, settings);
  const descHtml = buildDescription(amazonData, settings);

  await adminFetch(shop, accessToken, `
    mutation productUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        userErrors { field message }
      }
    }
  `, {
    product: {
      id: shopifyProductId,
      descriptionHtml: descHtml,
      tags,
      status: getShopifyStatus(amazonData),
    },
  });

  if (shopifyVariantId) {
    await adminFetch(shop, accessToken, `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
    `, {
      productId: shopifyProductId,
      variants: [{
        id: shopifyVariantId,
        price: shopifyPrice.toFixed(2),
        ...getVariantInventoryPayload({ asin: amazonData.asin }),
      }],
    });
  }

  await updateAmazonReviewMetafields(shop, accessToken, shopifyProductId, amazonData);

  return { shopifyPrice };
}

async function updateAmazonReviewMetafields(shop, accessToken, productId, amazonData) {
  const reviewMetafields = buildAmazonReviewMetafields(productId, amazonData);
  if (reviewMetafields.length === 0) return;

  try {
    const res = await adminFetch(shop, accessToken, `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key value }
          userErrors { field message }
        }
      }
    `, { metafields: reviewMetafields });

    const errors = res.data?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((error) => error.message).join(", "));
    }

    logReviewMetafieldEvent("shopify_review_metafields_updated", {
      productId,
      asin: amazonData.asin,
      rating: amazonData.rating,
      ratingsTotal: amazonData.ratingsTotal,
    });
  } catch (err) {
    logReviewMetafieldEvent("shopify_review_metafields_failed", {
      productId,
      asin: amazonData.asin,
      error: err?.message || String(err),
    });
  }
}

function buildAmazonReviewMetafields(productId, amazonData) {
  if (!isValidRating(amazonData.rating)) return [];

  const updatedAt = amazonData.reviewsUpdatedAt
    ? new Date(amazonData.reviewsUpdatedAt)
    : new Date();
  const reviewCount = Number.isInteger(amazonData.ratingsTotal) && amazonData.ratingsTotal >= 0
    ? amazonData.ratingsTotal
    : 0;

  return [
    {
      ownerId: productId,
      namespace: "amazon_reviews",
      key: "average_rating",
      type: "number_decimal",
      value: Number(amazonData.rating).toFixed(2),
    },
    {
      ownerId: productId,
      namespace: "amazon_reviews",
      key: "review_count",
      type: "number_integer",
      value: String(reviewCount),
    },
    {
      ownerId: productId,
      namespace: "amazon_reviews",
      key: "source",
      type: "single_line_text_field",
      value: "amazon",
    },
    {
      ownerId: productId,
      namespace: "amazon_reviews",
      key: "updated_at",
      type: "date_time",
      value: updatedAt.toISOString(),
    },
  ];
}

async function createShopifyVariants(shop, accessToken, productId, variants) {
  const res = await adminFetch(shop, accessToken, `
    mutation productVariantsBulkCreate(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!,
      $strategy: ProductVariantsBulkCreateStrategy
    ) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
        productVariants {
          id
          selectedOptions { name value }
          metafield(namespace: "amazon", key: "asin") { value }
        }
        userErrors { field message }
      }
    }
  `, {
    productId,
    variants,
    strategy: "REMOVE_STANDALONE_VARIANT",
  });

  const errors = res.data?.productVariantsBulkCreate?.userErrors;
  if (errors?.length) {
    console.error("Shopify variant creation errors:", errors);
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  return res.data?.productVariantsBulkCreate?.productVariants || [];
}

async function getOnlineStorePublicationId(shop, accessToken) {
  if (publicationIdCache[shop]) return publicationIdCache[shop];

  const res = await adminFetch(shop, accessToken, `
    query {
      publications(first: 20) {
        edges {
          node {
            id
            name
            catalog {
              __typename
            }
          }
        }
      }
    }
  `);

  const pubs = res.data?.publications?.edges ?? [];
  const onlineStore = pubs.find(
    (e) =>
      e.node.catalog?.__typename === "OnlineStoreCatalog" ||
      e.node.name === "Online Store"
  );

  if (onlineStore) {
    publicationIdCache[shop] = onlineStore.node.id;
    return onlineStore.node.id;
  }
  return null;
}

async function publishToOnlineStore(shop, accessToken, productId) {
  try {
    const publicationId = await getOnlineStorePublicationId(shop, accessToken);
    if (!publicationId) return;

    await adminFetch(shop, accessToken, `
      mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `, {
      id: productId,
      input: [{ publicationId }],
    });
  } catch {
    // Non-blocking — product creation still succeeds even if publication fails
  }
}

export async function hideShopifyProduct(shop, accessToken, shopifyProductId) {
  await adminFetch(shop, accessToken, `
    mutation productUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { field message } }
    }
  `, { product: { id: shopifyProductId, status: "DRAFT" } });
}

export async function showShopifyProduct(shop, accessToken, shopifyProductId) {
  await adminFetch(shop, accessToken, `
    mutation productUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { field message } }
    }
  `, { product: { id: shopifyProductId, status: "ACTIVE" } });
}

function getShopifyStatus(amazonData) {
  if (amazonData.availabilityStatus) {
    return amazonData.availabilityStatus === "in_stock" ? "ACTIVE" : "DRAFT";
  }
  return amazonData.outOfStock ? "DRAFT" : "ACTIVE";
}

function calcPrice(amazonData, settings) {
  const base = amazonData.price ?? 0;
  const shipping = settings.includeShipping ? (amazonData.shippingPrice ?? 0) : 0;
  const margin = settings.defaultMargin ?? 30;
  return Math.round((base + shipping) * (1 + margin / 100) * 100) / 100;
}

function buildVariantImport(amazonData, settings) {
  const variants = dedupeVariants(
    safeParseJSON(amazonData.variants, [])
      .filter((variant) => variant.asin && Array.isArray(variant.options) && variant.options.length > 0),
  );

  if (variants.length === 0) {
    return { productOptions: [], variants: [], uploadedImageUrls: [] };
  }

  const optionNames = [];
  variants.forEach((variant) => {
    variant.options.forEach((option) => {
      if (option.name && !optionNames.includes(option.name) && optionNames.length < 3) {
        optionNames.push(option.name);
      }
    });
  });

  if (optionNames.length === 0) {
    return { productOptions: [], variants: [], uploadedImageUrls: [] };
  }

  const productOptions = optionNames.map((name) => ({
    name,
    values: uniqueOptionValues(variants, name).map((value) => ({ name: value })),
  }));

  const uploadedImageUrls = [];
  const shopifyVariants = variants
    .map((variant) => buildShopifyVariantInput(variant, optionNames, amazonData, settings, uploadedImageUrls))
    .filter(Boolean);

  return { productOptions, variants: shopifyVariants, uploadedImageUrls };
}

function dedupeVariants(variants) {
  const seen = new Set();
  return variants.filter((variant) => {
    const optionKey = Array.isArray(variant.options)
      ? variant.options.map((option) => `${option.name}:${option.value}`).join("|")
      : "";
    const key = `${variant.asin}|${optionKey}`;
    if (seen.has(key)) {
      console.warn("Duplicate Amazon variation skipped:", { asin: variant.asin, optionKey });
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueOptionValues(variants, optionName) {
  const values = variants
    .map((variant) => getVariantOptionValue(variant, optionName))
    .filter(Boolean);
  return [...new Set(values)];
}

function buildShopifyVariantInput(variant, optionNames, amazonData, settings, uploadedImageUrls) {
  const optionValues = optionNames.map((optionName) => {
    const value = getVariantOptionValue(variant, optionName);
    return value ? { optionName, name: value } : null;
  });

  if (optionValues.some((value) => !value)) return null;

  const variantPrice = calcPrice({ ...amazonData, price: variant.price ?? amazonData.price }, settings);
  const input = {
    price: variantPrice.toFixed(2),
    optionValues,
    ...getVariantInventoryPayload(variant),
    metafields: [amazonAsinMetafield(variant.asin)],
  };

  const variantImage = getVariantImage(variant, amazonData);
  if (variantImage) {
    input.mediaSrc = [variantImage];
    if (!uploadedImageUrls.includes(variantImage)) {
      uploadedImageUrls.push(variantImage);
    }
  } else {
    console.warn("Variant image mapping failed:", { asin: variant.asin });
  }

  return input;
}

function getVariantOptionValue(variant, optionName) {
  const option = variant.options.find((item) => item.name === optionName);
  const value = option?.value ? String(option.value).trim() : "";
  return value || null;
}

function getVariantInventoryPayload(variant) {
  const payload = {
    inventoryPolicy: "CONTINUE",
    inventoryItem: { tracked: false },
  };

  console.log("Shopify variant inventory configured:", {
    asin: variant.asin,
    inventoryPolicy: payload.inventoryPolicy,
    tracked: payload.inventoryItem.tracked,
    inventoryQuantitySync: false,
  });

  return payload;
}

function getVariantImage(variant, amazonData) {
  const image = normalizeImageUrl(variant.image) || normalizeImageUrl(amazonData.mainImage);
  if (!image) {
    console.warn("Variant image mapping failed:", { asin: variant.asin, reason: "missing variation and parent image" });
  }
  return image;
}

function normalizeImageUrl(value) {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  return value.link || value.url || null;
}

function uniqueImageUrls(images) {
  return [...new Set(images.map(normalizeImageUrl).filter(Boolean))];
}

function amazonAsinMetafield(asin) {
  return {
    namespace: "amazon",
    key: "asin",
    type: "single_line_text_field",
    value: asin,
  };
}

function findCurrentVariantId(variants, asin) {
  return variants.find((variant) => variant.metafield?.value === asin)?.id || null;
}

function buildTags(amazonData, settings) {
  if (!settings.autoGenerateTags) return [];
  const tags = [];
  if (amazonData.brand) tags.push(amazonData.brand);
  if (amazonData.category) {
    amazonData.category.split(" > ").forEach((c) => tags.push(c.trim()));
  }
  if (amazonData.primeEligible) tags.push("Prime");
  if (settings.saleMode === "affiliate") tags.push("affiliate");
  tags.push("Amazon", `ASIN:${amazonData.asin}`);
  return [...new Set(tags)].slice(0, 13);
}

function buildDescription(amazonData, settings) {
  const parts = [];
  const isAffiliate = settings.saleMode === "affiliate";
  const affiliateUrl = `https://www.amazon.com/dp/${amazonData.asin}?tag=${ASSOCIATE_TAG}`;

  // Affiliate mode: prominent "Buy on Amazon" button at top
  if (isAffiliate) {
    parts.push(`
<div style="margin-bottom:20px;padding:16px;background:#ff9900;border-radius:8px;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="noopener"
     style="color:white;font-size:18px;font-weight:bold;text-decoration:none;display:block;">
    🛒 Amazon에서 구매하기 →
  </a>
  <p style="color:white;font-size:12px;margin:6px 0 0;">
    클릭 시 Amazon.com으로 이동합니다 (제휴 링크)
  </p>
</div>`);
  }

  if (amazonData.description) {
    parts.push(`<p>${amazonData.description}</p>`);
  }

  const ratingBadge = buildRatingBadge(amazonData);
  if (ratingBadge) {
    parts.push(ratingBadge);
  }

  const bullets = safeParseJSON(amazonData.featureBullets, []);
  if (bullets.length > 0) {
    parts.push(`<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`);
  }

  if (settings.addReviewsToDesc) {
    const reviews = safeParseJSON(amazonData.reviews, []);
    if (reviews.length > 0) {
      parts.push(`<h3>Customer Reviews</h3>`);
      reviews.slice(0, 5).forEach((r) => {
        parts.push(
          `<div style="margin-bottom:12px;padding:10px;background:#f9f9f9;border-radius:4px;">` +
          `<strong>${escHtml(r.title || "")}</strong> (${"★".repeat(Math.round(r.rating ?? 0))} ${r.rating ?? ""})<br>` +
          `<span style="font-size:13px;">${escHtml(r.body || "")}</span>` +
          `</div>`,
        );
      });
    }
  }

  // Affiliate mode: repeat button at bottom
  if (isAffiliate) {
    parts.push(`
<div style="margin-top:20px;text-align:center;">
  <a href="${affiliateUrl}" target="_blank" rel="noopener"
     style="display:inline-block;padding:12px 32px;background:#ff9900;color:white;
            font-weight:bold;border-radius:6px;text-decoration:none;font-size:16px;">
    Amazon에서 구매하기 →
  </a>
</div>`);
  }

  // Disclaimer
  if (settings.addDisclaimer !== false) {
    parts.push(DISCLAIMER_HTML);
  }

  return parts.join("\n");
}

function buildRatingBadge(amazonData) {
  if (!isValidRating(amazonData.rating)) return "";
  const rating = Number(amazonData.rating).toFixed(1);
  const count = Number.isInteger(amazonData.ratingsTotal) && amazonData.ratingsTotal > 0
    ? ` (${Number(amazonData.ratingsTotal).toLocaleString()} reviews)`
    : "";

  return `
<div style="display:inline-flex;align-items:center;gap:6px;margin:8px 0 14px;padding:6px 10px;border:1px solid #e1e3e5;border-radius:6px;background:#fff;font-size:14px;color:#202223;">
  <span style="color:#b7791f;font-weight:700;">★ ${rating}</span><span>${count}</span>
</div>`;
}

function isValidRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5;
}

function logReviewMetafieldEvent(event, details) {
  console.log(JSON.stringify({
    event,
    layer: "shopify_review_metafields",
    ...details,
  }));
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
