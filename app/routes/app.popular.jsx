import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { btnStyle } from "../utils/btn";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  fetchBestSellers,
  fetchMostWishedFor,
  fetchNewReleases,
  AMAZON_CATEGORIES,
} from "../services/rainforest.server";
import { importASINs } from "../services/amazon-sync.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { categories: AMAZON_CATEGORIES };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "fetch_popular") {
    const listType = form.get("listType") || "bestsellers";
    const categoryId = form.get("categoryId") || null;

    try {
      let items;
      if (listType === "bestsellers") items = await fetchBestSellers(categoryId);
      else if (listType === "most_wished_for") items = await fetchMostWishedFor(categoryId);
      else items = await fetchNewReleases(categoryId);

      // Mark which ones are already imported
      const asins = items.map((i) => i.asin).filter(Boolean);
      const existing = await prisma.amazonProduct.findMany({
        where: { asin: { in: asins } },
        select: { asin: true },
      });
      const existingSet = new Set(existing.map((e) => e.asin));

      return {
        items: items.map((item) => ({
          ...item,
          alreadyImported: existingSet.has(item.asin),
        })),
        listType,
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (intent === "import_selected") {
    const asins = form.getAll("selectedAsins");
    if (!asins.length) return { importError: "No ASINs selected" };

    const settings = await prisma.appSettings.findUnique({
      where: { shop: session.shop },
    });
    const defaultMargin = settings?.defaultMargin ?? 30;

    const results = await importASINs(asins, session.shop, session.accessToken);
    const success = results.filter((r) => r.status === "success").length;
    const errors = results.filter((r) => r.status === "error").length;

    return { importResults: results, importSuccess: success, importErrors: errors };
  }

  return null;
};

export default function PopularPage() {
  const { categories } = useLoaderData();
  const fetcher = useFetcher();
  const [selectedAsins, setSelectedAsins] = useState(new Set());
  const [listType, setListType] = useState("bestsellers");
  const [categoryId, setCategoryId] = useState("");

  const isFetching =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "fetch_popular";
  const isImporting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "import_selected";

  const items = fetcher.data?.items || [];

  const toggleSelect = (asin) => {
    setSelectedAsins((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      return next;
    });
  };

  const toggleAll = () => {
    const importable = items.filter((i) => !i.alreadyImported).map((i) => i.asin);
    if (selectedAsins.size === importable.length) {
      setSelectedAsins(new Set());
    } else {
      setSelectedAsins(new Set(importable));
    }
  };

  const LIST_TYPES = [
    { value: "bestsellers", label: "Best Sellers" },
    { value: "most_wished_for", label: "Most Wished For" },
    { value: "new_releases", label: "New Releases" },
  ];

  return (
    <s-page heading="Popular Products">
      {/* Filters */}
      <s-section heading="Browse Amazon Popular Products">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="fetch_popular" />
          <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label
                htmlFor="listType"
                style={{ display: "block", fontWeight: "bold", marginBottom: "6px" }}
              >
                List Type
              </label>
              <select
                id="listType"
                name="listType"
                value={listType}
                onChange={(e) => setListType(e.target.value)}
                style={{
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                {LIST_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="categoryId"
                style={{ display: "block", fontWeight: "bold", marginBottom: "6px" }}
              >
                Category
              </label>
              <select
                id="categoryId"
                name="categoryId"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                style={{
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={isFetching}
              style={btnStyle("primary", { disabled: isFetching })}
            >
              {isFetching ? "⏳ Fetching..." : "Browse"}
            </button>
          </s-stack>
        </fetcher.Form>

        {fetcher.data?.error && (
          <s-banner tone="critical" title={`API Error: ${fetcher.data.error}`} />
        )}
        {fetcher.data?.importResults && (
          <s-banner
            tone={fetcher.data.importErrors > 0 ? "warning" : "success"}
            title={`Import complete: ${fetcher.data.importSuccess} imported, ${fetcher.data.importErrors} errors`}
          />
        )}
      </s-section>

      {/* Results */}
      {items.length > 0 && (
        <s-section
          heading={`${LIST_TYPES.find((t) => t.value === fetcher.data?.listType)?.label ?? "Products"} (${items.length})`}
        >
          <s-stack direction="inline" gap="base" style={{ marginBottom: "16px" }}>
            <s-button
              variant="secondary"
              onClick={toggleAll}
            >
              {selectedAsins.size === items.filter((i) => !i.alreadyImported).length && selectedAsins.size > 0
                ? "Deselect All"
                : "Select All"}
            </s-button>
            {selectedAsins.size > 0 && (
              <fetcher.Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="import_selected" />
                {[...selectedAsins].map((asin) => (
                  <input key={asin} type="hidden" name="selectedAsins" value={asin} />
                ))}
                <button
                  type="submit"
                  disabled={isImporting}
                  style={btnStyle("primary", { disabled: isImporting })}
                >
                  {isImporting ? "⏳ Importing..." : `Import Selected (${selectedAsins.size})`}
                </button>
              </fetcher.Form>
            )}
          </s-stack>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "16px",
            }}
          >
            {items.map((item) => (
              <div
                key={item.asin}
                onClick={() => !item.alreadyImported && toggleSelect(item.asin)}
                style={{
                  border: selectedAsins.has(item.asin)
                    ? "2px solid #2c6ecb"
                    : "1px solid #e1e3e5",
                  borderRadius: "8px",
                  padding: "12px",
                  cursor: item.alreadyImported ? "default" : "pointer",
                  background: item.alreadyImported ? "#f6f6f7" : "white",
                  position: "relative",
                  transition: "border-color 0.15s",
                }}
              >
                {item.alreadyImported && (
                  <div
                    style={{
                      position: "absolute",
                      top: "8px",
                      right: "8px",
                      background: "#d4edda",
                      color: "#155724",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontSize: "11px",
                      fontWeight: "bold",
                    }}
                  >
                    Imported
                  </div>
                )}
                {selectedAsins.has(item.asin) && (
                  <div
                    style={{
                      position: "absolute",
                      top: "8px",
                      right: "8px",
                      background: "#2c6ecb",
                      color: "white",
                      width: "20px",
                      height: "20px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "12px",
                    }}
                  >
                    ✓
                  </div>
                )}

                {item.image && (
                  <img
                    src={item.image}
                    alt={item.title}
                    style={{
                      width: "100%",
                      height: "140px",
                      objectFit: "contain",
                      marginBottom: "8px",
                    }}
                  />
                )}

                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: "bold",
                    marginBottom: "4px",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {item.title}
                </div>

                <div style={{ fontSize: "11px", color: "#6d7175", marginBottom: "4px" }}>
                  #{item.position} · ASIN: {item.asin}
                </div>

                {item.price != null && (
                  <div style={{ fontSize: "14px", fontWeight: "bold", color: "#b12704" }}>
                    ${item.price.toFixed(2)}
                  </div>
                )}

                {item.rating != null && (
                  <div style={{ fontSize: "11px", color: "#6d7175" }}>
                    ★ {item.rating} ({(item.ratingsTotal || 0).toLocaleString()})
                  </div>
                )}
              </div>
            ))}
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
