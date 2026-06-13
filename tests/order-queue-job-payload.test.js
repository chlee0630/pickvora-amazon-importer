import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeOrderCreateQueuePayload } from "../app/utils/order-queue-job-payload.server.js";

test("sanitizeOrderCreateQueuePayload stores only minimal order.create fields", () => {
  const payload = {
    id: 123,
    admin_graphql_api_id: "gid://shopify/Order/123",
    name: "#1022",
    test: true,
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    total_price: "10.00",
    currency: "USD",
    contact_email: "customer@example.com",
    email: "customer@example.com",
    phone: "555-1234",
    token: "order-token",
    cart_token: "cart-token",
    checkout_token: "checkout-token",
    order_status_url: "https://example.myshopify.com/orders/123/authenticate?key=secret",
    browser_ip: "203.0.113.10",
    customer: { id: 1, email: "customer@example.com" },
    billing_address: { address1: "billing address" },
    shipping_address: { address1: "shipping address" },
    client_details: { browser_ip: "203.0.113.10" },
    payment_gateway_names: ["bogus"],
    payment_details: { credit_card_number: "4242" },
    line_items: [
      {
        id: 999,
        admin_graphql_api_id: "gid://shopify/LineItem/999",
        product_id: 100,
        variant_id: 200,
        sku: "PICKVORA-RESTOCK-TEST",
        title: "Pickvora Restock Test Product",
        quantity: 1,
        price: "10.00",
        vendor: "private vendor",
        properties: [{ name: "customer note", value: "do not store" }],
      },
    ],
  };

  const sanitized = sanitizeOrderCreateQueuePayload(payload);

  assert.deepEqual(sanitized, {
    id: 123,
    admin_graphql_api_id: "gid://shopify/Order/123",
    name: "#1022",
    test: true,
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    total_price: "10.00",
    currency: "USD",
    line_items: [
      {
        product_id: 100,
        variant_id: 200,
        sku: "PICKVORA-RESTOCK-TEST",
        title: "Pickvora Restock Test Product",
        quantity: 1,
      },
    ],
  });
  assertNoSensitivePayloadContent(sanitized);
});

test("sanitizeOrderCreateQueuePayload handles missing line_items without preserving raw payload", () => {
  const sanitized = sanitizeOrderCreateQueuePayload({
    contact_email: "customer@example.com",
    order_status_url: "https://example.myshopify.com/orders/123/authenticate?key=secret",
  });

  assert.deepEqual(sanitized, { line_items: [] });
  assertNoSensitivePayloadContent(sanitized);
});

function assertNoSensitivePayloadContent(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "contact_email",
    "email",
    "phone",
    "token",
    "cart_token",
    "checkout_token",
    "order_status_url",
    "authenticate",
    "customer",
    "billing_address",
    "shipping_address",
    "client_details",
    "browser_ip",
    "payment",
    "address",
    "secret",
    "do not store",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `stored sensitive queue payload content: ${forbidden}`);
  }
}
