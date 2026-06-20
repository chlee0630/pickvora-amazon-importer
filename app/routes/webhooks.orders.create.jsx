import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueueOrderProcessingJob } from "../queues/order-queue.server";
import { sanitizeOrderWebhookLogPayload } from "../utils/order-webhook-log-payload.server.js";

export const action = async ({ request }) => {
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const { payload, topic, shop } = await authenticate.webhook(request);
  const shopifyOrderId = getShopifyOrderGid(payload);

  console.log(JSON.stringify({
    event: "order_webhook_received",
    layer: "order_webhook",
    topic,
    shop,
    webhookId,
    shopifyOrderId,
  }));

  if (!shopifyOrderId) {
    await db.orderWebhookLog.create({
      data: {
        shop,
        topic,
        webhookId,
        shopifyOrderId: "unknown",
        status: "ignored",
        payload: JSON.stringify(sanitizeOrderWebhookLogPayload(payload || {})),
        error: "Missing Shopify order id",
      },
    });
    return new Response();
  }

  if (webhookId) {
    const existing = await db.orderWebhookLog.findUnique({ where: { webhookId } });
    if (existing) {
      console.log(JSON.stringify({
        event: "order_webhook_duplicate_skipped",
        layer: "order_webhook",
        reason: "webhook_id",
        topic,
        shop,
        webhookId,
        shopifyOrderId,
      }));
      return new Response();
    }
  }

  const existingOrderJob = await db.orderQueueJob.findUnique({
    where: {
      shop_type_shopifyOrderId: {
        shop,
        type: "order.create",
        shopifyOrderId,
      },
    },
  });
  if (existingOrderJob) {
    console.log(JSON.stringify({
      event: "order_webhook_duplicate_skipped",
      layer: "order_webhook",
      reason: "shopify_order_id",
      topic,
      shop,
      webhookId,
      shopifyOrderId,
    }));
    return new Response();
  }

  try {
    await db.orderWebhookLog.create({
      data: {
        shop,
        topic,
        webhookId,
        shopifyOrderId,
        status: "enqueued",
        payload: JSON.stringify(sanitizeOrderWebhookLogPayload(payload || {})),
      },
    });
  } catch (err) {
    if (err.code === "P2002") return new Response();
    throw err;
  }

  await enqueueOrderProcessingJob({
    shop,
    shopifyOrderId,
    payload,
  });

  return new Response();
};

function getShopifyOrderGid(payload) {
  if (payload?.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload?.id) return `gid://shopify/Order/${payload.id}`;
  return null;
}
