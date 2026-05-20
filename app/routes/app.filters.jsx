import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { btnStyle } from "../utils/btn";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { RISK_EMOJI, RISK_LABEL } from "../utils/filter-constants";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const [brands, categories, keywords, warnedProducts, blockedProducts] =
    await Promise.all([
      prisma.brandBlacklist.findMany({ orderBy: { riskLevel: "asc" } }),
      prisma.categoryBlacklist.findMany({ orderBy: { category: "asc" } }),
      prisma.keywordFilter.findMany({ orderBy: { keyword: "asc" } }),
      prisma.amazonProduct.findMany({
        where: { filterStatus: "warned" },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.amazonProduct.findMany({
        where: { filterStatus: "blocked" },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

  return { brands, categories, keywords, warnedProducts, blockedProducts };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // --- Brand actions ---
  if (intent === "add_brand") {
    const brand = form.get("brand")?.trim();
    const riskLevel = form.get("riskLevel") || "high";
    if (!brand) return { error: "Brand name is required" };
    await prisma.brandBlacklist.upsert({
      where: { brand },
      create: { brand, riskLevel },
      update: { riskLevel, enabled: true },
    });
    return { success: true };
  }

  if (intent === "toggle_brand") {
    const id = form.get("id");
    const enabled = form.get("enabled") === "true";
    await prisma.brandBlacklist.update({ where: { id }, data: { enabled: !enabled } });
    return { success: true };
  }

  if (intent === "delete_brand") {
    const id = form.get("id");
    await prisma.brandBlacklist.delete({ where: { id } });
    return { success: true };
  }

  // --- Category actions ---
  if (intent === "add_category") {
    const category = form.get("category")?.trim();
    if (!category) return { error: "Category name is required" };
    await prisma.categoryBlacklist.upsert({
      where: { category },
      create: { category },
      update: { enabled: true },
    });
    return { success: true };
  }

  if (intent === "toggle_category") {
    const id = form.get("id");
    const enabled = form.get("enabled") === "true";
    await prisma.categoryBlacklist.update({ where: { id }, data: { enabled: !enabled } });
    return { success: true };
  }

  if (intent === "delete_category") {
    const id = form.get("id");
    await prisma.categoryBlacklist.delete({ where: { id } });
    return { success: true };
  }

  // --- Keyword actions ---
  if (intent === "add_keyword") {
    const keyword = form.get("keyword")?.trim();
    if (!keyword) return { error: "Keyword is required" };
    await prisma.keywordFilter.upsert({
      where: { keyword },
      create: { keyword },
      update: { enabled: true },
    });
    return { success: true };
  }

  if (intent === "toggle_keyword") {
    const id = form.get("id");
    const enabled = form.get("enabled") === "true";
    await prisma.keywordFilter.update({ where: { id }, data: { enabled: !enabled } });
    return { success: true };
  }

  if (intent === "delete_keyword") {
    const id = form.get("id");
    await prisma.keywordFilter.delete({ where: { id } });
    return { success: true };
  }

  // --- Remove blocked product ---
  if (intent === "remove_blocked") {
    const id = form.get("id");
    await prisma.amazonProduct.delete({ where: { id } });
    return { success: true };
  }

  return null;
};

const RISK_BG = {
  high: "#f8d7da",
  medium: "#fff3cd",
  low: "#d4edda",
  safe: "#d4edda",
};
const RISK_COLOR = {
  high: "#721c24",
  medium: "#856404",
  low: "#155724",
  safe: "#155724",
};

function RiskBadge({ level }) {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: "bold",
        background: RISK_BG[level] || "#eee",
        color: RISK_COLOR[level] || "#333",
      }}
    >
      {RISK_EMOJI[level]} {RISK_LABEL[level] || level}
    </span>
  );
}

export default function FiltersPage() {
  const { brands, categories, keywords, warnedProducts, blockedProducts } =
    useLoaderData();
  const fetcher = useFetcher();

  const [newBrand, setNewBrand] = useState("");
  const [newBrandRisk, setNewBrandRisk] = useState("high");
  const [newCategory, setNewCategory] = useState("");
  const [newKeyword, setNewKeyword] = useState("");
  const [activeTab, setActiveTab] = useState("brands");

  const tabStyle = (tab) => ({
    padding: "8px 16px",
    cursor: "pointer",
    fontWeight: activeTab === tab ? "bold" : "normal",
    color: activeTab === tab ? "#2c6ecb" : "#6d7175",
    background: "none",
    border: "none",
    borderBottom: activeTab === tab ? "2px solid #2c6ecb" : "2px solid transparent",
    fontSize: "14px",
  });

  return (
    <s-page heading="Copyright Protection Filters">
      {/* Tab nav */}
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "1px solid #e1e3e5", marginBottom: "20px" }}>
          {[
            { id: "brands", label: `🏷️ Brand Blacklist (${brands.length})` },
            { id: "categories", label: `📂 Categories (${categories.length})` },
            { id: "keywords", label: `🔤 Keywords (${keywords.length})` },
            { id: "warned", label: `🟡 Warned (${warnedProducts.length})` },
            { id: "blocked", label: `🔴 Blocked (${blockedProducts.length})` },
          ].map((t) => (
            <button key={t.id} style={tabStyle(t.id)} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Brand Blacklist ── */}
        {activeTab === "brands" && (
          <div>
            <fetcher.Form method="post" style={{ marginBottom: "16px" }}>
              <input type="hidden" name="intent" value="add_brand" />
              <s-stack direction="inline" gap="base" style={{ alignItems: "flex-end" }}>
                <div>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: "4px", fontSize: "13px" }}>
                    Brand Name
                  </label>
                  <input
                    name="brand"
                    value={newBrand}
                    onChange={(e) => setNewBrand(e.target.value)}
                    placeholder="e.g. Zara, H&M"
                    style={{ padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px", width: "200px" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: "4px", fontSize: "13px" }}>
                    Risk Level
                  </label>
                  <select
                    name="riskLevel"
                    value={newBrandRisk}
                    onChange={(e) => setNewBrandRisk(e.target.value)}
                    style={{ padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px" }}
                  >
                    <option value="high">🔴 High — Block</option>
                    <option value="medium">🟡 Medium — Warn</option>
                    <option value="low">🟢 Low — Warn</option>
                  </select>
                </div>
                <button type="submit" style={btnStyle("primary")}>Add Brand</button>
              </s-stack>
            </fetcher.Form>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Brand</th>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Risk</th>
                  <th style={{ padding: "8px 12px", textAlign: "center" }}>Status</th>
                  <th style={{ padding: "8px 12px", textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.id} style={{ borderBottom: "1px solid #e1e3e5", opacity: b.enabled ? 1 : 0.5 }}>
                    <td style={{ padding: "8px 12px", fontWeight: "bold" }}>{b.brand}</td>
                    <td style={{ padding: "8px 12px" }}><RiskBadge level={b.riskLevel} /></td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: b.enabled ? "#155724" : "#6d7175" }}>
                        {b.enabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
                        <fetcher.Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle_brand" />
                          <input type="hidden" name="id" value={b.id} />
                          <input type="hidden" name="enabled" value={String(b.enabled)} />
                          <button type="submit" style={btnStyle("secondary", { slim: true })}>
                            {b.enabled ? "Disable" : "Enable"}
                          </button>
                        </fetcher.Form>
                        <fetcher.Form method="post" style={{ display: "inline" }}
                          onSubmit={(e) => { if (!confirm(`Delete "${b.brand}"?`)) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="delete_brand" />
                          <input type="hidden" name="id" value={b.id} />
                          <button type="submit" style={btnStyle("critical", { slim: true })}>Delete</button>
                        </fetcher.Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Categories ── */}
        {activeTab === "categories" && (
          <div>
            <fetcher.Form method="post" style={{ marginBottom: "16px" }}>
              <input type="hidden" name="intent" value="add_category" />
              <s-stack direction="inline" gap="base" style={{ alignItems: "flex-end" }}>
                <div>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: "4px", fontSize: "13px" }}>
                    Category Name
                  </label>
                  <input
                    name="category"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="e.g. Digital Content"
                    style={{ padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px", width: "220px" }}
                  />
                </div>
                <button type="submit" style={btnStyle("primary")}>Add Category</button>
              </s-stack>
            </fetcher.Form>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Category</th>
                  <th style={{ padding: "8px 12px", textAlign: "center" }}>Status</th>
                  <th style={{ padding: "8px 12px", textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid #e1e3e5", opacity: c.enabled ? 1 : 0.5 }}>
                    <td style={{ padding: "8px 12px" }}>📂 {c.category}</td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: c.enabled ? "#721c24" : "#6d7175" }}>
                        {c.enabled ? "🔴 Blocked" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
                        <fetcher.Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle_category" />
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="enabled" value={String(c.enabled)} />
                          <button type="submit" style={btnStyle("secondary", { slim: true })}>
                            {c.enabled ? "Disable" : "Enable"}
                          </button>
                        </fetcher.Form>
                        <fetcher.Form method="post" style={{ display: "inline" }}
                          onSubmit={(e) => { if (!confirm(`Delete "${c.category}"?`)) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="delete_category" />
                          <input type="hidden" name="id" value={c.id} />
                          <button type="submit" style={btnStyle("critical", { slim: true })}>Delete</button>
                        </fetcher.Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Keywords ── */}
        {activeTab === "keywords" && (
          <div>
            <fetcher.Form method="post" style={{ marginBottom: "16px" }}>
              <input type="hidden" name="intent" value="add_keyword" />
              <s-stack direction="inline" gap="base" style={{ alignItems: "flex-end" }}>
                <div>
                  <label style={{ display: "block", fontWeight: "bold", marginBottom: "4px", fontSize: "13px" }}>
                    Keyword
                  </label>
                  <input
                    name="keyword"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    placeholder="e.g. Licensed"
                    style={{ padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px", width: "220px" }}
                  />
                </div>
                <button type="submit" style={btnStyle("primary")}>Add Keyword</button>
              </s-stack>
            </fetcher.Form>

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Keyword</th>
                  <th style={{ padding: "8px 12px", textAlign: "center" }}>Status</th>
                  <th style={{ padding: "8px 12px", textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((k) => (
                  <tr key={k.id} style={{ borderBottom: "1px solid #e1e3e5", opacity: k.enabled ? 1 : 0.5 }}>
                    <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>"{k.keyword}"</td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <span style={{ fontSize: "11px", color: k.enabled ? "#856404" : "#6d7175" }}>
                        {k.enabled ? "🟡 Warning" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
                        <fetcher.Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle_keyword" />
                          <input type="hidden" name="id" value={k.id} />
                          <input type="hidden" name="enabled" value={String(k.enabled)} />
                          <button type="submit" style={btnStyle("secondary", { slim: true })}>
                            {k.enabled ? "Disable" : "Enable"}
                          </button>
                        </fetcher.Form>
                        <fetcher.Form method="post" style={{ display: "inline" }}
                          onSubmit={(e) => { if (!confirm(`Delete "${k.keyword}"?`)) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="delete_keyword" />
                          <input type="hidden" name="id" value={k.id} />
                          <button type="submit" style={btnStyle("critical", { slim: true })}>Delete</button>
                        </fetcher.Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Warned Products ── */}
        {activeTab === "warned" && (
          <div>
            <s-banner
              tone="warning"
              title="이 상품들은 저작권 위험 요소가 감지되었지만 사용자 확인 후 등록된 상품입니다. 판매 권한을 반드시 확인하세요."
            />
            <div style={{ marginTop: "12px" }}>
              <ProductRiskTable products={warnedProducts} fetcher={fetcher} />
            </div>
          </div>
        )}

        {/* ── Blocked Products ── */}
        {activeTab === "blocked" && (
          <div>
            <s-banner
              tone="critical"
              title="이 상품들은 저작권 필터에 의해 Shopify 등록이 차단된 상품입니다."
            />
            <div style={{ marginTop: "12px" }}>
              <ProductRiskTable products={blockedProducts} fetcher={fetcher} showRemove />
            </div>
          </div>
        )}
      </s-section>

      {/* Info panel */}
      <s-section slot="aside" heading="Filter Rules">
        <s-unordered-list>
          <s-list-item>
            <strong>🔴 High Risk (Blocked):</strong> 브랜드 블랙리스트 high 등급, 제외 카테고리 — Shopify 등록 차단
          </s-list-item>
          <s-list-item>
            <strong>🟡 Medium Risk (Warned):</strong> 브랜드 블랙리스트 medium/low, 키워드 감지 — 경고와 함께 등록
          </s-list-item>
          <s-list-item>
            <strong>✅ Safe:</strong> 필터 미감지 — 정상 등록
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Import 페이지에서 <strong>"Override Blocks"</strong> 체크 시 차단 상품도 경고 표시와 함께 등록 가능합니다.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function ProductRiskTable({ products, fetcher, showRemove = false }) {
  if (products.length === 0) {
    return <s-paragraph>해당하는 상품이 없습니다.</s-paragraph>;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
      <thead>
        <tr style={{ background: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
          <th style={{ padding: "8px 12px", textAlign: "left" }}>ASIN</th>
          <th style={{ padding: "8px 12px", textAlign: "left" }}>Title</th>
          <th style={{ padding: "8px 12px", textAlign: "left" }}>Risk</th>
          <th style={{ padding: "8px 12px", textAlign: "left" }}>Reason</th>
          <th style={{ padding: "8px 12px", textAlign: "left" }}>Date</th>
          {showRemove && <th style={{ padding: "8px 12px" }}>Action</th>}
        </tr>
      </thead>
      <tbody>
        {products.map((p) => (
          <tr key={p.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
            <td style={{ padding: "8px 12px", fontFamily: "monospace", fontWeight: "bold" }}>
              <a href={p.amazonUrl || `https://amazon.com/dp/${p.asin}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: "#2c6ecb", textDecoration: "none" }}>
                {p.asin}
              </a>
            </td>
            <td style={{ padding: "8px 12px", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.title}
            </td>
            <td style={{ padding: "8px 12px" }}>
              <RiskBadge level={p.riskLevel} />
            </td>
            <td style={{ padding: "8px 12px", color: "#6d7175", fontSize: "12px", maxWidth: "160px" }}>
              {p.filterReason || "-"}
            </td>
            <td style={{ padding: "8px 12px", fontSize: "12px", color: "#6d7175", whiteSpace: "nowrap" }}>
              {new Date(p.createdAt).toLocaleDateString()}
            </td>
            {showRemove && (
              <td style={{ padding: "8px 12px" }}>
                <fetcher.Form method="post"
                  onSubmit={(e) => { if (!confirm(`Remove ${p.asin}?`)) e.preventDefault(); }}>
                  <input type="hidden" name="intent" value="remove_blocked" />
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" style={btnStyle("critical", { slim: true })}>Remove</button>
                </fetcher.Form>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
