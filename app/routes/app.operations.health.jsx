import { authenticate } from "../shopify.server";
import { getDashboardHealthSummary } from "../services/monitoring/health-monitor.service";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return getDashboardHealthSummary({ shop: session.shop });
};
