import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { runAdminOrderAction } from "../services/admin-order-actions.server";
import { updateFraudProtectionConfig } from "../services/fraud-protection.server";
import { injectTestTracking } from "../services/test-tracking-injection.server";
import { getOperationsDashboard } from "../services/dashboard.server";
import { parseDashboardFilters } from "../utils/dashboard-filters.server";
import { canUseTestTrackingInjectionForShop } from "../utils/runtime-flags.server";
import OperationsDashboardPage from "../pages/operations-dashboard";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const filters = parseDashboardFilters(request);
  const dashboard = await getOperationsDashboard(session.shop, filters);

  return {
    dashboard,
    filters,
    testTrackingInjectionEnabled: canUseTestTrackingInjectionForShop(session.shop),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "update_fraud_protection_config") {
      const enabled = String(form.get("enabled") || "") === "true";
      const config = await updateFraudProtectionConfig({
        shop: session.shop,
        enabled,
        dryRun: true,
        autoCancelHighRisk: enabled,
        autoCancelMediumRisk: false,
        updatedBy: session.email || session.userId?.toString() || session.shop,
      });

      return {
        success: true,
        message: enabled
          ? "Dry-run fraud protection enabled. Orders will not be cancelled."
          : "Fraud protection disabled.",
        config,
      };
    }

    if (intent === "inject_test_tracking") {
      if (!canUseTestTrackingInjectionForShop(session.shop)) {
        throw new Response("Not found", { status: 404 });
      }

      const result = await injectTestTracking({
        shop: session.shop,
        orderRef: String(form.get("orderRef") || form.get("shopifyOrderId") || form.get("orderNumber") || "").trim(),
        trackingNumber: String(form.get("trackingNumber") || "").trim(),
        carrier: String(form.get("carrier") || "").trim(),
        providerOrderId: String(form.get("providerOrderId") || "").trim() || null,
        createdBy: session.email || session.userId?.toString() || session.shop,
      });

      return result;
    }

    const result = await runAdminOrderAction({
      shop: session.shop,
      orderId: String(form.get("orderId") || ""),
      actionType: intent,
      note: String(form.get("note") || "").trim().slice(0, 2000),
      createdBy: session.email || session.userId?.toString() || session.shop,
    });
    return result;
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("Operations dashboard admin action failure:", err?.message || err);
    const status = /required|not found|not eligible|not allowed|invalid|blocked|missing/i.test(err?.message || "")
      ? 400
      : 500;
    return {
      success: false,
      error: err?.message || "Admin action failed.",
      status,
    };
  }
};

export default function OperationsDashboard() {
  const { dashboard, filters, testTrackingInjectionEnabled } = useLoaderData();
  return (
    <OperationsDashboardPage
      dashboard={dashboard}
      filters={filters}
      testTrackingInjectionEnabled={testTrackingInjectionEnabled}
    />
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Operations dashboard rendering failure:", error);
  return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
