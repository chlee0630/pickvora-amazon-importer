# Project Changelog

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
