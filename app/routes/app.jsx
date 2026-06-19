import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { initAllSchedulers } from "../services/scheduler.server";
import { initDefaultFilters } from "../services/filter.server";
import { initOrderWorkers } from "../workers/order-worker.server";
import { initFulfillmentUpdateWorkers } from "../workers/fulfillment-update-worker.server";
import { initAnalyticsAggregation } from "../services/analytics/analytics-service.server";
import { bootstrapTrackingPollingWorker } from "../utils/worker-bootstrap.server";
import { withEmbeddedAppContext } from "../utils/embedded-app-url";

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
  const location = useLocation();
  const appHref = (path) => withEmbeddedAppContext(path, location.search);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href={appHref("/app")}>Dashboard</s-link>
        <s-link href={appHref("/app/operations")}>Operations</s-link>
        <s-link href={appHref("/app/products")}>Products</s-link>
        <s-link href={appHref("/app/import")}>Import ASIN</s-link>
        <s-link href={appHref("/app/popular")}>Popular Products</s-link>
        <s-link href={appHref("/app/filters")}>Copyright Filters</s-link>
        <s-link href={appHref("/app/settings")}>Settings</s-link>
      </s-app-nav>
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
