# Current Architecture



## Project Overview



This project is a Shopify Amazon automation app.



Main goals:



* Import Amazon products into Shopify

* Process Shopify orders automatically

* Submit Amazon orders through Zinc API

* Sync fulfillment tracking back to Shopify

* Maintain production-safe async architecture



---



# Current Stack



## Backend



* Node.js

* Express

* Shopify Admin API

* Shopify Webhooks

* MySQL

* Redis Queue

* BullMQ-style async workers



## External APIs



* EasyParser API

* Rainforest API legacy rollback provider

* Zinc API



## Frontend



* Shopify Polaris

* Shopify App Bridge



---



# Important Business Rules



## Inventory



Inventory quantity sync is intentionally disabled.



Use:



* availability-based selling only



Never implement:



* inventory quantity synchronization

* inventory polling



---



# Shipping Rules



Only support:



* US mainland free shipping



Exclude:



* Alaska

* Hawaii

* Puerto Rico



---



# Current Architecture



## Webhook Flow



Shopify webhook

→ webhook validation

→ enqueue async job

→ immediate HTTP 200 response



Heavy processing must NEVER run inside webhook routes.



---



# Queue Architecture



Current system uses:



* async queue workers

* retry-safe processing

* exponential backoff

* dead letter queue support

* idempotent workers

* order locking



---



# Current Order Flow



1. Shopify order webhook received

2. Validate webhook signature

3. Store webhook logs

4. Enqueue async order job

5. Order worker loads order

6. Build normalized order payload

7. Submit Zinc order

8. Save Zinc response

9. Tracking polling worker checks tracking

10. Fulfillment worker updates Shopify fulfillment

11. Save fulfillment logs



---



# Current Implemented Features



## Completed



* webhook enqueue architecture

* async order workers

* Zinc provider integration

* provider abstraction layer

* tracking polling workers

* fulfillment update workers

* retry-safe queue processing

* dead letter queue system

* monitoring layer

* analytics aggregation layer

* duplicate webhook prevention

* duplicate Zinc order prevention

* duplicate fulfillment prevention

* structured logging

* retry exhaustion handling

* operations dashboard



---



# Current Order States



Supported states:



* PENDING

* PROCESSING

* ZINC_SUBMITTED

* ORDERED

* TRACKING_RECEIVED

* FULFILLED

* FAILED

* MANUAL_REVIEW



---



# Provider Architecture



Provider abstraction is REQUIRED.



Current provider structure:



/services/order-providers



Examples:



* base-provider

* zinc-provider



Business logic must NOT tightly couple to Zinc-specific implementations.



All providers should support:



* createOrder()

* getOrderStatus()

* getTracking()

* cancelOrder()



---



# Amazon Product Data Provider Architecture



Amazon product detail import now uses a provider selector separate from the order provider architecture.



Current product data provider files:



* `app/services/amazon-product-provider.server.js`

* `app/services/easyparser.server.js`

* `app/services/rainforest.server.js`



Provider behavior:



* EasyParser is the default Amazon product detail provider.

* Rainforest remains in the codebase as a legacy rollback provider.

* `AMAZON_PRODUCT_PROVIDER=rainforest` switches product detail lookup back to Rainforest.

* `app/services/amazon-sync.server.js` imports `fetchProductDetails` only from the provider selector.

* Downstream import and Shopify product creation code should not need to know which provider returned the data.



EasyParser Product Detail request:



```text
GET https://realtime.easyparser.com/v1/request
  ?api_key=...
  &platform=AMZ
  &operation=DETAIL
  &domain=.com
  &asin=<ASIN>
```



EasyParser response handling:



* EasyParser responses are normalized to the existing Rainforest-compatible `amazonData` shape.

* `EASYPARSER_API_KEY` and full request URLs must not be logged.

* Product detail lookup is ASIN-based and isolated from order processing.



Current rollout status:



* Local feature branch: `feature/easyparser-provider-default`

* EasyParser provider commit: `bb15b81 Add EasyParser product provider`

* Production deployment has not been completed.

* Production systemd EasyParser environment variables have not been added.

* Development-store live API validation remains the next required step.



Separation rules:



* EasyParser product lookup must stay independent from Zinc order submission.

* EasyParser product lookup must stay independent from Fraud Protection cancellation/refund logic.

* EasyParser product lookup must stay independent from fulfillment and tracking workers.

* Rainforest provider code must remain available for rollback.



---



# Current Queue Rules



Workers must support:



* retry-safe execution

* timeout handling

* exponential backoff

* duplicate prevention

* idempotency

* structured logging

* dead letter queue handling



Webhook routes must:



* validate webhook

* enqueue only

* return immediately



Never:



* perform heavy processing in webhook routes

* call Zinc API directly from webhook routes



---



# Fulfillment Rules



Must:



* preserve fulfillment history

* prevent duplicate fulfillment creation

* validate tracking data

* support retry-safe fulfillment updates



Never:



* overwrite fulfillment history

* create duplicate fulfillments



---



# Monitoring & Analytics



Current monitoring includes:



* queue health monitoring

* worker failure monitoring

* retry monitoring

* DLQ monitoring

* API failure monitoring

* fulfillment monitoring

* worker heartbeat monitoring

* provider health monitoring

* tracking polling delay monitoring

* queue backlog threshold monitoring

* fulfillment exception monitoring

* fulfillment delay monitoring

* provider outage monitoring



Current analytics includes:



* order success metrics

* retry metrics

* fulfillment metrics

* worker performance metrics

* API latency metrics

* DLQ metrics

* fulfillment exception analytics

* invalid tracking analytics

* fulfillment delay analytics

* duplicate fulfillment prevention analytics

* provider health analytics

* API failure trend analytics

* carrier issue analytics

* manual review analytics



---



# Operations Dashboard



Current dashboard includes:



* operations overview

* failed orders view

* DLQ status view

* retry status view

* queue health view

* fulfillment status view

* manual review orders view

* worker health summary

* analytics summary cards

* health status summary

* provider health alerts

* queue backlog alerts

* stale worker alerts

* fulfillment exception summary

* delayed fulfillment summary

* invalid tracking summary

* carrier issue summary

* API failure trend summary

* fulfillment retry exhaustion summary



Dashboard rules:



* lightweight Polaris-based UI only

* paginated queries only

* no realtime websocket system

* no heavy BI dashboards

* production-safe rendering only



---



# Current Folder Structure



/routes



/services



/services/order-providers



/services/analytics



/services/monitoring



/workers



/queues



/models



/utils



/config



/components



/pages



---



---

# Fraud Protection, Zinc Block, Restock, and Refund Architecture

## Production Status

As of 2026-06-13, the production branch and server include the completed Fraud Protection production release.

Current production release:

* Branch: `prod-fraud-full-release`
* Latest production commit: `73a5355 Add production fraud refund guard and payload sanitizers`
* Production shop: `cmgpwd-ty.myshopify.com`
* Production server path: `/var/www/pickvora-amazon-importer`
* Services:
  * `pickvora-web`
  * `pickvora-tracking-worker`

Current live production FraudProtectionConfig:

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

Current required production service environment variables:

```text
FRAUD_ORDER_CANCEL_ENABLED=true
FRAUD_ORDER_REFUND_ENABLED=true
```

Both `pickvora-web` and `pickvora-tracking-worker` must have those environment variables set through systemd drop-ins before production refund can run.

## Fraud Order Flow

When a Shopify order webhook is received:

1. The webhook route validates the webhook.
2. `OrderWebhookLog.payload` stores only allowlisted safe fields.
3. `order.create` is enqueued with only allowlisted safe queue payload fields.
4. The order worker processes the job asynchronously.
5. The worker fetches required order details through Shopify Admin API read-only queries.
6. Fraud risk is assessed.
7. If HIGH risk and production guards pass:
   * Zinc submit is blocked before provider submission.
   * `ProviderOrder` is moved to `MANUAL_REVIEW`.
   * `ProviderOrder.requestPayload` and `ProviderOrder.responsePayload` remain `null`.
   * Shopify `orderCancel` is requested.
   * `restock=true` is used when eligible.
   * Original payment refund is requested through `refundMethod.originalPaymentMethodsRefund=true`.
   * `notifyCustomer=false` is preserved.
   * A `fraud.cancel.poll` job confirms cancellation completion.

## Production Refund Eligibility

Production refund is allowed only when all required guards pass.

Required production conditions:

* runtime is production
* `shop === "cmgpwd-ty.myshopify.com"`
* `FRAUD_ORDER_CANCEL_ENABLED=true`
* `FRAUD_ORDER_REFUND_ENABLED=true`
* `FraudProtectionConfig.enabled=true`
* `FraudProtectionConfig.dryRun=false`
* `FraudProtectionConfig.autoCancelHighRisk=true`
* `FraudProtectionConfig.blockZincOnHighRisk=true`
* `FraudProtectionConfig.refundPayment=true`
* `FraudProtectionConfig.notifyCustomer=false`
* risk level is `HIGH`
* decision is `CANCEL_REQUIRED`
* cancellation has not already been recorded
* order is not in the protected historical test-order list

Protected historical test orders must not be mutated:

```text
#1005 through #1023
```

## Shopify Mutation Rules

Allowed production cancel/refund mutation:

* Shopify `orderCancel`
* `restock=true` when eligible
* `refundMethod.originalPaymentMethodsRefund=true` only when refund guards pass
* `notifyCustomer=false`

Never add or use:

* `refundCreate`
* `notifyCustomer=true` for fraud cancellation/refund
* raw GraphQL `variables` logging
* raw request payload persistence for customer/address/payment data
* repeat `orderCancel` when a cancellation status already exists

## Payload Sanitization Rules

### OrderWebhookLog.payload

`OrderWebhookLog.payload` stores only:

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

### OrderQueueJob.payload for order.create

`OrderQueueJob.payload` for `order.create` stores only the same minimal allowlist:

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

The worker must not depend on queue payload for sensitive order details. Required order details, including shipping address for normal Zinc submission, must be reloaded through Shopify Admin API read-only queries during worker execution.

### Blocked Payload Content

The following must not be stored in webhook logs or queue job payloads:

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

### ProviderOrder Payload Rules

For HIGH fraud block paths:

```text
ProviderOrder.status=MANUAL_REVIEW
ProviderOrder.providerOrderId=null
ProviderOrder.requestPayload=null
ProviderOrder.responsePayload=null
ProviderOrder.providerFailureCode=FRAUD_HIGH_RISK
```

## Monitoring Events

Fraud cancellation/refund monitoring events should record only safe summaries.

Expected successful production fraud refund event sequence:

```text
fraud_order_cancel_options_resolved
fraud_order_cancel_request_prepared
fraud_order_cancel_response_received
fraud_order_cancel_requested
fraud_order_cancel_confirmed
```

Expected safe event values:

```text
shouldRefund=true
refundMethodType=ORIGINAL_PAYMENT_METHODS
refundPaymentUsed=true
refundMethodUsed=true
notifyCustomer=false
hasUserErrors=false
hasOrderCancelUserErrors=false
cancellationStatus=CANCELLED
```

## Development Verification Completed

Final dev E2E verification was completed with order `#1023`.

Verified:

* webhook sanitizer: `webhookSafe=true`
* queue payload sanitizer: `queueCreateSafe=true`
* fraud assessment: `HIGH`
* decision: `CANCEL_REQUIRED`
* action mode: `LIVE_PENDING_CANCEL`
* cancellation status: `CANCELLED`
* Zinc blocked before submit
* `ProviderOrder.requestPayload=null`
* `ProviderOrder.responsePayload=null`
* `fraud.cancel.poll` completed
* refund requested safely with original payment method
* `notifyCustomer=false`

## Production Deployment Verification Completed

Production server verification completed:

* server pulled commit `73a5355`
* `npm install` completed
* `npm run typecheck` passed
* `npm run build` passed
* `pickvora-web` restarted and active
* `pickvora-tracking-worker` restarted and active
* systemd environment variables confirmed for both services
* production config activated with `liveFraudRefundEnabled=true`

## Emergency Rollback

To disable live production fraud refund/cancel behavior and return to dry-run mode:

```bash
cd /var/www/pickvora-amazon-importer

cat > ./tmp-disable-prod-fraud-refund-config.mjs <<'EOF'
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const shop = "cmgpwd-ty.myshopify.com";

const before = await prisma.fraudProtectionConfig.findUnique({
  where: { shop },
});

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

console.log(JSON.stringify({
  mode: "rollback",
  before,
  updated,
}, null, 2));

await prisma.$disconnect();
EOF

node ./tmp-disable-prod-fraud-refund-config.mjs
rm -f ./tmp-disable-prod-fraud-refund-config.mjs
```

To remove the systemd refund/cancel environment flags as well:

```bash
rm -f /etc/systemd/system/pickvora-web.service.d/fraud-refund.conf
rm -f /etc/systemd/system/pickvora-tracking-worker.service.d/fraud-refund.conf

systemctl daemon-reload
systemctl restart pickvora-web
systemctl restart pickvora-tracking-worker
```

## Validation Commands

Use before and after future fraud-protection changes:

```bash
git diff --check
npm test
npm run typecheck
npm run build
```

Use on production server after deployment:

```bash
git log --oneline -5
systemctl status pickvora-web --no-pager -l
systemctl status pickvora-tracking-worker --no-pager -l
systemctl show pickvora-web -p Environment --value | tr ' ' '\n' | grep FRAUD_ORDER
systemctl show pickvora-tracking-worker -p Environment --value | tr ' ' '\n' | grep FRAUD_ORDER
```

---

# Protected Areas



Do NOT modify unless explicitly requested:



* auth system

* billing system

* Shopify OAuth flow

* webhook verification core logic

* subscription system



---



# Development Rules



Always:



* preserve existing structure

* use minimal targeted modifications only

* maintain production-safe implementation

* preserve async architecture

* preserve idempotency protections

* preserve retry-safe processing

* preserve existing naming conventions



Never:



* perform broad refactoring

* rename large folder structures

* introduce unnecessary dependencies

* block webhook responses

* rewrite queue architecture unnecessarily



---



# Current Development Priorities



Current roadmap order:



1. admin retry tools

2. manual review tools

3. review import system

4. provider failover improvements

5. scaling optimizations

6. automated health monitoring

7. fulfillment exception analytics



---



# Current Git Workflow



Use feature branches for all development.



Examples:



* feature/queue-worker

* feature/tracking-polling

* feature/fulfillment-update

* feature/dead-letter-queue

* feature/monitoring-system

* feature/analytics-layer

* feature/operations-dashboard



Commit frequently in small isolated units.



---



# Production Safety Requirements



All implementations must support:



* retry handling

* timeout handling

* exponential backoff

* duplicate prevention

* partial failure recovery

* audit logging

* rollback-safe processing



Production safety is highest priority.



---



Current completed features:



✔ webhook async architecture



✔ retry-safe workers



✔ dead letter queue (DLQ)



✔ tracking polling workers



✔ fulfillment sync



✔ operations dashboard



✔ duplicate webhook prevention



✔ duplicate Zinc order prevention



✔ duplicate fulfillment prevention



✔ analytics aggregation layer



✔ monitoring layer



✔ Admin Retry Tools



✔ Manual Review UI



✔ Review Import System v1



✔ Shopify review metafield sync



✔ review rating/review count storage



✔ review badge enhancement



✔ Shopify app block/theme extension for review badge



✔ product page review badge



✔ mobile responsive review badge



✔ metafield fallback handling



✔ Provider Failover Improvements v1



✔ provider abstraction architecture



✔ provider error normalization



✔ provider health tracking



✔ manual-review fallback flow



✔ Scaling Optimization v1



✔ queue concurrency safety



✔ import batch size protection



✔ Shopify API retry/backoff optimization



✔ Rainforest API timeout/retry optimization



✔ dashboard pagination protection



✔ tracking polling interval optimization



✔ duplicate polling prevention



✔ worker memory/log protection



✔ Automated Health Monitoring



✔ queue health auto monitoring



✔ worker heartbeat monitoring



✔ API failure threshold detection



✔ provider health alerting



✔ DLQ growth detection



✔ tracking polling delay detection



✔ dashboard health summary enhancement



✔ fulfillment worker stale detection



✔ queue backlog threshold monitoring



✔ provider outage visibility



✔ health status normalization (OK/WARNING/CRITICAL)



✔ monitoring threshold configuration support



✔ lightweight monitoring aggregation



✔ production-safe health monitoring architecture



✔ Fulfillment Exception Analytics



✔ fulfillment failure reason aggregation



✔ invalid tracking analytics



✔ duplicate fulfillment prevention analytics



✔ Shopify fulfillment API failure trend analytics



✔ tracking received but fulfillment not completed detection



✔ delayed fulfillment update detection



✔ carrier/tracking company issue analytics



✔ manual review fulfillment exception summary



✔ fulfillment exception dashboard summary cards



✔ paginated fulfillment exception detail views



✔ fulfillment retry exhaustion analytics



✔ fulfillment anomaly detection



✔ fulfillment exception categorization



✔ read-only fulfillment analytics architecture



✔ production-safe fulfillment analytics layer



---



Important:



* Minimal modification policy

* Production-safe only

* No unnecessary refactoring

* Preserve async architecture

* Preserve idempotency

* Preserve webhook enqueue architecture
