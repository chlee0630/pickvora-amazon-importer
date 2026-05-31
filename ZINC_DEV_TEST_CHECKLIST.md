# Zinc Dev Test Checklist

## Before you test

- Use a Shopify development store.
- Use `zn_test_` Zinc credentials.
- Keep `ALLOW_PRODUCTION_ZINC_IN_DEV=false` unless you explicitly need a production Zinc key locally.
- Do not run inventory sync flows.
- Keep test shipping addresses in the US mainland only.
- Use Shopify test payment or Bogus Gateway.

## Required test cases

1. Place a normal test order with an approved payment.
2. Replay the same Shopify order webhook and confirm no duplicate Zinc order is created.
3. Send an invalid shipping address and confirm the order goes to manual review or permanent failure.
4. Force a Zinc failure response and confirm the job retries with backoff, then lands in DLQ/manual review.
5. Confirm tracking is polled and fulfillment tracking is written back to Shopify.
6. Confirm duplicate fulfillment/tracking updates are skipped.
7. Confirm retry exhaustion stops at the configured max attempts.

## What to verify in data

- `order_webhook_logs` shows the webhook receipt.
- `order_queue_jobs` has one `order.create` job per Shopify order.
- `provider_orders` has one Zinc provider order per Shopify order.
- `tracking_logs` and `fulfillment_logs` have masked payloads.
- `monitoring_events` shows retry and worker events without sensitive fields.

## Safety guard behavior

- Development with a non-test Zinc key should fail unless `ALLOW_PRODUCTION_ZINC_IN_DEV=true`.
- Zinc request and response payload logs should mask shipping address, phone, email, and payment data.
