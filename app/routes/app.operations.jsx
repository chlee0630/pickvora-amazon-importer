import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { runAdminOrderAction } from "../services/admin-order-actions.server";
import { getOperationsDashboard } from "../services/dashboard.server";
import { parseDashboardFilters } from "../utils/dashboard-filters.server";
import OperationsDashboardPage from "../pages/operations-dashboard";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const filters = parseDashboardFilters(request);
  const dashboard = await getOperationsDashboard(session.shop, filters);

  return {
    dashboard,
    filters,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    const result = await runAdminOrderAction({
      shop: session.shop,
      orderId: String(form.get("orderId") || ""),
      actionType: intent,
      note: String(form.get("note") || "").trim().slice(0, 2000),
      createdBy: session.email || session.userId?.toString() || session.shop,
    });
    return result;
  } catch (err) {
    console.error("Operations dashboard admin action failure:", err?.message || err);
    return {
      success: false,
      error: err?.message || "Admin action failed.",
    };
  }
};

export default function OperationsDashboard() {
  const { dashboard, filters } = useLoaderData();
  return <OperationsDashboardPage dashboard={dashboard} filters={filters} />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Operations dashboard rendering failure:", error);
  return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
