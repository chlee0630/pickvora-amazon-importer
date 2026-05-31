import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";

import {
  buildZincCreatePayload,
  buildZincIdempotencyKey,
  createZincProvider,
  isAllowedTestSuccessProductUrl,
} from "../app/services/order-providers/zinc.server.js";

test("buildZincIdempotencyKey is deterministic per Shopify order", () => {
  const key1 = buildZincIdempotencyKey("example.myshopify.com", "gid://shopify/Order/123");
  const key2 = buildZincIdempotencyKey("example.myshopify.com", "gid://shopify/Order/123");
  const key3 = buildZincIdempotencyKey("example.myshopify.com", "gid://shopify/Order/124");

  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
  assert.ok(key1.length <= 36);
  assert.match(key1, /^z:[a-f0-9]{32}$/);
});

test("buildZincCreatePayload includes idempotency_key", () => {
  const payload = buildZincCreatePayload(
    {
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/123",
      items: [{ asin: "B012345678", quantity: 1, maxPriceCents: 2300 }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    },
    "z:1234567890abcdef1234567890abcdef",
    { retailer: "amazon", maxPriceCents: null }
  );

  assert.equal(payload.idempotency_key, "z:1234567890abcdef1234567890abcdef");
  assert.equal(payload.client_notes.shopify_order_id, "gid://shopify/Order/123");
  assert.equal(payload.products[0].url, "https://www.amazon.com/dp/B012345678");
  assert.equal(payload.shipping_address.postal_code, "90001");
  assert.equal(payload.max_price, 2300);
  assert.ok(Number.isInteger(payload.max_price));
});

test("buildZincCreatePayload prefers configured maxPriceCents", () => {
  const payload = buildZincCreatePayload(
    {
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/123",
      items: [{ asin: "B012345678", quantity: 2, maxPriceCents: 1000 }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    },
    "z:1234567890abcdef1234567890abcdef",
    { retailer: "amazon", maxPriceCents: 4500 }
  );

  assert.equal(payload.max_price, 4500);
});

test("createOrder sends the same idempotency key to Zinc", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.ZINC_API_KEY;
  process.env.ZINC_API_KEY = "zn_test_local_test_key";

  let capturedBody;
  let capturedAuthorization;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    capturedAuthorization = options.headers.Authorization;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ request_id: "req_123", status: "submitted" }),
    };
  };

  try {
    const provider = createZincProvider();
    await provider.createOrder({
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/123",
      items: [{ asin: "B012345678", quantity: 1, maxPriceCents: 2300 }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    });

    assert.ok(capturedBody.idempotency_key.length <= 36);
    assert.match(capturedBody.idempotency_key, /^z:[a-f0-9]{32}$/);
    assert.equal(capturedAuthorization, "Bearer zn_test_local_test_key");
  } finally {
    global.fetch = originalFetch;
    process.env.ZINC_API_KEY = originalEnv;
  }
});

test("createOrder trims the Zinc API key before sending Authorization", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.ZINC_API_KEY;
  process.env.ZINC_API_KEY = "  zn_test_trimmed_key  ";

  let capturedAuthorization;
  global.fetch = async (_url, options) => {
    capturedAuthorization = options.headers.Authorization;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ request_id: "req_123", status: "submitted" }),
    };
  };

  try {
    const provider = createZincProvider();
    await provider.createOrder({
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/789",
      items: [{ asin: "B012345678", quantity: 1, maxPriceCents: 2300 }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    });

    assert.equal(capturedAuthorization, "Bearer zn_test_trimmed_key");
  } finally {
    global.fetch = originalFetch;
    process.env.ZINC_API_KEY = originalEnv;
  }
});

test("createOrder rejects Zinc error responses and preserves the error code", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.ZINC_API_KEY;
  process.env.ZINC_API_KEY = "zn_test_local_test_key";

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      _type: "error",
      request_id: "f37c5000344b8c8d23e6406f21f8bd00",
      error: {
        _type: "error",
        code: "invalid_client_token",
        message: "Your client token is invalid. Please contact support@zinc.io to receive a client token and use the full API.",
        request_id: "f37c5000344b8c8d23e6406f21f8bd00",
      },
    }),
  });

  try {
    const provider = createZincProvider();
    await assert.rejects(
      () => provider.createOrder({
        shop: "example.myshopify.com",
        shopifyOrderId: "gid://shopify/Order/999",
        items: [{ asin: "B012345678", quantity: 1, maxPriceCents: 2300 }],
        shippingAddress: {
          first_name: "Test",
          last_name: "User",
          address_line1: "1 Main St",
          city: "Los Angeles",
          state: "CA",
          zip_code: "90001",
          phone_number: "555-555-5555",
          country: "US",
        },
      }),
      (err) => (
        err.code === "invalid_client_token" &&
        err.manualReviewRequired === true &&
        !String(err.message || "").includes("support@zinc.io")
      )
    );
  } finally {
    global.fetch = originalFetch;
    process.env.ZINC_API_KEY = originalEnv;
  }
});

test("createOrder dry-run skips HTTP and still includes idempotency key", async () => {
  const originalFetch = global.fetch;
  const originalDryRun = process.env.ZINC_DRY_RUN;
  const originalEnv = process.env.ZINC_API_KEY;
  process.env.ZINC_DRY_RUN = "true";
  process.env.ZINC_API_KEY = "";

  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called in dry-run mode");
  };

  try {
    const provider = createZincProvider();
    const result = await provider.createOrder({
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/456",
      items: [{ asin: "B012345678", quantity: 1, maxPriceCents: 2300 }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    });

    assert.equal(fetchCalled, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.providerOrderId, "dry_run_gid://shopify/Order/456");
    assert.equal(result.responsePayload.status, "dry_run");
    assert.equal(result.responsePayload.dryRun, true);
    assert.ok(result.requestPayload.idempotency_key.length <= 36);
    assert.match(result.requestPayload.idempotency_key, /^z:[a-f0-9]{32}$/);
  } finally {
    global.fetch = originalFetch;
    process.env.ZINC_DRY_RUN = originalDryRun;
    process.env.ZINC_API_KEY = originalEnv;
  }
});

test("buildZincCreatePayload uses amazonUrl when present", () => {
  const payload = buildZincCreatePayload(
    {
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/123",
      items: [{
        asin: "B012345678",
        quantity: 1,
        amazonUrl: "https://www.amazon.com/dp/B012345678",
        maxPriceCents: 2300,
      }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    },
    "z:1234567890abcdef1234567890abcdef",
    { retailer: "amazon", maxPriceCents: null }
  );

  assert.equal(payload.products[0].url, "https://www.amazon.com/dp/B012345678");
});

test("buildZincCreatePayload rejects invalid Amazon URLs", () => {
  assert.throws(() => buildZincCreatePayload(
    {
      shop: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/123",
      items: [{
        asin: "B012345678",
        quantity: 1,
        amazonUrl: "https://www.amazon.com/s?k=B012345678",
        maxPriceCents: 2300,
      }],
      shippingAddress: {
        first_name: "Test",
        last_name: "User",
        address_line1: "1 Main St",
        city: "Los Angeles",
        state: "CA",
        zip_code: "90001",
        phone_number: "555-555-5555",
        country: "US",
      },
    },
    "z:1234567890abcdef1234567890abcdef",
    { retailer: "amazon", maxPriceCents: null }
  ));
});

test("isAllowedTestSuccessProductUrl only allows the Zinc test-success URL in dev with a test key and allow flag", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_API_KEY: process.env.ZINC_API_KEY,
    ZINC_ALLOW_TEST_PRODUCT_URL: process.env.ZINC_ALLOW_TEST_PRODUCT_URL,
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.ZINC_API_KEY = "zn_test_local_test_key";
    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = "true";
    assert.equal(isAllowedTestSuccessProductUrl("https://zinc.com/shop/products/test-success"), true);

    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = "false";
    assert.equal(isAllowedTestSuccessProductUrl("https://zinc.com/shop/products/test-success"), false);

    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = "true";
    process.env.ZINC_API_KEY = "live_key";
    assert.equal(isAllowedTestSuccessProductUrl("https://zinc.com/shop/products/test-success"), false);

    process.env.ZINC_API_KEY = "zn_test_local_test_key";
    process.env.NODE_ENV = "production";
    assert.equal(isAllowedTestSuccessProductUrl("https://zinc.com/shop/products/test-success"), false);
  } finally {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.ZINC_API_KEY = originalEnv.ZINC_API_KEY;
    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = originalEnv.ZINC_ALLOW_TEST_PRODUCT_URL;
  }
});

test("buildZincCreatePayload accepts the Zinc test-success URL only in dev/test with allow flag and test key", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ZINC_API_KEY: process.env.ZINC_API_KEY,
    ZINC_ALLOW_TEST_PRODUCT_URL: process.env.ZINC_ALLOW_TEST_PRODUCT_URL,
  };

  const baseInput = {
    shop: "example.myshopify.com",
    shopifyOrderId: "gid://shopify/Order/123",
    items: [{
      asin: "B012345678",
      quantity: 1,
      amazonUrl: "https://zinc.com/shop/products/test-success",
      maxPriceCents: 2300,
    }],
    shippingAddress: {
      first_name: "Test",
      last_name: "User",
      address_line1: "1 Main St",
      city: "Los Angeles",
      state: "CA",
      zip_code: "90001",
      phone_number: "555-555-5555",
      country: "US",
    },
  };

  try {
    process.env.NODE_ENV = "development";
    process.env.ZINC_API_KEY = "zn_test_local_test_key";
    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = "true";

    const allowedPayload = buildZincCreatePayload(
      baseInput,
      "z:1234567890abcdef1234567890abcdef",
      { retailer: "amazon", maxPriceCents: null }
    );
    assert.equal(allowedPayload.products[0].url, "https://zinc.com/shop/products/test-success");

    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = "false";
    assert.throws(() => buildZincCreatePayload(
      baseInput,
      "z:1234567890abcdef1234567890abcdef",
      { retailer: "amazon", maxPriceCents: null }
    ));

    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = "true";
    process.env.ZINC_API_KEY = "live_key";
    assert.throws(() => buildZincCreatePayload(
      baseInput,
      "z:1234567890abcdef1234567890abcdef",
      { retailer: "amazon", maxPriceCents: null }
    ));

    process.env.ZINC_API_KEY = "zn_test_local_test_key";
    process.env.NODE_ENV = "production";
    assert.throws(() => buildZincCreatePayload(
      baseInput,
      "z:1234567890abcdef1234567890abcdef",
      { retailer: "amazon", maxPriceCents: null }
    ));
  } finally {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.ZINC_API_KEY = originalEnv.ZINC_API_KEY;
    process.env.ZINC_ALLOW_TEST_PRODUCT_URL = originalEnv.ZINC_ALLOW_TEST_PRODUCT_URL;
  }
});

test("createOrder rejects when max price is missing", async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.ZINC_API_KEY;
  process.env.ZINC_API_KEY = "zn_test_local_test_key";

  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called when max price is missing");
  };

  try {
    const provider = createZincProvider();
    await assert.rejects(
      () => provider.createOrder({
        shop: "example.myshopify.com",
        shopifyOrderId: "gid://shopify/Order/1000",
        items: [{ asin: "B012345678", quantity: 1 }],
        shippingAddress: {
          first_name: "Test",
          last_name: "User",
          address_line1: "1 Main St",
          city: "Los Angeles",
          state: "CA",
          zip_code: "90001",
          phone_number: "555-555-5555",
          country: "US",
        },
      }),
      (err) => err.code === "ZINC_PAYLOAD_INVALID" && err.manualReviewRequired === true
    );

    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    process.env.ZINC_API_KEY = originalEnv;
  }
});
