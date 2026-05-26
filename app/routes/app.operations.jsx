import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
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
