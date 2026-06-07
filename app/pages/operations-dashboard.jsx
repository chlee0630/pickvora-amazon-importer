/* eslint-disable react/prop-types */

import { useFetcher } from "react-router";
import {
  DashboardFilters,
  DataTable,
  HealthSummary,
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

const fulfillmentExceptionColumns = [
  { key: "exceptionType", label: "Exception" },
  { key: "severity", label: "Severity" },
  { key: "shopifyOrderId", label: "Shopify order" },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
  { key: "message", label: "Message" },
  { key: "createdAt", label: "Detected", render: (row) => formatDate(row.createdAt) },
];

const fulfillmentReasonColumns = [
  { key: "reason", label: "Reason" },
  { key: "count", label: "Count" },
];

const fraudColumns = [
  { key: "orderName", label: "Order" },
  { key: "riskLevel", label: "Risk" },
  { key: "recommendation", label: "Recommendation" },
  { key: "decision", label: "Decision" },
  { key: "actionMode", label: "Mode" },
  { key: "totalPrice", label: "Amount", render: (row) => formatMoney(row.totalPrice, row.currencyCode) },
  { key: "displayFinancialStatus", label: "Payment" },
  { key: "displayFulfillmentStatus", label: "Fulfillment" },
  { key: "assessedAt", label: "Assessed", render: (row) => formatDate(row.assessedAt) },
];

const emptyFraudAnalytics = {
  totalAssessments: 0,
  highRiskCount: 0,
  mediumRiskCount: 0,
  lowRiskCount: 0,
  pendingRiskCount: 0,
  reviewCount: 0,
  wouldCancelCount: 0,
  cancelledCount: 0,
  recent: [],
};

const emptyFraudConfig = {
  enabled: false,
  dryRun: true,
  autoCancelHighRisk: false,
  autoCancelMediumRisk: false,
  blockZincOnHighRisk: false,
};

export default function OperationsDashboardPage({
  dashboard,
  filters,
  testTrackingInjectionEnabled,
  fraudTestSimulationEnabled,
  fraudZincBlockControlsEnabled,
}) {
  const fetcher = useFetcher();
  const actionResult = fetcher.data;
  const fraudAnalytics = dashboard.fraudAnalytics ?? emptyFraudAnalytics;
  const fraudConfig = actionResult?.config ?? dashboard.fraudConfig ?? emptyFraudConfig;
  const manualReviewColumns = [
    { key: "id", label: "Order id" },
    { key: "shopifyOrderId", label: "Shopify order id" },
    { key: "orderNumber", label: "Order number" },
    { key: "orderStatus", label: "Status" },
    { key: "providerName", label: "Provider" },
    { key: "providerFailureCode", label: "Provider code" },
    { key: "providerAttemptCount", label: "Provider attempts" },
    { key: "zincOrderId", label: "Zinc order id" },
    { key: "trackingNumber", label: "Tracking number" },
    { key: "trackingCompany", label: "Tracking company" },
    { key: "failureReason", label: "Failure reason" },
    { key: "retryCount", label: "Retry count", render: (row) => `${row.retryCount}/${row.maxAttempts}` },
    { key: "lastUpdatedAt", label: "Updated", render: (row) => formatDate(row.lastUpdatedAt) },
    { key: "latestNote", label: "Latest note" },
    { key: "actions", label: "Actions", render: (row) => <ManualReviewActions row={row} fetcher={fetcher} /> },
  ];

  return (
    <s-page heading="Operations Dashboard">
      {actionResult && (
        <s-banner
          tone={actionResult.success ? "success" : "critical"}
          title={actionResult.success ? actionResult.message : actionResult.error}
        />
      )}
      {actionResult?.success && actionResult.order && (
        <s-box padding="base" borderWidth="base" borderRadius="base" style={{ marginTop: "12px", background: "#f6f6f7" }}>
          <div style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
            <div style={{ fontWeight: 700 }}>Test tracking injection result</div>
            <div>Order: {actionResult.order.shopifyOrderId}</div>
            <div>Provider order: {actionResult.order.providerOrderId}</div>
            <div>Tracking status: {actionResult.order.status}</div>
            <div>Tracking number: {actionResult.order.trackingNumber || "-"}</div>
            <div>Carrier: {actionResult.order.trackingCarrier || "-"}</div>
            <div>Tracking received at: {formatDate(actionResult.order.trackingReceivedAt)}</div>
            <div>Fulfillment synced at: {formatDate(actionResult.order.fulfillmentSyncedAt)}</div>
            <div>Shopify fulfillment ID: {actionResult.order.shopifyFulfillmentId || "-"}</div>
          </div>
        </s-box>
      )}

      <DashboardFilters filters={filters} />

      <s-section heading="Automated health monitoring">
        <HealthSummary health={dashboard.healthSummary} />
      </s-section>

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

      <s-section heading="Fraud order analytics">
        <FraudProtectionSettings
          config={fraudConfig}
          fetcher={fetcher}
          fraudZincBlockControlsEnabled={fraudZincBlockControlsEnabled}
        />
        {fraudTestSimulationEnabled && (
          <div style={{ marginTop: "12px" }}>
            <FraudTestSimulationCard fetcher={fetcher} />
          </div>
        )}
        <div style={{ marginTop: "12px" }}>
          <SummaryGrid
            items={[
              { label: "Assessed orders", value: fraudAnalytics.totalAssessments },
              { label: "High risk", value: fraudAnalytics.highRiskCount, tone: "critical" },
              { label: "Medium risk", value: fraudAnalytics.mediumRiskCount, tone: "critical" },
              { label: "Low risk", value: fraudAnalytics.lowRiskCount },
              { label: "Pending risk", value: fraudAnalytics.pendingRiskCount },
              { label: "Manual review", value: fraudAnalytics.reviewCount, tone: "critical" },
              { label: "Would cancel dry-run", value: fraudAnalytics.wouldCancelCount, tone: "critical" },
              { label: "Cancelled", value: fraudAnalytics.cancelledCount, tone: "critical" },
            ]}
          />
        </div>
        <div style={{ marginTop: "12px" }}>
          <DataTable
            columns={fraudColumns}
            rows={fraudAnalytics.recent}
            emptyMessage="No fraud assessments found yet."
          />
        </div>
      </s-section>

      <s-section heading="Fulfillment exception analytics">
        <SummaryGrid
          items={[
            { label: "Total fulfillment exceptions", value: dashboard.fulfillmentExceptions.totalExceptions, tone: "critical" },
            { label: "Invalid tracking", value: dashboard.fulfillmentExceptions.invalidTrackingCount, tone: "critical" },
            { label: "Duplicate skips", value: dashboard.fulfillmentExceptions.duplicateFulfillmentPreventionCount },
            { label: "Shopify API failures", value: dashboard.fulfillmentExceptions.shopifyFulfillmentApiFailureCount, tone: "critical" },
            { label: "Tracking not fulfilled", value: dashboard.fulfillmentExceptions.trackingReceivedNotFulfilledCount, tone: "critical" },
            { label: "Delayed fulfillment", value: dashboard.fulfillmentExceptions.delayedFulfillmentCount, tone: "critical" },
            { label: "Carrier issues", value: dashboard.fulfillmentExceptions.carrierIssueCount, tone: "critical" },
            { label: "Manual review", value: dashboard.fulfillmentExceptions.manualReviewFulfillmentCount, tone: "critical" },
          ]}
        />
        <div style={{ marginTop: "12px" }}>
          <DataTable
            columns={fulfillmentReasonColumns}
            rows={withIds(dashboard.fulfillmentExceptions.failureReasons, "reason")}
            emptyMessage="No fulfillment exception reasons found."
          />
        </div>
        <div style={{ marginTop: "12px" }}>
          <DataTable
            columns={fulfillmentExceptionColumns}
            rows={dashboard.fulfillmentExceptionDetails.rows}
            emptyMessage="No fulfillment exceptions found."
          />
          <PaginationControls filters={filters} total={dashboard.fulfillmentExceptionDetails.total} />
        </div>
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
          <DataTable columns={manualReviewColumns} rows={dashboard.manualReviewOrders} emptyMessage="No manual review orders found." />
        </div>
      </s-section>

      {testTrackingInjectionEnabled && (
        <TestTrackingInjectionSection fetcher={fetcher} />
      )}
    </s-page>
  );
}

function valueFor(analytics, metricName) {
  return analytics[metricName] ?? 0;
}

function withIds(rows, key) {
  return rows.map((row) => ({ ...row, id: row[key] }));
}

function formatMoney(amount, currencyCode) {
  if (!Number.isFinite(amount)) return "-";
  return currencyCode ? `${amount} ${currencyCode}` : String(amount);
}

function FraudProtectionSettings({ config, fetcher, fraudZincBlockControlsEnabled }) {
  const activeIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;
  const isSubmitting = activeIntent === "update_fraud_protection_config";
  const isZincBlockSubmitting = activeIntent === "update_fraud_zinc_block_config";
  const enabled = Boolean(config.enabled);
  const highRiskAction = enabled && config.autoCancelHighRisk ? "Would cancel" : "Review only";
  const blockZincOnHighRisk = Boolean(config.blockZincOnHighRisk);

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="default">
      <div style={{ display: "grid", gap: "12px" }}>
        <div style={{ fontWeight: 700 }}>Fraud protection settings</div>
        <SummaryGrid
          items={[
            { label: "Enabled", value: enabled ? "Enabled" : "Disabled", tone: enabled ? "critical" : undefined },
            { label: "Mode", value: "Dry-run only" },
            { label: "High-risk action", value: highRiskAction, tone: highRiskAction === "Would cancel" ? "critical" : undefined },
            { label: "Medium-risk action", value: "Review only" },
            {
              label: "Zinc block on high risk",
              value: blockZincOnHighRisk ? "Enabled" : "Disabled",
              tone: blockZincOnHighRisk ? "critical" : undefined,
            },
          ]}
        />
        <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap" }}>
          <FraudConfigForm
            fetcher={fetcher}
            enabled
            label="Enable dry-run fraud protection"
            disabled={isSubmitting || enabled}
            confirmMessage="Enable dry-run fraud protection? This will only record fraud assessments and will not cancel orders."
          />
          <FraudConfigForm
            fetcher={fetcher}
            enabled={false}
            label="Disable fraud protection"
            disabled={isSubmitting || !enabled}
            confirmMessage="Disable fraud protection?"
          />
        </s-stack>
        {fraudZincBlockControlsEnabled && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <div style={{ display: "grid", gap: "10px" }}>
              <div style={{ fontWeight: 700 }}>Dev/test Zinc block controls</div>
              <s-paragraph>
                Dev/test only. HIGH fraud risk can stop Zinc submission, but Shopify orders are not cancelled.
              </s-paragraph>
              <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap" }}>
                <FraudZincBlockForm
                  fetcher={fetcher}
                  blockZincOnHighRisk
                  label="Enable Zinc block on HIGH risk"
                  disabled={isZincBlockSubmitting || blockZincOnHighRisk}
                  confirmMessage="Enable dev/test Zinc block on HIGH fraud risk? This will not cancel Shopify orders."
                />
                <FraudZincBlockForm
                  fetcher={fetcher}
                  blockZincOnHighRisk={false}
                  label="Disable Zinc block on HIGH risk"
                  disabled={isZincBlockSubmitting || !blockZincOnHighRisk}
                  confirmMessage="Disable Zinc block on HIGH fraud risk?"
                />
              </s-stack>
            </div>
          </s-box>
        )}
      </div>
    </s-box>
  );
}

function FraudConfigForm({ fetcher, enabled, label, disabled, confirmMessage }) {
  return (
    <fetcher.Form
      method="post"
      onSubmit={(event) => {
        if (!confirm(confirmMessage)) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value="update_fraud_protection_config" />
      <input type="hidden" name="enabled" value={enabled ? "true" : "false"} />
      <button type="submit" disabled={disabled} style={{ ...buttonStyle(disabled), width: "auto", minWidth: "220px" }}>
        {label}
      </button>
    </fetcher.Form>
  );
}

function FraudZincBlockForm({ fetcher, blockZincOnHighRisk, label, disabled, confirmMessage }) {
  return (
    <fetcher.Form
      method="post"
      onSubmit={(event) => {
        if (!confirm(confirmMessage)) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value="update_fraud_zinc_block_config" />
      <input type="hidden" name="blockZincOnHighRisk" value={blockZincOnHighRisk ? "true" : "false"} />
      <button type="submit" disabled={disabled} style={{ ...buttonStyle(disabled), width: "auto", minWidth: "240px" }}>
        {label}
      </button>
    </fetcher.Form>
  );
}

function FraudTestSimulationCard({ fetcher }) {
  const isSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "create_fraud_test_assessment";

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="default">
      <div style={{ display: "grid", gap: "10px" }}>
        <div style={{ fontWeight: 700 }}>Fraud test simulation</div>
        <s-paragraph>
          Dev/test only. Creates an internal HIGH-risk fraud assessment without creating a Shopify order.
        </s-paragraph>
        <fetcher.Form
          method="post"
          onSubmit={(event) => {
            if (!confirm("Create an internal fraud test assessment? This will not create or cancel a Shopify order.")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="create_fraud_test_assessment" />
          <button type="submit" disabled={isSubmitting} style={{ ...buttonStyle(isSubmitting), width: "auto", minWidth: "220px" }}>
            Create fraud test assessment
          </button>
        </fetcher.Form>
      </div>
    </s-box>
  );
}

function ManualReviewActions({ row, fetcher }) {
  return (
    <div style={{ display: "grid", gap: "8px", minWidth: "220px" }}>
      <ActionForm
        fetcher={fetcher}
        orderId={row.id}
        intent="retry_zinc_order"
        label="Retry Zinc Order"
        disabled={!row.allowedActions.retryZinc}
      />
      <ActionForm
        fetcher={fetcher}
        orderId={row.id}
        intent="retry_tracking"
        label="Retry Tracking"
        disabled={!row.allowedActions.retryTracking}
      />
      <ActionForm
        fetcher={fetcher}
        orderId={row.id}
        intent="retry_fulfillment"
        label="Retry Fulfillment"
        disabled={!row.allowedActions.retryFulfillment}
      />
      <ActionForm
        fetcher={fetcher}
        orderId={row.id}
        intent="move_manual_review"
        label="Move to Manual Review"
        disabled={!row.allowedActions.moveManualReview}
      />
      <ActionForm
        fetcher={fetcher}
        orderId={row.id}
        intent="resolve_manual_review"
        label="Mark Resolved"
        disabled={!row.allowedActions.resolveManualReview}
      />
      <fetcher.Form method="post" style={{ display: "grid", gap: "6px" }}>
        <input type="hidden" name="intent" value="add_note" />
        <input type="hidden" name="orderId" value={row.id} />
        <textarea
          name="note"
          rows="2"
          maxLength="2000"
          placeholder="Internal note"
          style={noteStyle}
        />
        <button
          type="submit"
          disabled={!row.allowedActions.addNote || fetcher.state !== "idle"}
          style={buttonStyle(!row.allowedActions.addNote || fetcher.state !== "idle")}
        >
          Add Note
        </button>
      </fetcher.Form>
    </div>
  );
}

function ActionForm({ fetcher, orderId, intent, label, disabled }) {
  const isDisabled = disabled || fetcher.state !== "idle";
  return (
    <fetcher.Form
      method="post"
      onSubmit={(event) => {
        if (!confirm(`${label} for this order?`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="orderId" value={orderId} />
      <button type="submit" disabled={isDisabled} style={buttonStyle(isDisabled)}>
        {label}
      </button>
    </fetcher.Form>
  );
}

function TestTrackingInjectionSection({ fetcher }) {
  const isSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "inject_test_tracking";

  return (
    <s-section heading="Test tracking injection">
      <s-paragraph>
        Dev/test only. Inject a synthetic Zinc tracking response and run the standard tracking and fulfillment success path.
      </s-paragraph>
      <fetcher.Form method="post" style={{ display: "grid", gap: "12px", maxWidth: "640px" }}>
        <input type="hidden" name="intent" value="inject_test_tracking" />
        <label style={formLabelStyle}>
          Shopify order number or Shopify order ID
          <input name="orderRef" required placeholder="#1007 or gid://shopify/Order/..." style={textInputStyle} />
        </label>
        <label style={formLabelStyle}>
          Tracking number
          <input name="trackingNumber" required placeholder="1Z..." style={textInputStyle} />
        </label>
        <label style={formLabelStyle}>
          Carrier
          <input name="carrier" required placeholder="UPS" style={textInputStyle} />
        </label>
        <label style={formLabelStyle}>
          Provider order ID
          <input name="providerOrderId" placeholder="Optional" style={textInputStyle} />
        </label>
        <button
          type="submit"
          disabled={isSubmitting}
          style={buttonStyle(isSubmitting)}
          onClick={(event) => {
            if (!confirm("Inject synthetic tracking and run fulfillment sync for this order?")) {
              event.preventDefault();
            }
          }}
        >
          Inject test tracking
        </button>
      </fetcher.Form>
    </s-section>
  );
}

const noteStyle = {
  width: "100%",
  minWidth: "180px",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  padding: "6px 8px",
  fontSize: "12px",
};

const formLabelStyle = {
  display: "grid",
  gap: "4px",
  fontSize: "12px",
  color: "#6d7175",
};

const textInputStyle = {
  minHeight: "34px",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  padding: "6px 8px",
  fontSize: "12px",
};

function buttonStyle(disabled) {
  return {
    width: "100%",
    minHeight: "30px",
    padding: "5px 8px",
    border: "1px solid #c9cccf",
    borderRadius: "6px",
    background: disabled ? "#f6f6f7" : "white",
    color: disabled ? "#8c9196" : "#202223",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "12px",
  };
}
