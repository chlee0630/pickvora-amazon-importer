# Project Changelog

## 2026-06-21

### Documentation

- Added `docs/order-provider-handoff.md` for Gemini or another AI development tool to continue order provider work safely.
- Clarified local source state versus actual production server deployment state.
- Documented that local HEAD `66f9478 Prepare provider abstraction with Zinc as default` keeps Zinc as the default and rollback order provider.
- Documented that PriceYak remains skeleton-only and must not be enabled in production.
- Documented that PriceYak official order API support and documentation are still pending.

### Safety

- Reiterated provider-neutral HIGH fraud blocking, `requestPayload=null` and `responsePayload=null` preservation, `notifyCustomer=false`, and the ban on `refundCreate`.
- Reiterated that provider APIs must not be implemented from guessed endpoints, private browser requests, or undocumented network payloads.
- Confirmed no application code, tests, Prisma schema, `.env`, package files, Shopify TOML, production server files, or DB state were changed as part of this documentation handoff.

### Verified Baseline

- `git diff --check` passed.
- `npm test` baseline is 101 passed.
- `npm run typecheck` baseline passed.
- `npm run build` baseline passed.
- No actual order creation, Shopify mutation, production DB write, deployment, or systemd restart was performed.

### Known Build Warnings

- npm reports an unknown project config warning for `shamefully-hoist`.
- Some routes generate empty chunk messages.
- Vite warns that order, tracking, and fulfillment workers are used by both dynamic import and static import paths.
- These warnings are not current build failures, but should be reviewed during future npm or Vite upgrades.

---

## 2026-06-20

### Added

- Added documentation for order provider selector preparation for a future PriceYak transition.
- Documented `ORDER_PROVIDER` behavior:
  - unset defaults to `zinc`
  - `ORDER_PROVIDER=zinc` keeps Zinc selected
  - `ORDER_PROVIDER=priceyak` selects only the PriceYak skeleton provider
  - unsupported providers fail explicitly without fallback
- Documented the PriceYak skeleton provider at `app/services/order-providers/priceyak.server.js`.
- Documented that PriceYak `createOrder`, `getTracking`, `getOrderStatus`, and `cancelOrder` currently return safe `PRICEYAK_NOT_IMPLEMENTED` errors.

### Changed

- Documented that `order.create` enqueue provider priority is:
  - explicit provider argument
  - configured `ORDER_PROVIDER`
  - default `zinc`
- Documented that the orders/create webhook no longer hardcodes `provider: "zinc"` for new `order.create` jobs.
- Documented that HIGH fraud submit blocking is now provider-neutral while the existing `blockZincOnHighRisk` DB field name is preserved.
- Documented that `tracking.poll` selects providers from `job.provider`, defaults legacy missing-provider jobs to Zinc, and fails unsupported providers without fallback.
- Documented that `fulfillment.update` does not call Zinc or PriceYak APIs directly and remains driven by `ProviderOrder` plus tracking payload state.
- Documented that Shopify fulfillment input now uses `notifyCustomer=false`.

### Security

- Confirmed PriceYak live API calls are not implemented.
- Confirmed PriceYak endpoint, authentication, request payload, and response payload details were not guessed.
- Confirmed raw provider payload storage remains forbidden.
- Confirmed HIGH fraud block paths preserve `ProviderOrder.requestPayload=null` and `ProviderOrder.responsePayload=null`.
- Confirmed `refundCreate` was not added.
- Confirmed fulfillment no longer uses `notifyCustomer=true`.
- Confirmed no API keys, tokens, customer data, address data, payment data, browser payloads, raw order payloads, or raw provider payloads are documented.

### Verified

- `git diff --check` passed.
- `npm test` passed with 101 tests.
- Selector, order queue, order worker fraud block, tracking provider path, fulfillment provider-neutral, Shopify fulfillment notification, and Zinc rollback tests passed.

### Operational Notes

- Zinc remains the default and rollback order provider.
- Production must not set `ORDER_PROVIDER=priceyak` yet.
- PriceYak production order submission is not implemented and must not be used.
- PriceYak adapter implementation must wait for official PriceYak documentation or user-provided examples for authentication, order creation, status, tracking, cancellation, idempotency, error handling, retries, rate limits, timeouts, and payload redaction requirements.
- No production deploy, systemd restart, DB migration, Shopify mutation, order action, cancellation, refund, or fulfillment action is part of this documentation update.

---

## 2026-06-19

### Added

- Documented completed EasyParser production rollout on `prod-fraud-full-release`.
- Documented production Shopify authentication 401 runbook focused on server time/NTP checks.
- Documented production EasyParser import verification results for:
  - `B0GJ74JDGK`
  - `B0GVZ8QPQ5`
  - `B0GJFSB7PV`

### Changed

- Production Amazon product detail lookup now runs with `AMAZON_PRODUCT_PROVIDER=easyparser`.
- Production EasyParser runtime configuration is documented as:
  - `EASYPARSER_API_KEY` configured, value intentionally omitted
  - `EASYPARSER_DOMAIN=.com`
  - `EASYPARSER_TIMEOUT_MS=30000`
  - `EASYPARSER_MAX_RETRIES=3`
- Rainforest remains documented as the rollback provider through `AMAZON_PRODUCT_PROVIDER=rainforest`.
- Updated the operational interpretation of older `syncStatus=error` products with `Shopify API 401: Invalid API key or access token` as historical Shopify auth/token failures, not EasyParser rollout failures.

### Security

- Confirmed EasyParser API key values are not written to docs.
- Confirmed raw `id_token`, `hmac`, session values, `shopify-reload`, API keys, tokens, customer data, address data, payment data, and browser payloads must be masked before log sharing.
- Confirmed no DB writes, Shopify mutations, order actions, refunds, cancellations, or fulfillment actions are part of this documentation update.

### Verified

- EasyParser production import verification passed on 2026-06-19.
- Production import summary was `{ synced: 3 }`.
- Each verified product had `syncStatus=synced`, `syncError=null`, and generated Shopify product and variant IDs.
- `/app/import.data` returned `POST 200` during production import verification.
- `shopify_review_metafields_updated` logs were observed.
- No raw EasyParser `api_key` value was observed in logs.
- Dashboard, Products, Import ASIN, and Operations menus were normal after the auth fix.
- Session expiration recovery was verified through the flow: `No valid session found` -> `Requesting offline access token` -> `Creating new session` -> `/app 200`.

### Operational Notes

- The production 401 incident was traced primarily to server time/NTP drift.
- During diagnosis, `timedatectl` showed `System clock synchronized: no`, `Packet count: 0`, and `ntp.ubuntu.com:123` timeout behavior.
- Shopify `id_token` and session-token verification is time-sensitive, so server clock drift can prevent session creation.
- The server time was temporarily corrected against an HTTPS `Date` reference, then NTP was re-enabled.
- NTP recovery was confirmed with `System clock synchronized: yes`, `NTP service: active`, and increasing packet count.
- Production `.env` `SCOPES` were also aligned with `shopify.app.production.toml`, including order and inventory scopes required by the app.
- Reauth through `/auth?shop=cmgpwd-ty.myshopify.com` was confirmed to target the production shop.
- `/owa/auth/x.js` and `/api/merge` 404s are treated as external bot/scanner requests unless correlated with app behavior.
- Large-scale registration remains on hold. Next step is 10-item batches followed by 24-hour observation.

---

## 2026-06-18

### Added

- Added EasyParser as a new Amazon product detail provider.
- Added `app/services/amazon-product-provider.server.js` as the Amazon product data provider selector.
- Added `app/services/easyparser.server.js` for EasyParser Product Detail requests.
- Added `tests/easyparser-provider.test.js` for provider selection, request building, response normalization, rollback routing, and forbidden-pattern checks.
- Added EasyParser scaling config defaults:
  - `EASYPARSER_TIMEOUT_MS`
  - `EASYPARSER_MAX_RETRIES`

### Changed

- Changed the default Amazon product detail provider to EasyParser.
- Kept Rainforest API code in place as the legacy rollback provider.
- Updated `app/services/amazon-sync.server.js` to import `fetchProductDetails` from the provider selector instead of directly from Rainforest.
- Preserved `AMAZON_PRODUCT_PROVIDER=rainforest` rollback behavior.
- Normalized EasyParser responses to the existing Rainforest-compatible `amazonData` shape used by downstream Shopify product creation logic.
- Updated EasyParser payload detection so `result.detail` and nested `data.result.detail` are recognized before the broader `result` wrapper.
- Fixed the development-store import failure that surfaced as `Product title not found for ASIN` when EasyParser returned the real `result.detail` response shape.

### Security

- Added redaction coverage to ensure EasyParser API keys are not exposed in error messages.
- Avoided logging full EasyParser request URLs or raw query strings containing `api_key`.
- Confirmed the EasyParser provider work does not change order, Zinc, Fraud Protection, or fulfillment logic.
- Confirmed `.env`, Prisma schema, Shopify TOML, `package.json`, and `package-lock.json` were not changed.

### Verified

- `git diff --check` passed.
- `npm test` passed with 73 tests after adding real EasyParser wrapper coverage.
- `npm run typecheck` passed.
- `npm run build` passed.
- EasyParser forbidden-pattern guard tests were added and passed.
- EasyParser real response wrapper tests passed for `result.detail` and nested `data.result.detail`.
- Development-store import on `pickvora-dev.myshopify.com` succeeded with ASIN `B0GJ74JDGK` using the EasyParser provider.

### Operational Notes

- EasyParser Product Detail request structure:

```text
GET https://realtime.easyparser.com/v1/request
  ?api_key=...
  &platform=AMZ
  &operation=DETAIL
  &domain=.com
  &asin=<ASIN>
```

- Production deployment has not been completed.
- Production systemd EasyParser environment variables have not been added.
- Development-store live API validation passed for ASIN `B0GJ74JDGK`; production rollout remains pending.
- Rainforest rollback remains available with:

```text
AMAZON_PRODUCT_PROVIDER=rainforest
```

---

## 2026-06-13

### Added

- Added production-safe fraud refund guard for `cmgpwd-ty.myshopify.com`.
- Added guarded Shopify `orderCancel` refund support using `refundMethod.originalPaymentMethodsRefund=true`.
- Added production refund eligibility checks for:
  - production runtime
  - exact production shop
  - `FRAUD_ORDER_CANCEL_ENABLED=true`
  - `FRAUD_ORDER_REFUND_ENABLED=true`
  - live fraud config
  - HIGH risk cancel decision
  - Zinc block enabled
  - no prior cancellation status
  - `notifyCustomer=false`
- Added `OrderWebhookLog.payload` allowlist sanitizer.
- Added `OrderQueueJob.payload` allowlist sanitizer for `order.create`.
- Added sanitizer tests for webhook log payloads and order queue job payloads.
- Added production fraud refund tests for guarded refund behavior and blocked refund behavior.
- Added systemd environment guard for:
  - `pickvora-web`
  - `pickvora-tracking-worker`

### Changed

- `order.create` queue jobs no longer persist raw Shopify webhook payloads.
- Workers continue to fetch required order details through Shopify Admin API read-only queries instead of relying on sensitive queue payloads.
- Fraud HIGH-risk orders now block Zinc submit before provider submission.
- Fraud cancellation can restock inventory and refund the original payment method when production refund guards pass.
- Fraud monitoring events use safe summary fields and keep `notifyCustomer=false`.

### Security

- Prevented storage of raw customer, address, payment, token, browser, and order status URL data in:
  - `OrderWebhookLog.payload`
  - `OrderQueueJob.payload`
- Preserved `ProviderOrder.requestPayload=null` and `ProviderOrder.responsePayload=null` for HIGH fraud block paths.
- Confirmed `refundCreate` is not used.
- Confirmed fraud cancellation/refund does not set `notifyCustomer=true`.
- Confirmed raw GraphQL variables are not persisted.

### Verified

Development E2E order `#1023` passed:

- `webhookSafe=true`
- `queueCreateSafe=true`
- `assessmentCancelled=true`
- `providerBlocked=true`
- `cancelPollComplete=true`
- `refundRequestedSafely=true`
- `overallPass=true`

Production deployment verified:

- production branch: `prod-fraud-full-release`
- production commit: `73a5355 Add production fraud refund guard and payload sanitizers`
- server path: `/var/www/pickvora-amazon-importer`
- `npm install` completed
- `npm run typecheck` passed
- `npm run build` passed
- `pickvora-web` active
- `pickvora-tracking-worker` active
- systemd fraud env flags confirmed for both services
- production config set to live fraud refund mode

Final live production config:

```text
enabled=true
dryRun=false
autoCancelHighRisk=true
autoCancelMediumRisk=false
blockZincOnHighRisk=true
restockInventory=true
refundPayment=true
notifyCustomer=false
```

### Operational Notes

Expected production HIGH fraud flow:

1. Zinc submit is blocked before provider submission.
2. `ProviderOrder` is moved to `MANUAL_REVIEW`.
3. Shopify `orderCancel` is requested.
4. Inventory is restocked when eligible.
5. Original payment method refund is requested.
6. Customer notification remains disabled.
7. `fraud.cancel.poll` confirms cancellation completion.

Expected monitoring events:

```text
fraud_order_cancel_options_resolved
fraud_order_cancel_request_prepared
fraud_order_cancel_response_received
fraud_order_cancel_requested
fraud_order_cancel_confirmed
```

### Rollback

Emergency rollback returns production config to dry-run and disables refund:

```text
dryRun=true
refundPayment=false
notifyCustomer=false
```

---

# @shopify/shopify-app-template-react-router

## 2026.02.09
- Add declarative product metafield definition and demonstrate metafield usage in the product creation flow
- Add declarative metaobject definition and demonstrate metaobject upsert in the product creation flow

## 2026.01.08
- [#170](https://github.com/Shopify/shopify-app-template-react-router/pull/170) - Update React Router minimum version to v7.12.0

## 2025.12.11

- [#151](https://github.com/Shopify/shopify-app-template-react-router/pull/151) Update `@shopify/shopify-app-react-router` to v1.1.0 and `@shopify/shopify-app-session-storage-prisma` to v8.0.0, add refresh token fields (`refreshToken` and `refreshTokenExpires`) to Session model in Prisma schema, and adopt the `expiringOfflineAccessTokens` flag for enhanced security through token rotation. See [expiring vs non-expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens) for more information.

## 2025.10.10

- [#95](https://github.com/Shopify/shopify-app-template-react-router/pull/95) Swap the product link for [admin intents](https://shopify.dev/docs/apps/build/admin/admin-intents).

## 2025.10.02

- [#81](https://github.com/Shopify/shopify-app-template-react-router/pull/81) Add shopify global to eslint for ui extensions

## 2025.10.01

- [#79](https://github.com/Shopify/shopify-app-template-react-router/pull/78) Update API version to 2025-10.
- [#77](https://github.com/Shopify/shopify-app-template-react-router/pull/77) Update `@shopify/shopify-app-react-router` to V1.
- [#73](https://github.com/Shopify/shopify-app-template-react-router/pull/73/files) Rename @shopify/app-bridge-ui-types to @shopify/polaris-types

## 2025.08.30

- [#70](https://github.com/Shopify/shopify-app-template-react-router/pull/70/files) Upgrade `@shopify/app-bridge-ui-types` from 0.2.1 to 0.3.1.

## 2025.08.17

- [#58](https://github.com/Shopify/shopify-app-template-react-router/pull/58) Update Shopify & React Router dependencies.  Use Shopify React Router in graphqlrc, not shopify-api
- [#57](https://github.com/Shopify/shopify-app-template-react-router/pull/57) Update Webhook API version in `shopify.app.toml` to `2025-07`
- [#56](https://github.com/Shopify/shopify-app-template-react-router/pull/56) Remove local CLI from package.json in favor of global CLI installation
- [#53](https://github.com/Shopify/shopify-app-template-react-router/pull/53) Add the Shopify Dev MCP to the template

## 2025.08.16

- [#52](https://github.com/Shopify/shopify-app-template-react-router/pull/52) Use `ApiVersion.July25` rather than `LATEST_API_VERSION` in `.graphqlrc`.

## 2025.07.24

- [14](https://github.com/Shopify/shopify-app-template-react-router/pull/14/files) Add [App Bridge web components](https://shopify.dev/docs/api/app-home/app-bridge-web-components) to the template.

## July 2025

Forked the [shopify-app-template repo](https://github.com/Shopify/shopify-app-template-remix)

# @shopify/shopify-app-template-remix

## 2025.03.18

-[#998](https://github.com/Shopify/shopify-app-template-remix/pull/998) Update to Vite 6

## 2025.03.01

- [#982](https://github.com/Shopify/shopify-app-template-remix/pull/982) Add Shopify Dev Assistant extension to the VSCode extension recommendations

## 2025.01.31

- [#952](https://github.com/Shopify/shopify-app-template-remix/pull/952) Update to Shopify App API v2025-01

## 2025.01.23

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Update `@shopify/shopify-app-session-storage-prisma` to v6.0.0

## 2025.01.8

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Enable GraphQL autocomplete for Javascript

## 2024.12.19

- [#904](https://github.com/Shopify/shopify-app-template-remix/pull/904) bump `@shopify/app-bridge-react` to latest
-
## 2024.12.18

- [875](https://github.com/Shopify/shopify-app-template-remix/pull/875) Add Scopes Update Webhook
## 2024.12.05

- [#910](https://github.com/Shopify/shopify-app-template-remix/pull/910) Install `openssl` in Docker image to fix Prisma (see [#25817](https://github.com/prisma/prisma/issues/25817#issuecomment-2538544254))
- [#907](https://github.com/Shopify/shopify-app-template-remix/pull/907) Move `@remix-run/fs-routes` to `dependencies` to fix Docker image build
- [#899](https://github.com/Shopify/shopify-app-template-remix/pull/899) Disable v3_singleFetch flag
- [#898](https://github.com/Shopify/shopify-app-template-remix/pull/898) Enable the `removeRest` future flag so new apps aren't tempted to use the REST Admin API.

## 2024.12.04

- [#891](https://github.com/Shopify/shopify-app-template-remix/pull/891) Enable remix future flags.

## 2024.11.26

- [888](https://github.com/Shopify/shopify-app-template-remix/pull/888) Update restResources version to 2024-10

## 2024.11.06

- [881](https://github.com/Shopify/shopify-app-template-remix/pull/881) Update to the productCreate mutation to use the new ProductCreateInput type

## 2024.10.29

- [876](https://github.com/Shopify/shopify-app-template-remix/pull/876) Update shopify-app-remix to v3.4.0 and shopify-app-session-storage-prisma to v5.1.5

## 2024.10.02

- [863](https://github.com/Shopify/shopify-app-template-remix/pull/863) Update to Shopify App API v2024-10 and shopify-app-remix v3.3.2

## 2024.09.18

- [850](https://github.com/Shopify/shopify-app-template-remix/pull/850) Removed "~" import alias

## 2024.09.17

- [842](https://github.com/Shopify/shopify-app-template-remix/pull/842) Move webhook processing to individual routes

## 2024.08.19

Replaced deprecated `productVariantUpdate` with `productVariantsBulkUpdate`

## v2024.08.06

Allow `SHOP_REDACT` webhook to process without admin context

## v2024.07.16

Started tracking changes and releases using calver
