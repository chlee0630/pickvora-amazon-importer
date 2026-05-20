import { useState } from "react";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import { btnStyle } from "../utils/btn";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { updateScheduler } from "../services/scheduler.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [settings, schedulerConfig] = await Promise.all([
    prisma.appSettings.findUnique({ where: { shop: session.shop } }),
    prisma.schedulerConfig.findUnique({ where: { shop: session.shop } }),
  ]);

  return {
    settings: settings || {
      defaultMargin: 30,
      includeShipping: false,
      autoHideOutOfStock: true,
      addReviewsToDesc: true,
      autoGenerateTags: true,
      saleMode: "direct",
      addDisclaimer: true,
    },
    schedulerConfig: schedulerConfig || {
      schedule: "daily",
      enabled: false,
    },
    // eslint-disable-next-line no-undef
    rainforestApiKeyPreview: process.env.RAINFOREST_API_KEY
      ? `${process.env.RAINFOREST_API_KEY.slice(0, 8)}...`
      : "Not configured",
    // eslint-disable-next-line no-undef
    associateTag: process.env.AMAZON_ASSOCIATE_TAG || "Not configured",
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "save_settings") {
    const defaultMargin = parseFloat(form.get("defaultMargin") || "30");
    const includeShipping = form.get("includeShipping") === "on";
    const autoHideOutOfStock = form.get("autoHideOutOfStock") === "on";
    const addReviewsToDesc = form.get("addReviewsToDesc") === "on";
    const autoGenerateTags = form.get("autoGenerateTags") === "on";
    const saleMode = form.get("saleMode") || "direct";
    const addDisclaimer = form.get("addDisclaimer") === "on";

    await prisma.appSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        defaultMargin,
        includeShipping,
        autoHideOutOfStock,
        addReviewsToDesc,
        autoGenerateTags,
        saleMode,
        addDisclaimer,
      },
      update: {
        defaultMargin,
        includeShipping,
        autoHideOutOfStock,
        addReviewsToDesc,
        autoGenerateTags,
        saleMode,
        addDisclaimer,
      },
    });

    return { settingsSaved: true };
  }

  if (intent === "save_scheduler") {
    const schedule = form.get("schedule") || "daily";
    const enabled = form.get("enabled") === "on";

    await updateScheduler(session.shop, { schedule, enabled });

    return { schedulerSaved: true };
  }

  return null;
};

export default function SettingsPage() {
  const { settings, schedulerConfig, rainforestApiKeyPreview, associateTag } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [margin, setMargin] = useState(settings.defaultMargin);
  const [scheduleEnabled, setScheduleEnabled] = useState(schedulerConfig.enabled);
  const [saleMode, setSaleMode] = useState(settings.saleMode || "direct");

  const SCHEDULE_OPTIONS = [
    { value: "hourly", label: "Every hour (0 * * * *)" },
    { value: "twice_daily", label: "Twice daily — 9AM & 6PM (0 9,18 * * *)" },
    { value: "daily", label: "Once daily — 9AM (0 9 * * *)" },
  ];

  return (
    <s-page heading="Settings">
      {actionData?.settingsSaved && (
        <s-banner tone="success" title="Product settings saved successfully" />
      )}
      {actionData?.schedulerSaved && (
        <s-banner
          tone="success"
          title={`Scheduler ${scheduleEnabled ? "started" : "stopped"} successfully`}
        />
      )}

      {/* Product Settings */}
      <s-section heading="Product Import Settings">
        <Form method="post">
          <input type="hidden" name="intent" value="save_settings" />
          <s-stack direction="block" gap="base">
            {/* Margin Rate */}
            <div>
              <label
                htmlFor="defaultMargin"
                style={{ display: "block", fontWeight: "bold", marginBottom: "6px" }}
              >
                Default Margin Rate (%)
              </label>
              <s-stack direction="inline" gap="base" style={{ alignItems: "center" }}>
                <input
                  id="defaultMargin"
                  name="defaultMargin"
                  type="number"
                  min="0"
                  max="1000"
                  step="0.5"
                  value={margin}
                  onChange={(e) => setMargin(e.target.value)}
                  style={{
                    width: "120px",
                    padding: "8px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: "4px",
                    fontSize: "14px",
                  }}
                />
                <s-text style={{ color: "#6d7175" }}>
                  Amazon $10.00 → Shopify $
                  {(10 * (1 + parseFloat(margin || 0) / 100)).toFixed(2)} (+
                  {margin}%)
                </s-text>
              </s-stack>
            </div>

            {/* Checkboxes */}
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="includeShipping"
                  defaultChecked={settings.includeShipping}
                  style={{ width: "16px", height: "16px" }}
                />
                <span>
                  <strong>Include shipping in price</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                    Adds Amazon shipping cost to the base price before margin
                  </span>
                </span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="autoHideOutOfStock"
                  defaultChecked={settings.autoHideOutOfStock}
                  style={{ width: "16px", height: "16px" }}
                />
                <span>
                  <strong>Auto-hide out-of-stock products</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                    Set product to Draft when Amazon marks it as out of stock
                  </span>
                </span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="addReviewsToDesc"
                  defaultChecked={settings.addReviewsToDesc}
                  style={{ width: "16px", height: "16px" }}
                />
                <span>
                  <strong>Add reviews to product description</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                    Appends top 5 Amazon reviews to the product description HTML
                  </span>
                </span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="autoGenerateTags"
                  defaultChecked={settings.autoGenerateTags}
                  style={{ width: "16px", height: "16px" }}
                />
                <span>
                  <strong>Auto-generate tags</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                    Creates tags from brand, category, Prime status, and ASIN
                  </span>
                </span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="addDisclaimer"
                  defaultChecked={settings.addDisclaimer !== false}
                  style={{ width: "16px", height: "16px" }}
                />
                <span>
                  <strong>면책 조항 자동 추가 (Auto-add disclaimer)</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                    모든 상품 설명 하단에 Amazon Associates 면책 조항을 자동으로 추가합니다
                  </span>
                </span>
              </label>
            </div>

            {/* Sale Mode */}
            <div style={{ padding: "16px", background: "#f6f6f7", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
              <strong style={{ display: "block", marginBottom: "12px", fontSize: "14px" }}>
                🛒 판매 방식 (Sale Mode)
              </strong>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="saleMode"
                    value="direct"
                    checked={saleMode === "direct"}
                    onChange={() => setSaleMode("direct")}
                    style={{ marginTop: "3px" }}
                  />
                  <span>
                    <strong>직접 판매 (Direct Sale)</strong>
                    <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                      Shopify에서 직접 결제 — 상품 재고를 직접 관리해야 합니다
                    </span>
                  </span>
                </label>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="saleMode"
                    value="affiliate"
                    checked={saleMode === "affiliate"}
                    onChange={() => setSaleMode("affiliate")}
                    style={{ marginTop: "3px" }}
                  />
                  <span>
                    <strong>제휴 링크 방식 (Affiliate / Dropshipping Safe Mode)</strong>
                    <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                      구매 버튼 클릭 시 Amazon으로 리다이렉트 (Associate Tag: {associateTag}).
                      상품 설명에 "Amazon에서 구매하기" 버튼이 자동으로 추가됩니다.
                      제휴 수수료로 수익을 얻습니다.
                    </span>
                  </span>
                </label>
              </div>
              {saleMode === "affiliate" && (
                <div style={{ marginTop: "10px", padding: "10px", background: "#fff3cd", borderRadius: "4px", fontSize: "12px", color: "#856404" }}>
                  ⚠️ 제휴 링크 방식에서는 Shopify 결제가 이루어지지 않습니다. 가격은 참고용으로만 표시됩니다.
                  Amazon Associates 프로그램의 이용 약관을 준수하세요.
                </div>
              )}
            </div>

            <div>
              <button
                type="submit"
                disabled={isSubmitting && navigation.formData?.get("intent") === "save_settings"}
                style={btnStyle("primary", {
                  disabled: isSubmitting && navigation.formData?.get("intent") === "save_settings",
                })}
              >
                {isSubmitting && navigation.formData?.get("intent") === "save_settings"
                  ? "⏳ 저장 중..."
                  : "설정 저장 (Save Settings)"}
              </button>
            </div>
          </s-stack>
        </Form>
      </s-section>

      {/* Scheduler Settings */}
      <s-section heading="Auto-Update Scheduler">
        <s-paragraph>
          Automatically sync prices, stock levels, and availability for all
          imported products on a schedule.
        </s-paragraph>

        <Form method="post">
          <input type="hidden" name="intent" value="save_scheduler" />
          <s-stack direction="block" gap="base">
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox"
                name="enabled"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                style={{ width: "16px", height: "16px" }}
              />
              <span>
                <strong>Enable automatic updates</strong>
                <span style={{ display: "block", fontSize: "12px", color: "#6d7175" }}>
                  Keep product data in sync with Amazon automatically
                </span>
              </span>
            </label>

            {scheduleEnabled && (
              <div>
                <label
                  htmlFor="schedule"
                  style={{ display: "block", fontWeight: "bold", marginBottom: "6px" }}
                >
                  Update Frequency
                </label>
                <select
                  id="schedule"
                  name="schedule"
                  defaultValue={schedulerConfig.schedule}
                  style={{
                    padding: "8px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: "4px",
                    fontSize: "14px",
                    width: "320px",
                  }}
                >
                  {SCHEDULE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={isSubmitting && navigation.formData?.get("intent") === "save_scheduler"}
                style={btnStyle("primary", {
                  disabled: isSubmitting && navigation.formData?.get("intent") === "save_scheduler",
                })}
              >
                {isSubmitting && navigation.formData?.get("intent") === "save_scheduler"
                  ? "⏳ 저장 중..."
                  : scheduleEnabled ? "Start Scheduler" : "Stop Scheduler"}
              </button>
            </div>
          </s-stack>
        </Form>

        {schedulerConfig.lastRunAt && (
          <s-paragraph style={{ marginTop: "12px" }}>
            <s-text>Last automatic run: </s-text>
            <s-text>
              {new Date(schedulerConfig.lastRunAt).toLocaleString()}
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      {/* Info */}
      <s-section slot="aside" heading="Rainforest API">
        <s-paragraph>
          This app uses the Rainforest API to fetch Amazon product data.
        </s-paragraph>
        <s-paragraph>
          <strong>API Key:</strong> {rainforestApiKeyPreview}
        </s-paragraph>
        <s-paragraph>
          <strong>Associate Tag:</strong> {associateTag}
        </s-paragraph>
        <s-button
          href="https://www.rainforestapi.com"
          target="_blank"
          variant="tertiary"
        >
          Rainforest API Dashboard
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
