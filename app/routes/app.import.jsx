/* eslint-disable jsx-a11y/label-has-associated-control, react/no-unescaped-entities */

import { useState } from "react";
import { Form, useActionData, useNavigation, useLoaderData } from "react-router";
import { btnStyle } from "../utils/btn";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { importASINs } from "../services/amazon-sync.server";
import { RISK_EMOJI, RISK_LABEL } from "../utils/filter-constants";
import { getScalingConfig } from "../utils/scaling-config.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });
  return { defaultMargin: settings?.defaultMargin ?? 30 };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const rawAsins = form.get("asins") || "";
  const margin = parseFloat(form.get("margin") || "30");
  const overrideBlocks = form.get("overrideBlocks") === "on";

  const asins = rawAsins
    .split(/[\n,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{10}$/.test(s));

  if (asins.length === 0) {
    return { error: "유효한 ASIN을 1개 이상 입력해주세요 (10자리 영숫자)" };
  }

  const { importBatchMaxSize } = getScalingConfig();
  if (asins.length > importBatchMaxSize) {
    return { error: `한 번에 최대 ${importBatchMaxSize}개까지 가져올 수 있습니다` };
  }

  await prisma.appSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, defaultMargin: margin },
    update: { defaultMargin: margin },
  });

  const results = await importASINs(asins, session.shop, session.accessToken, overrideBlocks);
  return { results };
};

const STATUS_CONFIG = {
  success: { bg: "#d4edda", color: "#155724", icon: "✅", label: "가져오기 성공" },
  warned:  { bg: "#fff3cd", color: "#856404", icon: "⚠️", label: "경고와 함께 등록" },
  blocked: { bg: "#f8d7da", color: "#721c24", icon: "🚫", label: "차단됨 (미등록)" },
  skipped: { bg: "#e2e3e5", color: "#383d41", icon: "⏭️", label: "이미 등록됨" },
  error:   { bg: "#f8d7da", color: "#721c24", icon: "❌", label: "오류" },
};

export default function ImportPage() {
  const { defaultMargin } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [asins, setAsins] = useState("");
  const [margin, setMargin] = useState(defaultMargin);
  const [overrideBlocks, setOverrideBlocks] = useState(false);

  const asinCount = asins
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const results = actionData?.results || [];
  const successCount = results.filter((r) => r.status === "success").length;
  const warnedCount  = results.filter((r) => r.status === "warned").length;
  const blockedCount = results.filter((r) => r.status === "blocked").length;
  const errorCount   = results.filter((r) => r.status === "error").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;

  const hasResults = results.length > 0;
  const overallTone = blockedCount > 0 || errorCount > 0 ? "warning" : "success";
  const summaryMsg = hasResults
    ? `완료: ✅${successCount} 성공 / ⚠️${warnedCount} 경고 / 🚫${blockedCount} 차단 / ❌${errorCount} 오류 / ⏭️${skippedCount} 건너뜀`
    : null;

  return (
    <s-page heading="Amazon 상품 가져오기">
      <s-section heading="ASIN 입력">
        <s-paragraph>
          ASIN을 한 줄에 하나씩 또는 쉼표로 구분하여 입력하세요. 최대 50개.
          ASIN은 Amazon 상품 URL의 <code>/dp/</code> 뒤 10자리 코드입니다.
        </s-paragraph>

        {actionData?.error && (
          <s-banner tone="critical" title={actionData.error} />
        )}
        {summaryMsg && (
          <s-banner tone={overallTone} title={summaryMsg} />
        )}
        {warnedCount > 0 && (
          <s-banner
            tone="warning"
            title={`${warnedCount}개 상품에서 저작권 위험 요소가 감지되었습니다. [Copyright Filters] 페이지에서 확인하세요.`}
          />
        )}

        <Form method="post">
          <s-stack direction="block" gap="base">
            <div>
              <label htmlFor="asins" style={{ display: "block", fontWeight: "bold", marginBottom: "6px" }}>
                ASINs ({asinCount}개 입력됨)
              </label>
              <textarea
                id="asins"
                name="asins"
                rows={10}
                value={asins}
                onChange={(e) => setAsins(e.target.value)}
                placeholder={"B08N5WRWNW\nB09G3HRMVB\nB07XJ8C8F5"}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontFamily: "monospace",
                  fontSize: "14px",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label htmlFor="margin" style={{ display: "block", fontWeight: "bold", marginBottom: "6px" }}>
                마진율 (%)
              </label>
              <s-stack direction="inline" gap="base" style={{ alignItems: "center" }}>
                <input
                  id="margin"
                  name="margin"
                  type="number"
                  min="0"
                  max="500"
                  step="0.5"
                  value={margin}
                  onChange={(e) => setMargin(e.target.value)}
                  style={{ width: "100px", padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: "4px", fontSize: "14px" }}
                />
                <span style={{ color: "#6d7175", fontSize: "13px" }}>
                  Amazon $10 + {margin}% = Shopify ${(10 * (1 + parseFloat(margin || 0) / 100)).toFixed(2)}
                </span>
              </s-stack>
            </div>

            {/* Override option */}
            <div style={{ padding: "12px 16px", background: "#fff8e1", border: "1px solid #f59e0b", borderRadius: "6px" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="overrideBlocks"
                  checked={overrideBlocks}
                  onChange={(e) => setOverrideBlocks(e.target.checked)}
                  style={{ width: "16px", height: "16px", marginTop: "2px", flexShrink: 0 }}
                />
                <span>
                  <strong>⚠️ 차단 상품 강제 등록 (Override Blocks)</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "#6d7175", marginTop: "3px" }}>
                    체크 시 저작권 필터에 차단된 상품도 "경고" 상태로 Shopify에 등록됩니다.
                    판매 권한을 반드시 확인한 후 사용하세요.
                  </span>
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              style={btnStyle("primary", { disabled: isSubmitting })}
            >
              {isSubmitting ? "⏳ 가져오는 중..." : `상품 가져오기 ${asinCount > 0 ? `(${asinCount}개)` : ""}`}
            </button>
          </s-stack>
        </Form>
      </s-section>

      {/* Results */}
      {hasResults && (
        <s-section heading="가져오기 결과">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#f6f6f7", borderBottom: "2px solid #e1e3e5" }}>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>ASIN</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>상태</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>위험도</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>제목 / 메시지</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>필터 사유</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const cfg = STATUS_CONFIG[r.status] || STATUS_CONFIG.error;
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #e1e3e5" }}>
                    <td style={{ padding: "8px 12px", fontFamily: "monospace", fontWeight: "bold" }}>
                      {r.asin}
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{
                        padding: "3px 10px", borderRadius: "12px", fontSize: "11px",
                        fontWeight: "bold", background: cfg.bg, color: cfg.color,
                      }}>
                        {cfg.icon} {cfg.label}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      {r.riskLevel && r.riskLevel !== "safe" ? (
                        <span style={{ fontSize: "13px" }}>
                          {RISK_EMOJI[r.riskLevel]} {RISK_LABEL[r.riskLevel]}
                        </span>
                      ) : r.riskLevel === "safe" ? (
                        <span style={{ color: "#155724", fontSize: "12px" }}>✅ 안전</span>
                      ) : "-"}
                    </td>
                    <td style={{ padding: "8px 12px", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.title || r.message || "-"}
                    </td>
                    <td style={{ padding: "8px 12px", fontSize: "12px", color: "#856404", maxWidth: "180px" }}>
                      {r.filterReason || "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <s-stack direction="inline" gap="base" style={{ marginTop: "16px" }}>
            {successCount + warnedCount > 0 && (
              <s-button href="/app/products" variant="primary">
                등록된 상품 보기
              </s-button>
            )}
            {blockedCount > 0 && (
              <s-button href="/app/filters?tab=blocked" variant="secondary">
                차단 상품 목록 보기
              </s-button>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="ASIN 찾는 방법">
        <s-unordered-list>
          <s-list-item>Amazon 상품 URL: amazon.com/dp/<strong>B08N5WRWNW</strong></s-list-item>
          <s-list-item>상품 페이지 하단 "제품 정보" 섹션</s-list-item>
          <s-list-item>인기 상품 페이지에서 자동 수집</s-list-item>
        </s-unordered-list>
        <s-button href="/app/popular" variant="tertiary">
          인기 상품 탐색
        </s-button>
      </s-section>

      <s-section slot="aside" heading="저작권 필터">
        <s-paragraph>
          브랜드, 카테고리, 키워드 필터가 자동으로 저작권 위험 상품을 감지합니다.
        </s-paragraph>
        <s-button href="/app/filters" variant="tertiary">
          필터 설정 관리
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
