import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildEasyParserDetailUrl,
  fetchProductDetails as fetchEasyParserProductDetails,
  normalizeEasyParserProduct,
  redactEasyParserUrl,
} from "../app/services/easyparser.server.js";
import {
  fetchProductDetails,
  getAmazonProductProviderName,
} from "../app/services/amazon-product-provider.server.js";

const ROOT = process.cwd();

test("EasyParser detail request builder uses expected endpoint and query", () => {
  const url = buildEasyParserDetailUrl("B012345678", {
    EASYPARSER_API_KEY: "test-key",
    EASYPARSER_DOMAIN: ".com",
  });

  assert.equal(url.origin + url.pathname, "https://realtime.easyparser.com/v1/request");
  assert.equal(url.searchParams.get("api_key"), "test-key");
  assert.equal(url.searchParams.get("platform"), "AMZ");
  assert.equal(url.searchParams.get("operation"), "DETAIL");
  assert.equal(url.searchParams.get("domain"), ".com");
  assert.equal(url.searchParams.get("asin"), "B012345678");
});

test("EasyParser URL redaction masks api_key", () => {
  const url = buildEasyParserDetailUrl("B012345678", {
    EASYPARSER_API_KEY: "secret-easyparser-key",
    EASYPARSER_DOMAIN: ".com",
  });
  const redacted = redactEasyParserUrl(url);

  assert.doesNotMatch(redacted, /secret-easyparser-key/);
  assert.match(redacted, /api_key=%5Bmasked%5D/);
});

test("EasyParser error messages do not expose api_key response fields", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EASYPARSER_API_KEY;
  const originalRetries = process.env.EASYPARSER_MAX_RETRIES;

  try {
    process.env.EASYPARSER_API_KEY = "secret-easyparser-key";
    process.env.EASYPARSER_MAX_RETRIES = "0";
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => JSON.stringify({ api_key: "secret-easyparser-key", error: "upstream failed" }),
    });

    await assert.rejects(
      () => fetchEasyParserProductDetails("B012345678"),
      (err) => {
        assert.match(err.message, /EasyParser API 500/);
        assert.doesNotMatch(err.message, /secret-easyparser-key/);
        assert.match(err.message, /\[masked\]/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("EASYPARSER_API_KEY", originalKey);
    restoreEnv("EASYPARSER_MAX_RETRIES", originalRetries);
  }
});

test("EasyParser normalizer returns amazonData-compatible product shape", () => {
  const normalized = normalizeEasyParserProduct(makeEasyParserResponse(), "B012345678");

  assert.equal(normalized.asin, "B012345678");
  assert.equal(normalized.title, "Example Product");
  assert.equal(normalized.brand, "Example Brand");
  assert.equal(normalized.category, "Home > Kitchen");
  assert.equal(normalized.price, 24.99);
  assert.equal(normalized.salePrice, 29.99);
  assert.equal(normalized.inStock, true);
  assert.equal(normalized.outOfStock, false);
  assert.equal(normalized.availabilityStatus, "in_stock");
  assert.equal(normalized.shippingPrice, 0);
  assert.equal(normalized.primeEligible, true);
  assert.equal(normalized.mainImage, "https://example.test/main.jpg");
  assert.equal(normalized.rating, 4.6);
  assert.equal(normalized.ratingsTotal, 1234);
  assert.equal(normalized.bestsellRank, 42);
  assert.deepEqual(JSON.parse(normalized.featureBullets), ["First feature", "Second feature"]);
  assert.deepEqual(JSON.parse(normalized.images), [
    "https://example.test/main.jpg",
    "https://example.test/alt.jpg",
  ]);
  assert.deepEqual(JSON.parse(normalized.variants), [
    {
      asin: "B012345679",
      title: "Example Product Blue",
      options: [{ name: "Color", value: "Blue" }],
      price: 25.99,
      image: "https://example.test/blue.jpg",
      availability: "In Stock",
      isCurrent: false,
    },
  ]);
});

test("EasyParser normalizer supports real result.detail wrapper", () => {
  const normalized = normalizeEasyParserProduct({
    request_info: {},
    request_parameters: {},
    request_metadata: {},
    result: {
      detail: {
        asin: "B0GJ74JDGK",
        title: "Example Product",
        brand: "Example Brand",
        buybox_winner: {
          price: { currency: "USD", raw: "$69.99", symbol: "$", value: 69.99 },
          availability: { raw: "In Stock", stock_data: 20 },
        },
        main_image: { link: "https://example.test/main.jpg" },
        images: [{ link: "https://example.test/main.jpg" }],
        link: "https://www.amazon.com/dp/B0GJ74JDGK",
      },
      delivered_to: {},
    },
  }, "B0GJ74JDGK");

  assert.equal(normalized.asin, "B0GJ74JDGK");
  assert.equal(normalized.title, "Example Product");
  assert.equal(normalized.price, 69.99);
  assert.equal(normalized.availabilityStatus, "in_stock");
  assert.equal(normalized.mainImage, "https://example.test/main.jpg");
});

test("EasyParser normalizer supports nested data.result.detail wrapper", () => {
  const normalized = normalizeEasyParserProduct({
    data: {
      result: {
        detail: {
          asin: "B0GJ74JDGK",
          title: "Nested Example Product",
          buybox_winner: {
            price: { value: 69.99 },
            availability: { raw: "In Stock" },
          },
        },
      },
    },
  }, "B0GJ74JDGK");

  assert.equal(normalized.asin, "B0GJ74JDGK");
  assert.equal(normalized.title, "Nested Example Product");
  assert.equal(normalized.price, 69.99);
  assert.equal(normalized.availabilityStatus, "in_stock");
});

test("Amazon product provider defaults to EasyParser", () => {
  assert.equal(getAmazonProductProviderName({}), "easyparser");
  assert.equal(getAmazonProductProviderName({ AMAZON_PRODUCT_PROVIDER: "easyparser" }), "easyparser");
  assert.equal(getAmazonProductProviderName({ AMAZON_PRODUCT_PROVIDER: "unknown" }), "easyparser");
});

test("Amazon product provider can route to Rainforest by environment variable", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AMAZON_PRODUCT_PROVIDER;
  const originalRetries = process.env.RAINFOREST_MAX_RETRIES;
  const requestedUrls = [];

  try {
    process.env.AMAZON_PRODUCT_PROVIDER = "rainforest";
    process.env.RAINFOREST_MAX_RETRIES = "0";
    globalThis.fetch = async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          product: {
            asin: "B012345678",
            title: "Rainforest Product",
            buybox_winner: {
              price: { value: 19.99 },
              availability: { type: "in stock" },
            },
            images: [{ link: "https://example.test/rainforest.jpg" }],
          },
        }),
      };
    };

    const product = await fetchProductDetails("B012345678");

    assert.equal(product.title, "Rainforest Product");
    assert.equal(new URL(requestedUrls[0]).hostname, "api.rainforestapi.com");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("AMAZON_PRODUCT_PROVIDER", originalProvider);
    restoreEnv("RAINFOREST_MAX_RETRIES", originalRetries);
  }
});

test("Amazon product provider routes to EasyParser by default", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AMAZON_PRODUCT_PROVIDER;
  const originalKey = process.env.EASYPARSER_API_KEY;
  const originalRetries = process.env.EASYPARSER_MAX_RETRIES;
  const requestedUrls = [];

  try {
    delete process.env.AMAZON_PRODUCT_PROVIDER;
    process.env.EASYPARSER_API_KEY = "secret-easyparser-key";
    process.env.EASYPARSER_MAX_RETRIES = "0";
    globalThis.fetch = async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(makeEasyParserResponse()),
      };
    };

    const product = await fetchProductDetails("B012345678");

    assert.equal(product.title, "Example Product");
    assert.equal(new URL(requestedUrls[0]).hostname, "realtime.easyparser.com");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("AMAZON_PRODUCT_PROVIDER", originalProvider);
    restoreEnv("EASYPARSER_API_KEY", originalKey);
    restoreEnv("EASYPARSER_MAX_RETRIES", originalRetries);
  }
});

test("Rainforest implementation remains present for rollback", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/services/rainforest.server.js"), "utf8");

  assert.match(source, /export async function fetchProductDetails/);
  assert.match(source, /fetchBestSellers/);
  assert.match(source, /fetchMostWishedFor/);
  assert.match(source, /fetchNewReleases/);
});

test("EasyParser provider changes do not add forbidden fraud/order patterns", () => {
  const files = [
    "app/services/easyparser.server.js",
    "app/services/amazon-product-provider.server.js",
    "app/services/amazon-sync.server.js",
    "app/utils/scaling-config.server.js",
  ];
  const source = files
    .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
    .join("\n");

  assert.doesNotMatch(source, new RegExp(["refund", "Create"].join("")));
  assert.doesNotMatch(source, new RegExp(`${["notify", "Customer"].join("")}:\\s*true`));
  assert.doesNotMatch(source, new RegExp(`${["request", "Payload"].join("")}.*variables`));
  assert.doesNotMatch(source, new RegExp(`${["EASYPARSER", "API", "KEY"].join("_")}.*console`));
  assert.doesNotMatch(source, new RegExp(`${["api", "key"].join("_")}.*console`));
  assert.doesNotMatch(source, new RegExp(`${["Author", "ization"].join("")}.*console`));
});

function makeEasyParserResponse() {
  return {
    product: {
      asin: "B012345678",
      title: "Example Product",
      brand: "Example Brand",
      categories: [{ name: "Home" }, { name: "Kitchen" }],
      description: "Example description",
      feature_bullets: ["First feature", "Second feature"],
      price: { value: 24.99 },
      rrp: "$29.99",
      buybox_winner: {
        shipping: { price: { value: 0 } },
        availability: { raw: "In Stock", in_stock: true },
        is_prime: true,
        stock_level: 7,
      },
      images: [
        { link: "https://example.test/main.jpg" },
        { link: "https://example.test/alt.jpg" },
      ],
      main_image: { link: "https://example.test/main.jpg" },
      rating: "4.6 out of 5",
      ratings_total: "1,234",
      bestsellers_rank: [{ rank: 42 }],
      link: "https://www.amazon.com/dp/B012345678",
      variants: [
        {
          asin: "B012345679",
          title: "Example Product Blue",
          dimensions: [{ name: "Color", value: "Blue" }],
          price: "$25.99",
          image: { link: "https://example.test/blue.jpg" },
          availability: { raw: "In Stock" },
        },
      ],
    },
  };
}

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
