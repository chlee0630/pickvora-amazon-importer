import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { initAllSchedulers } from "../services/scheduler.server";
import { initDefaultFilters } from "../services/filter.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // Initialize schedulers and default filters once per server process
  if (!globalThis.__appInitialized) {
    globalThis.__appInitialized = true;
    initAllSchedulers().catch((err) =>
      console.error("Scheduler init error:", err)
    );
    initDefaultFilters().catch((err) =>
      console.error("Filter init error:", err)
    );
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/import">Import ASIN</s-link>
        <s-link href="/app/popular">Popular Products</s-link>
        <s-link href="/app/filters">Copyright Filters</s-link>
        <s-link href="/app/settings">Settings</s-link>
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
