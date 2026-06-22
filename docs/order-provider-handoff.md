# Order Provider Handoff

Last updated: 2026-06-22.

This handoff is for continuing the Shopify Amazon Importer order provider work with another AI development tool. It summarizes the current local source state and the next safe work points. It does not prove that the same source is deployed in production.

## Repository And Environment

Local repository:

```text
C:\mydata\project\shopify\pickvora-amazon-importer
```

Production repository path:

```text
/var/www/pickvora-amazon-importer
```

Branch:

```text
prod-fraud-full-release
```

Handoff baseline confirmed before this documentation correction:

```text
9ed1f45 Document Zinc dry-run and test-success handoff
```

Stores:

```text
production: cmgpwd-ty.myshopify.com
development: pickvora-dev.myshopify.com
```

Product import provider status:

- EasyParser production rollout is complete.
- Product import provider work is separate from order provider work.

Order provider status:

- Zinc remains the current default order provider.
- PriceYak order API availability is still pending support confirmation.
- Official PriceYak order API documentation has not been received.
- Local provider abstraction work is present from commit `66f9478 Prepare provider abstraction with Zinc as default`.

Protected dev evidence order:

- Development order `#1024` on `pickvora-dev.myshopify.com` is a protected Zinc dry-run evidence order.
- Its confirmed state is `ProviderOrder.status = ZINC_DRY_RUN`.
- It must not be reprocessed, replayed, injected, canceled, refunded, fulfilled, or used for queue replay.
- Development order `#1025` on `pickvora-dev.myshopify.com` is a protected Zinc test-success evidence order.
- Its confirmed state is `ProviderOrder.status = ZINC_SUBMITTED`.
- It must not be reprocessed, replayed, injected, canceled, refunded, fulfilled, or used for queue replay.

## Local Source State Vs Production State

Local source code state:

- Provider selector work is present at local commit `66f9478`.
- `ORDER_PROVIDER` can select `zinc` or the PriceYak skeleton.
- PriceYak live order submission, status, tracking, and cancellation are not implemented.
- The Zinc test-success path was verified on 2026-06-22 through external submit success on `#1025`, but follow-up tracking and fulfillment responses were not awaited.
- Internal mock checks for synthetic tracking orchestration, fulfillment input safety, and provider-neutral fulfillment passed without external API or DB access.

Production server state:

- Do not infer deployment from local Git history.
- Check `/var/www/pickvora-amazon-importer` directly before stating what is deployed.
- Do not deploy, restart services, run migrations, or change production environment without explicit user approval.

## Validation Baseline

Verified on 2026-06-21:

```text
git diff --check: passed
npm test: 101 passed
npm run typecheck: passed
npm run build: passed
```

No actual order creation, Shopify mutation, production DB write, deployment, or systemd restart was performed during this validation.

Known non-blocking build warnings:

- npm reports an unknown project config warning for `shamefully-hoist`.
- Some routes generate empty chunk messages.
- Vite warns that order, tracking, and fulfillment workers are used by both dynamic import and static import paths.

These warnings did not fail the current build, but should be reviewed during future npm or Vite upgrades.

## Provider Selector

Order provider selection is based on `ORDER_PROVIDER`.

Priority:

```text
explicit provider argument
configured ORDER_PROVIDER
default zinc
```

Current behavior:

- `ORDER_PROVIDER` unset selects `zinc`.
- `ORDER_PROVIDER=zinc` selects Zinc.
- `ORDER_PROVIDER=priceyak` selects only the PriceYak skeleton.
- Unsupported provider names fail explicitly and do not fall back to Zinc.
- Zinc provider code remains the rollback provider.

## PriceYak Skeleton

File:

```text
app/services/order-providers/priceyak.server.js
```

Current status:

- No real API calls.
- No endpoint, authentication, request body, or response mapping implementation.
- `createOrder`, `getOrderStatus`, `getTracking`, and `cancelOrder` raise safe `PRICEYAK_NOT_IMPLEMENTED` errors.
- Production must not set `ORDER_PROVIDER=priceyak`.
- Implementation must wait for official PriceYak documentation or official request/response examples.
- Do not implement from guessed endpoints, private web requests, browser Network payloads, or undocumented behavior.

## Current Order Flow

```text
Shopify orders/create webhook
-> safe payload 저장
-> order.create queue
-> provider selector
-> Shopify 주문 상세 read
-> Fraud Protection
-> provider submit
-> tracking.poll
-> tracking receipt
-> fulfillment.update
-> Shopify fulfillment sync
```

The webhook route must remain lightweight and must not call order providers directly.

## Fraud Protection

- HIGH fraud provider block is provider-neutral.
- The same HIGH-risk block rule applies to Zinc and any future provider.
- HIGH fraud block stops before provider submit.
- HIGH fraud block preserves:

```text
ProviderOrder.requestPayload = null
ProviderOrder.responsePayload = null
```

- The DB field remains `blockZincOnHighRisk` for schema compatibility.
- Internally, treat `blockZincOnHighRisk` as HIGH-risk provider submit block.
- Protected historical test orders `#1005` through `#1023` must not be modified, retried, canceled, refunded, fulfilled, or reprocessed.
- Do not add `refundCreate`.

## Tracking

- `tracking.poll` selects the provider from `job.provider`.
- Legacy tracking jobs with no provider default to Zinc.
- Unsupported providers fail explicitly and do not fall back.
- PriceYak tracking is not implemented.
- `job.provider=priceyak` currently reaches the PriceYak skeleton safe not-implemented path.
- `ZINC_SUBMITTED` remains the Zinc-compatible polling state.
- Do not add guessed PriceYak status values before an official status contract exists.

## Fulfillment

- Fulfillment worker/service does not call Zinc or PriceYak APIs directly.
- Fulfillment uses `ProviderOrder` and tracking payload state, then calls the Shopify fulfillment helper.
- Missing tracking number or missing `trackingReceivedAt` fails before Shopify fulfillment is requested.
- A provider value of `priceyak` does not block fulfillment if valid tracking data already exists.
- Shopify `fulfillmentCreate` input uses `notifyCustomer: false`.
- `notifyCustomer: true` is forbidden.
- `refundCreate` is not present and must not be added.

## Privacy And Log Safety

Never store, log, or document:

- API key
- secret
- token
- `id_token`
- HMAC
- session value
- Authorization header
- customer name
- customer address
- phone number
- email
- payment information
- browser payload
- raw Shopify order payload
- raw provider request or response
- URL or query string containing authentication material

Only safe summaries may be persisted or written to monitoring/log output.

## Prisma And Queue State

No Prisma migration was required for the current provider transition preparation.

Existing string provider fields can carry provider names:

- `ProviderOrder.provider`
- `OrderQueueJob.provider`
- `DeadLetterQueueJob.provider`

Future schema changes may be needed only if a new provider requires multi-shipment, multi-tracking, or provider-specific sub-order modeling.

## Adding PriceYak Or Another Provider

Do this only from official provider documentation or official examples:

1. Obtain official order API documentation.
2. Confirm order creation, status, tracking, cancel, error, idempotency, rate limit, retry, and timeout contracts.
3. Add a provider adapter file.
4. Register it in the provider selector.
5. Implement request and response sanitizers.
6. Add unit and mock tests.
7. Validate sandbox or dry-run behavior.
8. Run development-store end-to-end validation.
9. Complete an operations checklist.
10. Deploy only after explicit approval.

Minimum provider capabilities:

- order creation
- provider order ID
- order status lookup
- tracking lookup
- carrier and tracking number fields
- duplicate order prevention or idempotency support
- documented error codes
- documented rate limit and timeout policy
- sandbox or test mode strongly preferred

## Operating Safety Rules

- Do not create, modify, cancel, refund, or fulfill production orders.
- Do not modify protected historical orders `#1005` through `#1023`.
- Do not write to the production DB with `UPDATE`, `DELETE`, or `INSERT`.
- Do not modify `.env` files without explicit instruction.
- Do not deploy to production without explicit approval.
- Do not restart systemd services without explicit approval.
- Do not run DB migrations without explicit approval.
- Do not run Shopify mutations without explicit approval for the exact action.
- Do not add `refundCreate`.
- Do not set `notifyCustomer=true`.
- Do not implement provider APIs from guesses or undocumented network traffic.

## Next Priorities

- Check the PriceYak support response.
- If PriceYak has no official order API, investigate another provider with documented order APIs.
- Keep Zinc as the default provider while provider research continues.
- If needed, prepare a development-store Zinc regression test plan.
- Keep production deployment as a separate approval step.

## Next AI Session Checklist

1. Read `AGENTS.md`, `current-architecture.md`, `CHANGELOG.md`, and this handoff.
2. Check Git branch, status, and recent log before changing files.
3. Confirm `#1005` through `#1025` are protected and not eligible for replay or mutation.
4. Reconfirm the Zinc dry-run result for `#1024` and the verified test-success submit result for `#1025`, while separating both from implemented behavior.
5. Confirm Zinc remains the default order provider.
6. Confirm PriceYak remains skeleton-only.
7. Use only a new dev order if further Zinc end-to-end work is approved.
8. Check the temporary dev environment gate before any submit path.
9. Do not infer production deployment; verify production server state separately.
10. Write a patch plan before code changes.
11. Confirm baseline with tests, typecheck, and build before risky work.
12. Get user approval before any live Zinc submit, test tracking injection, Shopify fulfillment mutation, or production operation.
