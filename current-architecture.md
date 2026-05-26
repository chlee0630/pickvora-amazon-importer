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



Current analytics includes:



\* order success metrics

\* retry metrics

\* fulfillment metrics

\* worker performance metrics

\* API latency metrics

\* DLQ metrics



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

\---

Important:

\- Minimal modification policy

\- Production-safe only

\- No unnecessary refactoring

\- Preserve async architecture

\- Preserve idempotency

\- Preserve webhook enqueue architecture

