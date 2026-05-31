import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderFailureSummary,
  getProviderFailureStatus,
  isDryRunProviderSubmission,
  shouldSkipZincOrderSubmission,
} from "../app/workers/order-worker.server.js";

test("shouldSkipZincOrderSubmission returns true when providerOrderId already exists", () => {
  assert.equal(
    shouldSkipZincOrderSubmission({
      providerOrderId: "zinc-123",
      requestPayload: null,
    }),
    true
  );
});

test("shouldSkipZincOrderSubmission returns true when submit intent already exists", () => {
  assert.equal(
    shouldSkipZincOrderSubmission({
      providerOrderId: null,
      requestPayload: "{\"idempotency_key\":\"example.myshopify.com:gid://shopify/Order/123:zinc:create\"}",
    }),
    true
  );
});

test("shouldSkipZincOrderSubmission returns false for a fresh order", () => {
  assert.equal(shouldSkipZincOrderSubmission({ providerOrderId: null, requestPayload: null }), false);
});

test("isDryRunProviderSubmission returns true for dry-run results", () => {
  assert.equal(
    isDryRunProviderSubmission({
      providerOrderId: "dry_run_gid://shopify/Order/123",
      status: "dry_run",
      dryRun: true,
    }),
    true
  );
});

test("isDryRunProviderSubmission returns false for normal results", () => {
  assert.equal(
    isDryRunProviderSubmission({
      providerOrderId: "zinc-123",
      status: "submitted",
      dryRun: false,
    }),
    false
  );
});

test("getProviderFailureStatus returns MANUAL_REVIEW for invalid_client_token", () => {
  assert.equal(
    getProviderFailureStatus({
      code: "invalid_client_token",
      manualReviewRequired: true,
      retryable: false,
    }),
    "MANUAL_REVIEW"
  );
});

test("buildProviderFailureSummary prefixes the provider code", () => {
  assert.equal(
    buildProviderFailureSummary({
      code: "invalid_client_token",
      message: "Your client token is invalid.",
    }),
    "invalid_client_token: Your client token is invalid."
  );
});
