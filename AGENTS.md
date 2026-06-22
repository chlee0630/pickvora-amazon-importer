# Codex / Agent Rules

These rules apply to all AI-assisted changes in this repository.

## General Rules

- Do not run `npm run dev`.
- Preserve the existing project structure.
- Avoid unnecessary refactoring.
- Never modify `.env` files.
- Minimize package/version changes.
- Prefer small, isolated commits.
- Do not change Prisma schema unless explicitly requested.
- Do not change production Shopify app TOML files unless explicitly requested.
- Do not run Shopify mutations unless the user explicitly authorizes the exact production action.

## Production Safety Rules

Production safety is the highest priority.

Always preserve:

- webhook enqueue architecture
- async worker processing
- retry-safe queue behavior
- idempotency protections
- duplicate Zinc order prevention
- duplicate fulfillment prevention
- dead letter queue behavior
- structured monitoring and audit logging

Never:

- perform heavy processing inside webhook routes
- call Zinc directly from webhook routes
- store raw customer, address, token, payment, or browser data in logs/queue payloads
- store raw GraphQL variables for fraud cancellation/refund
- weaken ProviderOrder `requestPayload=null` / `responsePayload=null` policy for HIGH fraud block paths
- add `refundCreate`
- set `notifyCustomer=true` for fraud cancellation/refund
- bypass cancellation-status duplicate protection

## Current Production Fraud Refund Status

Production fraud refund is live as of 2026-06-13.

Production branch:

- `prod-fraud-full-release`

Current production commit:

- `b0862b5 Document Zinc test-success validation`

Current production order-provider deployment baseline:

- Production deployment completed on 2026-06-23 and remains active until separately changed.

Production shop:

- `cmgpwd-ty.myshopify.com`

Production services:

- `pickvora-web`
- `pickvora-tracking-worker`

Required service environment flags:

```text
FRAUD_ORDER_CANCEL_ENABLED=true
FRAUD_ORDER_REFUND_ENABLED=true
```

Current live production config:

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

## Fraud Refund Guard Rules

Production refund is allowed only when all guards pass:

- runtime is production
- shop is exactly `cmgpwd-ty.myshopify.com`
- `FRAUD_ORDER_CANCEL_ENABLED=true`
- `FRAUD_ORDER_REFUND_ENABLED=true`
- config `enabled=true`
- config `dryRun=false`
- config `autoCancelHighRisk=true`
- config `blockZincOnHighRisk=true`
- config `refundPayment=true`
- config `notifyCustomer=false`
- risk level is `HIGH`
- decision is `CANCEL_REQUIRED`
- cancellation has not already been recorded
- order is not protected historical test data

Protected historical orders:

```text
#1005 through #1025
```

- Development order `#1025` is protected Zinc test-success evidence and must not be replayed, injected, canceled, refunded, or fulfilled.

Allowed mutation behavior:

- Shopify `orderCancel`
- `restock=true` when eligible
- `refundMethod.originalPaymentMethodsRefund=true` only when refund guards pass
- `notifyCustomer=false`

Forbidden mutation behavior:

- `refundCreate`
- `notifyCustomer=true`
- repeat `orderCancel` after cancellation status exists

## Payload Sanitizer Rules

`OrderWebhookLog.payload` and `OrderQueueJob.payload` for `order.create` must store only:

```text
id
admin_graphql_api_id
name
test
financial_status
fulfillment_status
total_price
currency
line_items[].product_id
line_items[].variant_id
line_items[].sku
line_items[].title
line_items[].quantity
```

Blocked terms must not be stored:

```text
contact_email
email
phone
token
cart_token
checkout_token
order_status_url
authenticate
customer
billing_address
shipping_address
client_details
browser_ip
payment
address
secret
```

Normal order workers must fetch required sensitive order details through Shopify Admin API read-only queries at processing time instead of relying on queue payload.

## Order Provider Handoff Rules

As of local commit `66f9478 Prepare provider abstraction with Zinc as default`, local source code has the order provider abstraction needed for a future PriceYak or other order provider adapter. This local source state is not proof of production deployment. Verify `/var/www/pickvora-amazon-importer` separately before making production claims.

Current order provider rules:

- Zinc remains the default and rollback order provider.
- `ORDER_PROVIDER` unset must default to `zinc`.
- Provider selection priority is explicit provider argument, configured `ORDER_PROVIDER`, then default `zinc`.
- Unsupported providers must fail explicitly and must not silently fall back to Zinc.
- Do not set production `ORDER_PROVIDER=priceyak`.
- `app/services/order-providers/priceyak.server.js` is a skeleton only.
- PriceYak `createOrder`, `getOrderStatus`, `getTracking`, and `cancelOrder` must remain safe not-implemented behavior until official API documentation or user-provided official request/response examples are available.
- Do not implement PriceYak or any order provider from guessed endpoints, private browser requests, or unverified network payloads.

Order provider safety rules:

- HIGH fraud provider submit blocking is provider-neutral; it applies to Zinc and any future provider.
- HIGH fraud block paths must stop before provider submit and preserve `ProviderOrder.requestPayload=null` and `ProviderOrder.responsePayload=null`.
- The DB field name `blockZincOnHighRisk` remains for schema compatibility and is interpreted as HIGH-risk provider submit block.
- `tracking.poll` uses `job.provider`; missing legacy provider defaults to Zinc, and unsupported providers fail without fallback.
- `fulfillment.update` must not call Zinc, PriceYak, or other provider APIs directly.
- Shopify fulfillment input must keep `notifyCustomer=false`; never add `notifyCustomer=true`.
- Never add `refundCreate`.
- `#1024` is a protected Zinc dry-run evidence order; do not reprocess, replay, inject tracking into, or use for fulfillment mutation.
- `#1025` is a protected Zinc test-success evidence order; do not reprocess, replay, inject tracking into, or use for fulfillment mutation.

Before another AI tool continues order provider work, read `docs/order-provider-handoff.md`, `current-architecture.md`, `CHANGELOG.md`, and this file. Prepare a patch plan before code changes, run the validation baseline, and get explicit user approval before any production operation.

## Amazon Product Provider Rules

EasyParser is the default Amazon product detail provider as of local commit:

- `bb15b81 Add EasyParser product provider`

Provider files:

- `app/services/amazon-product-provider.server.js`
- `app/services/easyparser.server.js`
- `app/services/rainforest.server.js`

Rules:

- Keep the provider selector structure in `amazon-product-provider.server.js`.
- Do not delete `rainforest.server.js`; Rainforest remains the legacy rollback provider.
- Default Amazon product detail lookup should use EasyParser.
- `AMAZON_PRODUCT_PROVIDER=rainforest` must continue to roll back product detail lookup to Rainforest.
- Do not log `EASYPARSER_API_KEY`, full EasyParser request URLs, or unredacted query strings containing `api_key`.
- EasyParser responses must normalize to the existing Rainforest-compatible `amazonData` shape used by downstream import and Shopify product creation code.
- Keep normalizer tests for EasyParser wrapper changes, including the observed `result.detail` and `data.result.detail` payload shapes.
- Keep EasyParser ASIN Product Detail lookup independent from order, Zinc, Fraud Protection, and fulfillment flows.
- Do not modify `.env` files when adding or changing EasyParser configuration.
- Use systemd environment configuration for production deployment.
- Re-run development-store real API testing after EasyParser response-shape changes and before production rollout.

EasyParser Product Detail request shape:

```text
GET https://realtime.easyparser.com/v1/request
  ?api_key=...
  &platform=AMZ
  &operation=DETAIL
  &domain=.com
  &asin=<ASIN>
```

Current EasyParser rollout status:

- production rollout completed on 2026-06-19
- production branch is `prod-fraud-full-release`
- production server path is `/var/www/pickvora-amazon-importer`
- production store is `cmgpwd-ty.myshopify.com`
- production uses `AMAZON_PRODUCT_PROVIDER=easyparser`
- production has `EASYPARSER_API_KEY` configured, but the key value must never be written to docs or logs
- production uses `EASYPARSER_DOMAIN=.com`, `EASYPARSER_TIMEOUT_MS=30000`, and `EASYPARSER_MAX_RETRIES=3`
- development-store import validation passed for `pickvora-dev.myshopify.com` with ASIN `B0GJ74JDGK`
- production import validation passed for ASINs `B0GJ74JDGK`, `B0GVZ8QPQ5`, and `B0GJFSB7PV`
- Rainforest remains available through `AMAZON_PRODUCT_PROVIDER=rainforest`
- pre-2026-06-10 `syncStatus=error` products with Shopify API 401 errors are historical auth/token failures, not EasyParser rollout failures
- do not retry historical error products or write DB changes during documentation-only work

## Production Shopify Auth 401 Guard

If production returns `401 Unauthorized`, check these before reinstalling the app or changing code:

1. `timedatectl status`
2. `timedatectl timesync-status`
3. Session table state
4. `.env` `SCOPES` alignment with `shopify.app.production.toml` scopes
5. `/auth?shop=cmgpwd-ty.myshopify.com` reauth flow targets the production shop

Rules:

- If `timedatectl` shows `System clock synchronized: no`, Shopify `id_token` and session-token validation can fail.
- Do not repeat app reinstalls, code rollbacks, or DB session deletion loops before fixing NTP/time synchronization.
- Keep outbound UDP 123 available for NTP on the VPS/network firewall.
- Mask `id_token`, `hmac`, session identifiers, `shopify-reload`, `api_key`, tokens, and secrets before sharing logs.
- Do not write production DB changes without a backup.
- The production app uninstall webhook currently deletes Session records only.
- Before reinstalling the production app, take a DB backup first.

## Required Validation

Before committing fraud/order/queue/security changes:

```bash
git diff --check
npm test
npm run typecheck
npm run build
```

Recommended forbidden-pattern checks:

```bash
git grep -n "refundCreate" -- app tests scripts
git grep -n "notifyCustomer.*true\|notifyCustomer: true" -- app tests scripts
git grep -n "requestPayload.*variables\|variables.*requestPayload" -- app tests scripts
git grep -n "order_status_url\|checkout_token\|cart_token\|browser_ip\|client_details" -- app tests scripts
```

For untracked files, use:

```powershell
Select-String -Path .\app\**\*.js,.\app\**\*.jsx,.\tests\*.js,.\scripts\*.js -Pattern "refundCreate"
Select-String -Path .\app\**\*.js,.\app\**\*.jsx,.\tests\*.js,.\scripts\*.js -Pattern "notifyCustomer:\s*true|notifyCustomer.*true"
Select-String -Path .\app\**\*.js,.\app\**\*.jsx,.\tests\*.js,.\scripts\*.js -Pattern "requestPayload.*variables|variables.*requestPayload"
Select-String -Path .\app\**\*.js,.\app\**\*.jsx,.\tests\*.js,.\scripts\*.js -Pattern "order_status_url|checkout_token|cart_token|browser_ip|client_details"
```

## Production Deployment Checks

After deployment on the server:

```bash
git log --oneline -5
npm run typecheck
npm run build
systemctl status pickvora-web --no-pager -l
systemctl status pickvora-tracking-worker --no-pager -l
systemctl show pickvora-web -p Environment --value | tr ' ' '\n' | grep FRAUD_ORDER
systemctl show pickvora-tracking-worker -p Environment --value | tr ' ' '\n' | grep FRAUD_ORDER
```

## Emergency Rollback

To disable live production fraud refund/cancel behavior:

```bash
cd /var/www/pickvora-amazon-importer

cat > ./tmp-disable-prod-fraud-refund-config.mjs <<'EOF'
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const shop = "cmgpwd-ty.myshopify.com";

const updated = await prisma.fraudProtectionConfig.update({
  where: { shop },
  data: {
    enabled: true,
    dryRun: true,
    autoCancelHighRisk: true,
    autoCancelMediumRisk: false,
    blockZincOnHighRisk: true,
    restockInventory: true,
    refundPayment: false,
    notifyCustomer: false,
  },
});

console.log(JSON.stringify({ mode: "rollback", updated }, null, 2));
await prisma.$disconnect();
EOF

node ./tmp-disable-prod-fraud-refund-config.mjs
rm -f ./tmp-disable-prod-fraud-refund-config.mjs
```
