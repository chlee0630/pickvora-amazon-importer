import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { NavMenu } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { initAllSchedulers } from "../services/scheduler.server";
import { initDefaultFilters } from "../services/filter.server";
import { initOrderWorkers } from "../workers/order-worker.server";
import { initFulfillmentUpdateWorkers } from "../workers/fulfillment-update-worker.server";
import { initAnalyticsAggregation } from "../services/analytics/analytics-service.server";
import { bootstrapTrackingPollingWorker } from "../utils/worker-bootstrap.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // Initialize schedulers and default filters once per server process
  // eslint-disable-next-line no-undef
  const g = globalThis;
  if (!g.__appInitialized) {
    g.__appInitialized = true;
    initAllSchedulers().catch((err) =>
      console.error("Scheduler init error:", err)
    );
    initDefaultFilters().catch((err) =>
      console.error("Filter init error:", err)
    );
    initOrderWorkers();
    bootstrapTrackingPollingWorker();
    initFulfillmentUpdateWorkers();
    initAnalyticsAggregation();
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/operations">Operations</Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/import">Import ASIN</Link>
        <Link to="/app/popular">Popular Products</Link>
        <Link to="/app/filters">Copyright Filters</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
