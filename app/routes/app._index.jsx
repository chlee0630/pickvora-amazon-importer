import { useFetcher, useLoaderData } from "react-router";
import { btnStyle } from "../utils/btn";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runNow } from "../services/scheduler.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [total, synced, outOfStock, errors, warned, blocked, logs, schedulerConfig] =
    await Promise.all([
      prisma.amazonProduct.count(),
      prisma.amazonProduct.count({ where: { syncStatus: "synced" } }),
      prisma.amazonProduct.count({ where: { outOfStock: true } }),
      prisma.amazonProduct.count({ where: { syncStatus: "error" } }),
      prisma.amazonProduct.count({ where: { filterStatus: "warned" } }),
      prisma.amazonProduct.count({ where: { filterStatus: "blocked" } }),
      prisma.updateLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.schedulerConfig.findUnique({ where: { shop: session.shop } }),
    ]);

  return {
    stats: { total, synced, outOfStock, errors, warned, blocked },
    logs,
    schedulerConfig,
    shop: session.shop,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "sync_all") {
    try {
      const result = await runNow(session.shop, session.accessToken);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return null;
};

export default function Dashboard() {
  const { stats, logs, schedulerConfig } = useLoaderData();
  const fetcher = useFetcher();
  const isSyncing =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "sync_all";

  const lastRun = schedulerConfig?.lastRunAt
    ? new Date(schedulerConfig.lastRunAt).toLocaleString()
    : "Never";

  const syncResult = fetcher.data;

  return (
    <s-page heading="Amazon Importer Dashboard">
      <s-stack direction="inline" gap="base" slot="primary-action">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="sync_all" />
          <button
            type="submit"
            disabled={isSyncing}
            style={btnStyle("primary", { disabled: isSyncing })}
          >
            {isSyncing ? "⏳ 동기화 중..." : "Sync All Products"}
          </button>
        </fetcher.Form>
        <s-button href="/app/import" variant="secondary">
          Import ASIN
        </s-button>
      </s-stack>

      {syncResult && (
        <s-banner
          tone={syncResult.success ? "success" : "critical"}
          title={
            syncResult.success
              ? `Sync complete: ${syncResult.result?.success ?? 0} success, ${syncResult.result?.errors ?? 0} errors`
              : `Sync failed: ${syncResult.error}`
          }
        />
      )}

      {/* Stats */}
      <s-section heading="Overview">
        <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap" }}>
          {[
            { value: stats.total,      label: "Total Products", color: "#2c6ecb" },
            { value: stats.synced,     label: "Synced",         color: "#155724" },
            { value: stats.outOfStock, label: "Out of Stock",   color: "#856404" },
            { value: stats.errors,     label: "Errors",         color: "#721c24" },
            { value: stats.warned,     label: "⚠️ Warned",      color: "#a84e00" },
            { value: stats.blocked,    label: "🚫 Blocked",     color: "#721c24" },
          ].map(({ value, label, color }) => (
            <div key={label} style={{
              minWidth: "110px", textAlign: "center", padding: "12px 16px",
              border: "1px solid #e1e3e5", borderRadius: "8px", background: "white",
            }}>
              <div style={{ fontSize: "28px", fontWeight: "bold", color }}>{value}</div>
              <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>{label}</div>
            </div>
          ))}
        </s-stack>

        {(stats.warned > 0 || stats.blocked > 0) && (
          <div style={{ marginTop: "12px" }}>
            <s-button href="/app/filters" variant="secondary">
              저작권 위험 상품 확인하기 →
            </s-button>
          </div>
        )}
      </s-section>

      {/* Scheduler Status */}
      <s-section heading="Scheduler Status">
        <s-paragraph>
          <s-text>Status: </s-text>
          <s-badge tone={schedulerConfig?.enabled ? "success" : "attention"}>
            {schedulerConfig?.enabled ? "Active" : "Disabled"}
          </s-badge>
        </s-paragraph>
        {schedulerConfig?.enabled && (
          <s-paragraph>
            <s-text>Schedule: </s-text>
            <s-text>
              {schedulerConfig.schedule === "hourly"
                ? "Every hour"
                : schedulerConfig.schedule === "twice_daily"
                  ? "Twice daily (9AM, 6PM)"
                  : "Daily (9AM)"}
            </s-text>
          </s-paragraph>
        )}
        <s-paragraph>
          <s-text>Last run: {lastRun}</s-text>
        </s-paragraph>
        <s-button href="/app/settings" variant="tertiary">
          Configure Scheduler
        </s-button>
      </s-section>

      {/* Update Logs */}
      <s-section heading="Recent Update Logs">
        {logs.length === 0 ? (
          <s-paragraph>No logs yet. Import some products to get started.</s-paragraph>
        ) : (
          <s-box
            padding="none"
            borderWidth="base"
            borderRadius="base"
            background="default"
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Time</th>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>ASIN</th>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Action</th>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Status</th>
                  <th style={{ padding: "8px 12px", textAlign: "left" }}>Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    style={{ borderBottom: "1px solid #e1e3e5" }}
                  >
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>
                      {log.asin || "-"}
                    </td>
                    <td style={{ padding: "8px 12px" }}>{log.action}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "12px",
                          fontSize: "11px",
                          fontWeight: "bold",
                          background: log.status === "success" ? "#d4edda" : "#f8d7da",
                          color: log.status === "success" ? "#155724" : "#721c24",
                        }}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {log.message || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
