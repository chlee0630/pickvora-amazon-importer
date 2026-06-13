const ORDER_CREATE_QUEUE_ORDER_FIELDS = [
  "id",
  "admin_graphql_api_id",
  "name",
  "test",
  "financial_status",
  "fulfillment_status",
  "total_price",
  "currency",
];

const ORDER_CREATE_QUEUE_LINE_ITEM_FIELDS = [
  "product_id",
  "variant_id",
  "sku",
  "title",
  "quantity",
];

export function sanitizeOrderCreateQueuePayload(payload = {}) {
  if (!payload || typeof payload !== "object") return {};

  const safePayload = pickDefinedFields(payload, ORDER_CREATE_QUEUE_ORDER_FIELDS);
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  safePayload.line_items = lineItems
    .filter((item) => item && typeof item === "object")
    .map((item) => pickDefinedFields(item, ORDER_CREATE_QUEUE_LINE_ITEM_FIELDS));

  return safePayload;
}

function pickDefinedFields(source, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}
