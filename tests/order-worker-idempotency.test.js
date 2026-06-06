import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderFailureSummary,
  getProviderFailureStatus,
  isDryRunProviderSubmission,
  runFraudAssessmentForOrder,
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

test("runFraudAssessmentForOrder skips risk assessment when fraud protection is disabled", async () => {
  let assessCalled = false;
  const events = [];

  const result = await runFraudAssessmentForOrder({
    job: buildOrderJob(),
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/123",
  }, {
    getFraudProtectionConfig: async () => ({ enabled: false }),
    assessOrderFraudRisk: async () => {
      assessCalled = true;
      throw new Error("should not be called");
    },
    logWorkerEvent: (event, job, details) => events.push({ event, job, details }),
  });

  assert.equal(assessCalled, false);
  assert.deepEqual(result, { skipped: true, reason: "fraud_protection_disabled" });
  assert.equal(events[0].event, "fraud_assessment_skipped");
});

test("runFraudAssessmentForOrder records dry-run would-cancel decisions without blocking", async () => {
  const events = [];

  const result = await runFraudAssessmentForOrder({
    job: buildOrderJob(),
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/123",
  }, {
    getFraudProtectionConfig: async () => ({
      enabled: true,
      dryRun: true,
      autoCancelHighRisk: true,
    }),
    assessOrderFraudRisk: async () => ({
      riskLevel: "HIGH",
      decision: "WOULD_CANCEL",
      actionMode: "DRY_RUN",
      assessment: {
        decision: "WOULD_CANCEL",
      },
    }),
    logWorkerEvent: (event, job, details) => events.push({ event, job, details }),
  });

  assert.equal(result.skipped, false);
  assert.equal(result.result.assessment.decision, "WOULD_CANCEL");
  assert.deepEqual(
    events.map((entry) => entry.event),
    ["fraud_assessment_completed", "fraud_order_would_cancel_dry_run"]
  );
});

test("runFraudAssessmentForOrder treats fraud assessment failures as non-blocking", async () => {
  const events = [];
  const errors = [];

  const result = await runFraudAssessmentForOrder({
    job: buildOrderJob(),
    accessToken: "offline_token",
    shopifyOrderId: "gid://shopify/Order/123",
  }, {
    getFraudProtectionConfig: async () => ({ enabled: true }),
    assessOrderFraudRisk: async () => {
      throw new Error("risk fetch failed");
    },
    logWorkerEvent: (event, job, details) => events.push({ event, job, details }),
    logError: (...args) => errors.push(args),
  });

  assert.deepEqual(result, { skipped: true, reason: "assessment_failed" });
  assert.equal(events[0].event, "fraud_assessment_failed_non_blocking");
  assert.match(events[0].details.error, /risk fetch failed/);
  assert.match(errors[0].join(" "), /fraud_assessment_failed_non_blocking/);
});

function buildOrderJob(overrides = {}) {
  return {
    id: "job_123",
    shop: "example.myshopify.com",
    type: "order.create",
    shopifyOrderId: "gid://shopify/Order/123",
    provider: "zinc",
    attempts: 0,
    ...overrides,
  };
}
