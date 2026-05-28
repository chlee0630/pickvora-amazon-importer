import { authenticate } from "../shopify.server";
import {
  getFulfillmentExceptionSummary,
  parseFulfillmentExceptionRequest,
} from "../services/analytics/fulfillment-exception-analytics.service";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const filters = parseFulfillmentExceptionRequest(request, { shop: session.shop });
  return getFulfillmentExceptionSummary(filters);
};
