import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueueOrderProcessingJob } from "../queues/order-queue.server";

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
        payload: JSON.stringify(payload || {}),
        error: "Missing Shopify order id",
      },
    });
    return new Response();
  }

  if (webhookId) {
    const existing = await db.orderWebhookLog.findUnique({ where: { webhookId } });
    if (existing) return new Response();
  }

  try {
    await db.orderWebhookLog.create({
      data: {
        shop,
        topic,
        webhookId,
        shopifyOrderId,
        status: "enqueued",
        payload: JSON.stringify(payload || {}),
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
    provider: "zinc",
  });

  return new Response();
};

function getShopifyOrderGid(payload) {
  if (payload?.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload?.id) return `gid://shopify/Order/${payload.id}`;
  return null;
}
