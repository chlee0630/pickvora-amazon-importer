\# Current Architecture



\## Project Overview



This project is a Shopify Amazon automation app.



Main goals:



\* Import Amazon products into Shopify

\* Process Shopify orders automatically

\* Submit Amazon orders through Zinc API

\* Sync fulfillment tracking back to Shopify

\* Maintain production-safe async architecture



\---



\# Current Stack



\## Backend



\* Node.js

\* Express

\* Shopify Admin API

\* Shopify Webhooks

\* MySQL

\* Redis Queue

\* BullMQ-style async workers



\## External APIs



\* Rainforest API

\* Zinc API



\## Frontend



\* Shopify Polaris

\* Shopify App Bridge



\---



\# Important Business Rules



\## Inventory



Inventory quantity sync is intentionally disabled.



Use:



\* availability-based selling only



Never implement:



\* inventory quantity synchronization

\* inventory polling



\---



\# Shipping Rules



Only support:



\* US mainland free shipping



Exclude:



\* Alaska

\* Hawaii

\* Puerto Rico



\---



\# Current Architecture



\## Webhook Flow



Shopify webhook

→ webhook validation

→ enqueue async job

→ immediate HTTP 200 response



Heavy processing must NEVER run inside webhook routes.



\---



\# Queue Architecture



Current system uses:



\* async queue workers

\* retry-safe processing

\* exponential backoff

\* dead letter queue support

\* idempotent workers

\* order locking



\---



\# Current Order Flow



1\. Shopify order webhook received

2\. Validate webhook signature

3\. Store webhook logs

4\. Enqueue async order job

5\. Order worker loads order

6\. Build normalized order payload

7\. Submit Zinc order

8\. Save Zinc response

9\. Tracking polling worker checks tracking

10\. Fulfillment worker updates Shopify fulfillment

11\. Save fulfillment logs



\# Fraud Protection Architecture



Fraud Protection is implemented as a read-only, dry-run observability layer.



Current DB models:



\* `FraudProtectionConfig`

\* `FraudOrderAssessment`



`FraudProtectionConfig` stores shop-level fraud settings.



Fields:



\* `enabled`

\* `dryRun`

\* `autoCancelHighRisk`

\* `autoCancelMediumRisk`

\* `cancelReason`

\* `restockInventory`

\* `refundPayment`

\* `notifyCustomer`

\* `delayMinutes`



`FraudOrderAssessment` stores one assessment per Shopify order.



Fields:



\* `shop`

\* `shopifyOrderId`

\* `orderName`

\* `riskLevel`

\* `recommendation`

\* `score`

\* `totalPrice`

\* `currencyCode`

\* `displayFinancialStatus`

\* `displayFulfillmentStatus`

\* `cancelledAt`

\* `assessmentStatus`

\* `decision`

\* `actionMode`

\* `cancellationStatus`

\* `cancellationError`

\* `riskPayload`

\* `assessedAt`



Current operating mode in production:



\* `enabled=true`

\* `dryRun=true`

\* `autoCancelHighRisk=true`

\* `autoCancelMediumRisk=false`

\* `restockInventory=false`

\* `refundPayment=false`

\* `notifyCustomer=false`



This means:



\* HIGH-risk orders can be recorded as `WOULD_CANCEL`

\* MEDIUM-risk orders remain review-focused

\* no actual cancellation runs

\* no refund automation runs

\* no restock automation runs

\* no Zinc submission blocking occurs



\# Fraud Analytics Dashboard



Fraud analytics is exposed in the Operations Dashboard as a read-only summary and recent assessment table.



The dashboard data is built from `FraudOrderAssessment` only.



Dashboard fallback behavior:



\* if fraud analytics query fails, the dashboard uses `EMPTY_FRAUD_ANALYTICS`

\* the rest of the Operations Dashboard continues to render

\* the UI does not require fraud analytics to exist for the page to load



Visible sections:



\* `Fraud order analytics`

\* `Fraud protection settings`



\# Dry-run Fraud Assessment Flow



File: `app/services/fraud-protection.server.js`



Core functions:



\* `getFraudProtectionConfig(shop)`

\* `updateFraudProtectionConfig(...)`

\* `fetchShopifyOrderRisk(shop, accessToken, shopifyOrderId)`

\* `assessOrderFraudRisk(...)`

\* `getFraudAnalyticsDashboard(shop)`

\* `EMPTY_FRAUD_ANALYTICS`



Order worker integration:



\* fraud assessment runs after `fetchShopifyOrder(...)`

\* fraud assessment runs after `validateOrder(order)`

\* fraud assessment runs before `buildProviderOrderInput(...)`

\* fraud assessment runs before `persistZincSubmitIntent(...)`



Worker behavior:



\* when `FraudProtectionConfig.enabled === false`, risk lookup is skipped

\* when `FraudProtectionConfig.enabled === true`, Shopify order risk is read-only queried

\* assessment results are saved to `FraudOrderAssessment`

\* assessment errors are non-blocking

\* order job failure, retry, and DLQ routing are not triggered by fraud assessment failures

\* Zinc submission continues normally



Logged events:



\* `fraud_assessment_skipped`

\* `fraud_assessment_completed`

\* `fraud_assessment_failed_non_blocking`

\* `fraud_order_would_cancel_dry_run`



\# Dev/Test Fraud Simulation



Fraud simulation is available only in dev/test runtime.



Files:



\* `app/utils/runtime-flags.server.js`

\* `app/services/fraud-protection.server.js`

\* `app/routes/app.operations.jsx`

\* `app/pages/operations-dashboard.jsx`



Runtime gating:



\* `canUseFraudTestSimulationForShop(shop)` blocks production runtime

\* the simulation card is hidden in production

\* direct POST to the action is blocked in production with `404`



Simulation behavior:



\* creates an internal fraud assessment only

\* does not create a Shopify order

\* does not cancel a Shopify order

\* does not touch `ProviderOrder`, `OrderQueueJob`, `DeadLetterQueueJob`, `FulfillmentLog`, or `TrackingLog`



Generated simulation record:



\* `shop`: current session shop

\* `shopifyOrderId`: `gid://shopify/Order/fraud-test-${timestamp}`

\* `orderName`: `FRAUD-TEST-${timestamp}`

\* `riskLevel`: `HIGH`

\* `recommendation`: `CANCEL`

\* `assessmentStatus`: `ASSESSED`

\* `decision`: policy-driven

\* `actionMode`: `DRY_RUN`

\* `riskPayload.source`: `pickvora_internal_fraud_test`

\* `riskPayload.simulated`: `true`

\* `riskPayload.note`: `No Shopify order was created`



\# Safety Guarantees



Fraud Protection is not an automatic cancellation system.



Current guarantees:



\* no `orderCancel` mutation exists

\* no `write_orders` scope is added

\* no refund automation exists

\* no restock automation exists

\* no customer notification automation exists

\* no Zinc submission blocking is applied

\* production remains dry-run only

\* live cancel mode is not implemented yet



If live auto-cancel is added later, it will require separate scope review, permission reauthorization, explicit safety controls, and new test coverage.



\# Not implemented yet



The following are intentionally not implemented:



\* actual Shopify order cancellation
\* `orderCancel` mutation
\* `write_orders` scope
\* refund automation
\* restock automation
\* Zinc submit blocking based on fraud decision
\* production fraud test order generation



\---



\# Current Implemented Features



\## Completed



\* webhook enqueue architecture

\* async order workers

\* Zinc provider integration

\* provider abstraction layer

\* tracking polling workers

\* fulfillment update workers

\* retry-safe queue processing

\* dead letter queue system

\* monitoring layer

\* analytics aggregation layer

\* duplicate webhook prevention

\* duplicate Zinc order prevention

\* duplicate fulfillment prevention

\* structured logging

\* retry exhaustion handling

\* operations dashboard

\* fraud order analytics

\* fraud protection settings

\* fraud test simulation



\---



\# Current Order States



Supported states:



\* PENDING

\* PROCESSING

\* ZINC\_SUBMITTED

\* ORDERED

\* TRACKING\_RECEIVED

\* FULFILLED

\* FAILED

\* MANUAL\_REVIEW



\---



\# Provider Architecture



Provider abstraction is REQUIRED.



Current provider structure:



/services/order-providers



Examples:



\* base-provider

\* zinc-provider



Business logic must NOT tightly couple to Zinc-specific implementations.



All providers should support:



\* createOrder()

\* getOrderStatus()

\* getTracking()

\* cancelOrder()



\---



\# Current Queue Rules



Workers must support:



\* retry-safe execution

\* timeout handling

\* exponential backoff

\* duplicate prevention

\* idempotency

\* structured logging

\* dead letter queue handling



Webhook routes must:



\* validate webhook

\* enqueue only

\* return immediately



Never:



\* perform heavy processing in webhook routes

\* call Zinc API directly from webhook routes



\---



\# Fulfillment Rules



Must:



\* preserve fulfillment history

\* prevent duplicate fulfillment creation

\* validate tracking data

\* support retry-safe fulfillment updates



Never:



\* overwrite fulfillment history

\* create duplicate fulfillments



\---



\# Monitoring \& Analytics



Current monitoring includes:



\* queue health monitoring

\* worker failure monitoring

\* retry monitoring

\* DLQ monitoring

\* API failure monitoring

\* fulfillment monitoring

\* worker heartbeat monitoring

\* provider health monitoring

\* tracking polling delay monitoring

\* queue backlog threshold monitoring

\* fulfillment exception monitoring

\* fulfillment delay monitoring

\* provider outage monitoring



Current analytics includes:



\* order success metrics

\* retry metrics

\* fulfillment metrics

\* worker performance metrics

\* API latency metrics

\* DLQ metrics

\* fulfillment exception analytics

\* invalid tracking analytics

\* fulfillment delay analytics

\* duplicate fulfillment prevention analytics

\* provider health analytics

\* API failure trend analytics

\* carrier issue analytics

\* manual review analytics



\---



\# Operations Dashboard



Current dashboard includes:



\* operations overview

\* failed orders view

\* DLQ status view

\* retry status view

\* queue health view

\* fulfillment status view

\* manual review orders view

\* worker health summary

\* analytics summary cards

\* health status summary

\* provider health alerts

\* queue backlog alerts

\* stale worker alerts

\* fulfillment exception summary

\* delayed fulfillment summary

\* invalid tracking summary

\* carrier issue summary

\* API failure trend summary

\* fulfillment retry exhaustion summary



Dashboard rules:



\* lightweight Polaris-based UI only

\* paginated queries only

\* no realtime websocket system

\* no heavy BI dashboards

\* production-safe rendering only



\---



\# Current Folder Structure



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



\---



\# Protected Areas



Do NOT modify unless explicitly requested:



\* auth system

\* billing system

\* Shopify OAuth flow

\* webhook verification core logic

\* subscription system



\---



\# Development Rules



Always:



\* preserve existing structure

\* use minimal targeted modifications only

\* maintain production-safe implementation

\* preserve async architecture

\* preserve idempotency protections

\* preserve retry-safe processing

\* preserve existing naming conventions



Never:



\* perform broad refactoring

\* rename large folder structures

\* introduce unnecessary dependencies

\* block webhook responses

\* rewrite queue architecture unnecessarily



\---



\# Current Development Priorities



Current roadmap order:



1\. admin retry tools

2\. manual review tools

3\. review import system

4\. provider failover improvements

5\. scaling optimizations

6\. automated health monitoring

7\. fulfillment exception analytics



\---



\# Current Git Workflow



Use feature branches for all development.



Examples:



\* feature/queue-worker

\* feature/tracking-polling

\* feature/fulfillment-update

\* feature/dead-letter-queue

\* feature/monitoring-system

\* feature/analytics-layer

\* feature/operations-dashboard



Commit frequently in small isolated units.



\---



\# Production Safety Requirements



All implementations must support:



\* retry handling

\* timeout handling

\* exponential backoff

\* duplicate prevention

\* partial failure recovery

\* audit logging

\* rollback-safe processing



Production safety is highest priority.



\---



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



✔ Fraud Protection dry-run assessment



✔ Fraud Analytics dashboard summary



✔ Fraud protection settings management



✔ dev/test fraud test simulation



\---



Important:



\* Minimal modification policy

\* Production-safe only

\* No unnecessary refactoring

\* Preserve async architecture

\* Preserve idempotency

\* Preserve webhook enqueue architecture



