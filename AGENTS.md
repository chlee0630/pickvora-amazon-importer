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

- `73a5355 Add production fraud refund guard and payload sanitizers`

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
#1005 through #1023
```

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
