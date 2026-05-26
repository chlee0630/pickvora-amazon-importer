/* eslint-disable react/prop-types */

import {
  DashboardFilters,
  DataTable,
  PaginationControls,
  SummaryGrid,
  formatDate,
  formatDuration,
  formatPercent,
} from "../components/operations-dashboard";

const orderColumns = [
  { key: "shopifyOrderId", label: "Shopify order" },
  { key: "type", label: "Job type" },
  { key: "status", label: "Status" },
  { key: "attempts", label: "Attempts", render: (row) => `${row.attempts}/${row.maxAttempts}` },
  { key: "failureCategory", label: "Category" },
  { key: "failureReason", label: "Reason" },
  { key: "lastFailureAt", label: "Last failure", render: (row) => formatDate(row.lastFailureAt) },
];

const dlqColumns = [
  { key: "shopifyOrderId", label: "Shopify order" },
  { key: "type", label: "Job type" },
  { key: "status", label: "DLQ status" },
  { key: "attempts", label: "Attempts", render: (row) => `${row.attempts}/${row.maxAttempts}` },
  { key: "recoveryAttempts", label: "Recovery" },
  { key: "failureCategory", label: "Category" },
  { key: "failureReason", label: "Reason" },
  { key: "lastFailureAt", label: "Last failure", render: (row) => formatDate(row.lastFailureAt) },
];

const workerColumns = [
  { key: "workerName", label: "Worker" },
  { key: "successRate", label: "Success rate", render: (row) => formatPercent(row.successRate) },
  { key: "failureCount", label: "Failures" },
  { key: "timeoutCount", label: "Timeouts" },
  { key: "averageDurationMs", label: "Avg duration", render: (row) => formatDuration(row.averageDurationMs) },
];

const apiColumns = [
  { key: "provider", label: "Provider" },
  { key: "eventType", label: "Event" },
  { key: "createdAt", label: "Time", render: (row) => formatDate(row.createdAt) },
];

export default function OperationsDashboardPage({ dashboard, filters }) {
  return (
    <s-page heading="Operations Dashboard">
      <DashboardFilters filters={filters} />

      <s-section heading="Operations overview">
        <SummaryGrid
          items={[
            { label: "Total processed orders", value: dashboard.overview.totalProcessed },
            { label: "Successful orders", value: dashboard.overview.successfulOrders },
            { label: "Failed orders", value: dashboard.overview.failedOrders, tone: "critical" },
            { label: "Manual review count", value: dashboard.overview.manualReviewCount, tone: "critical" },
            { label: "Fulfillment success rate", value: formatPercent(dashboard.overview.fulfillmentSuccessRate) },
          ]}
        />
      </s-section>

      <s-section heading="Queue health">
        <SummaryGrid
          items={[
            { label: "Active jobs", value: dashboard.queue.activeJobs },
            { label: "Failed jobs", value: dashboard.queue.failedJobs, tone: "critical" },
            { label: "Delayed jobs", value: dashboard.queue.delayedJobs },
            { label: "Retry counts", value: dashboard.queue.retryCounts },
            { label: "Open DLQ jobs", value: dashboard.queue.dlqOpenJobs, tone: "critical" },
            { label: "Total DLQ jobs", value: dashboard.queue.dlqTotalJobs },
          ]}
        />
      </s-section>

      <s-section heading="Fulfillment status">
        <SummaryGrid
          items={[
            { label: "Fulfilled orders", value: dashboard.fulfillment.fulfilledOrders },
            { label: "Tracking received orders", value: dashboard.fulfillment.trackingReceivedOrders },
            { label: "Fulfillment failures", value: dashboard.fulfillment.fulfillmentFailures, tone: "critical" },
            { label: "Duplicate prevention events", value: dashboard.fulfillment.duplicatePreventionEvents },
          ]}
        />
      </s-section>

      <s-section heading="Worker health summary">
        <SummaryGrid
          items={[
            { label: "Worker success rate", value: formatPercent(dashboard.workers.successRate) },
            { label: "Worker timeout count", value: dashboard.workers.timeoutCount, tone: "critical" },
            { label: "Worker failure count", value: dashboard.workers.failureCount, tone: "critical" },
            { label: "Avg processing duration", value: formatDuration(dashboard.workers.averageProcessingDurationMs) },
          ]}
        />
        <div style={{ marginTop: "12px" }}>
          <DataTable columns={workerColumns} rows={dashboard.workers.workers} emptyMessage="No worker events found." />
        </div>
      </s-section>

      <s-section heading="Analytics summary">
        <SummaryGrid
          items={[
            { label: "Cached processed orders", value: valueFor(dashboard.analytics, "orders.total_processed") },
            { label: "Cached failed orders", value: valueFor(dashboard.analytics, "orders.failed"), tone: "critical" },
            { label: "Cached retry frequency", value: valueFor(dashboard.analytics, "retry.frequency") },
            { label: "Cached DLQ insertion rate", value: valueFor(dashboard.analytics, "dlq.insertion_rate") },
            { label: "Cached fulfillment success", value: formatPercent(valueFor(dashboard.analytics, "fulfillment.success_rate")) },
          ]}
        />
      </s-section>

      <s-section heading="API failure summary">
        <SummaryGrid
          items={[
            { label: "API failures", value: dashboard.apiFailures.failureCount, tone: "critical" },
            { label: "API timeouts", value: dashboard.apiFailures.timeoutCount, tone: "critical" },
          ]}
        />
        <div style={{ marginTop: "12px" }}>
          <DataTable columns={apiColumns} rows={dashboard.apiFailures.recent} emptyMessage="No recent API failures found." />
        </div>
      </s-section>

      <s-section heading="Failed orders">
        <DataTable columns={orderColumns} rows={dashboard.failedOrders} emptyMessage="No failed orders found." />
        <PaginationControls filters={filters} total={dashboard.failedOrdersTotal} />
      </s-section>

      <s-section heading="DLQ status">
        <DataTable columns={dlqColumns} rows={dashboard.dlqJobs} emptyMessage="No DLQ jobs found." />
        <PaginationControls filters={filters} total={dashboard.dlqJobsTotal} />
      </s-section>

      <s-section heading="Retry status">
        <DataTable columns={orderColumns} rows={dashboard.retryJobs} emptyMessage="No retrying orders found." />
      </s-section>

      <s-section heading="Manual review orders">
        <SummaryGrid
          items={[
            { label: "Invalid address orders", value: dashboard.manualReviewSummary.invalidAddressOrders, tone: "critical" },
            { label: "Restricted product orders", value: dashboard.manualReviewSummary.restrictedProductOrders, tone: "critical" },
            { label: "Permanent failure orders", value: dashboard.manualReviewSummary.permanentFailureOrders, tone: "critical" },
          ]}
        />
        <div style={{ marginTop: "12px" }}>
          <DataTable columns={orderColumns} rows={dashboard.manualReviewOrders} emptyMessage="No manual review orders found." />
        </div>
      </s-section>
    </s-page>
  );
}

function valueFor(analytics, metricName) {
  return analytics[metricName] ?? 0;
}
