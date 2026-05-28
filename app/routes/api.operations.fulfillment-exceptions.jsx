import { authenticate } from "../shopify.server";
import {
  getFulfillmentExceptionDetails,
  parseFulfillmentExceptionRequest,
} from "../services/analytics/fulfillment-exception-analytics.service";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const filters = parseFulfillmentExceptionRequest(request, { shop: session.shop });
  return getFulfillmentExceptionDetails(filters, {
    page: filters.page,
    limit: filters.limit,
  });
};
