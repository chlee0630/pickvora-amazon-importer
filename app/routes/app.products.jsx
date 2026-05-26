import { useFetcher, useLoaderData } from "react-router";
import { btnStyle } from "../utils/btn";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncProduct } from "../services/amazon-sync.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = 20;
  const skip = (page - 1) * limit;

  const [products, total] = await Promise.all([
    prisma.amazonProduct.findMany({
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.amazonProduct.count(),
  ]);

  return { products, total, page, limit };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const productId = form.get("productId");

  if (intent === "sync_one") {
    const product = await prisma.amazonProduct.findUnique({
      where: { id: productId },
    });
    if (!product) return { error: "Product not found" };

    try {
      await syncProduct(product, session.shop, session.accessToken);
      return { success: true, message: `${product.asin} synced` };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (intent === "remove") {
    await prisma.amazonProduct.delete({ where: { id: productId } });
    return { success: true, message: "Product removed" };
  }

  return null;
};

const STATUS_COLORS = {
  synced: { bg: "#d4edda", color: "#155724" },
  pending: { bg: "#fff3cd", color: "#856404" },
  error: { bg: "#f8d7da", color: "#721c24" },
  hidden: { bg: "#e2e3e5", color: "#383d41" },
};

export default function ProductsPage() {
  const { products, total, page, limit } = useLoaderData();
  const fetcher = useFetcher();
  const totalPages = Math.ceil(total / limit);

  const actionResult = fetcher.data;

  return (
    <s-page heading={`Imported Products (${total})`}>
      <s-button slot="primary-action" href="/app/import" variant="primary">
        Import ASIN
      </s-button>

      {actionResult?.success && (
        <s-banner tone="success" title={actionResult.message} />
      )}
      {actionResult?.error && (
        <s-banner tone="critical" title={actionResult.error} />
      )}

      <s-section>
        {products.length === 0 ? (
          <s-stack direction="block" gap="base" style={{ padding: "40px", textAlign: "center" }}>
            <s-heading>No products imported yet</s-heading>
            <s-paragraph>Go to Import ASIN to start importing Amazon products.</s-paragraph>
            <s-button href="/app/import" variant="primary">
              Import Products
            </s-button>
          </s-stack>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
                  <th style={{ padding: "10px 12px", textAlign: "left" }}>ASIN</th>
                  <th style={{ padding: "10px 12px", textAlign: "left" }}>Title</th>
                  <th style={{ padding: "10px 12px", textAlign: "right" }}>Amazon $</th>
                  <th style={{ padding: "10px 12px", textAlign: "right" }}>Shopify $</th>
                  <th style={{ padding: "10px 12px", textAlign: "center" }}>Rating</th>
                  <th style={{ padding: "10px 12px", textAlign: "center" }}>Margin</th>
                  <th style={{ padding: "10px 12px", textAlign: "center" }}>Status</th>
                  <th style={{ padding: "10px 12px", textAlign: "left" }}>Last Synced</th>
                  <th style={{ padding: "10px 12px", textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const statusStyle = STATUS_COLORS[p.syncStatus] || STATUS_COLORS.pending;
                  const isActing =
                    fetcher.state !== "idle" &&
                    fetcher.formData?.get("productId") === p.id;

                  return (
                    <tr key={p.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontWeight: "bold" }}>
                        <a
                          href={p.amazonUrl || `https://amazon.com/dp/${p.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#2c6ecb", textDecoration: "none" }}
                        >
                          {p.asin}
                        </a>
                      </td>
                      <td style={{ padding: "10px 12px", maxWidth: "200px" }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.title}
                        </div>
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "right" }}>
                        {p.price != null ? `$${p.price.toFixed(2)}` : "-"}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: "bold" }}>
                        {p.shopifyPrice != null ? `$${p.shopifyPrice.toFixed(2)}` : "-"}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        {p.rating != null ? (
                          <span style={{ fontSize: "12px", color: "#6d7175", whiteSpace: "nowrap" }}>
                            ★ {Number(p.rating).toFixed(1)}
                            {p.ratingsTotal > 0 ? ` (${p.ratingsTotal.toLocaleString()})` : ""}
                          </span>
                        ) : "-"}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        {p.marginRate}%
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "12px",
                            fontSize: "11px",
                            fontWeight: "bold",
                            background: statusStyle.bg,
                            color: statusStyle.color,
                          }}
                        >
                          {p.syncStatus}
                        </span>
                        {p.outOfStock && (
                          <span
                            style={{
                              marginLeft: "4px",
                              padding: "2px 6px",
                              borderRadius: "12px",
                              fontSize: "10px",
                              background: "#f8d7da",
                              color: "#721c24",
                            }}
                          >
                            OOS
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px", fontSize: "12px", color: "#6d7175" }}>
                        {p.lastSyncedAt
                          ? new Date(p.lastSyncedAt).toLocaleDateString()
                          : "Never"}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "nowrap" }}>
                          <fetcher.Form method="post">
                            <input type="hidden" name="intent" value="sync_one" />
                            <input type="hidden" name="productId" value={p.id} />
                            <button
                              type="submit"
                              disabled={isActing}
                              style={btnStyle("secondary", { slim: true, disabled: isActing })}
                            >
                              {isActing ? "⏳" : "Sync"}
                            </button>
                          </fetcher.Form>
                          {p.shopifyProductId && (
                            <a
                              href={p.amazonUrl || `https://amazon.com/dp/${p.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={btnStyle("plain", { slim: true })}
                            >
                              View
                            </a>
                          )}
                          <fetcher.Form
                            method="post"
                            onSubmit={(e) => {
                              if (!confirm(`Remove ${p.asin} from tracking?`))
                                e.preventDefault();
                            }}
                          >
                            <input type="hidden" name="intent" value="remove" />
                            <input type="hidden" name="productId" value={p.id} />
                            <button
                              type="submit"
                              style={btnStyle("critical", { slim: true })}
                            >
                              Remove
                            </button>
                          </fetcher.Form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <s-stack direction="inline" gap="base" style={{ marginTop: "16px", justifyContent: "center" }}>
            {page > 1 && (
              <s-button href={`/app/products?page=${page - 1}`} variant="tertiary">
                Previous
              </s-button>
            )}
            <s-text>
              Page {page} of {totalPages}
            </s-text>
            {page < totalPages && (
              <s-button href={`/app/products?page=${page + 1}`} variant="tertiary">
                Next
              </s-button>
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
