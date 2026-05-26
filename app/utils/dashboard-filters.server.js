const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const ALLOWED_ORDER_STATUSES = new Set(["pending", "processing", "complete", "failed"]);
const ALLOWED_QUEUE_STATUSES = new Set(["pending", "processing", "complete", "failed"]);
const ALLOWED_FAILURE_CATEGORIES = new Set(["retryable", "permanent"]);

export function parseDashboardFilters(request) {
  const url = new URL(request.url);
  const page = clampPositiveInteger(url.searchParams.get("page"), 1);
  const pageSize = Math.min(clampPositiveInteger(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const dateRange = parseDateRange(url.searchParams.get("from"), url.searchParams.get("to"));

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    orderStatus: allowedValue(url.searchParams.get("orderStatus"), ALLOWED_ORDER_STATUSES),
    queueStatus: allowedValue(url.searchParams.get("queueStatus"), ALLOWED_QUEUE_STATUSES),
    failureCategory: allowedValue(url.searchParams.get("failureCategory"), ALLOWED_FAILURE_CATEGORIES),
    from: dateRange.from,
    to: dateRange.to,
  };
}

export function buildDateWhere(filters, field = "createdAt") {
  if (!filters.from && !filters.to) return {};
  return {
    [field]: {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    },
  };
}

export function redactDashboardText(value) {
  if (!value) return "";
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .slice(0, 240);
}

function parseDateRange(fromValue, toValue) {
  const from = parseDate(fromValue);
  const to = parseDate(toValue);

  if (from && to && from > to) {
    return { from: null, to: null };
  }

  return { from, to };
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function allowedValue(value, allowed) {
  return allowed.has(value) ? value : "";
}

function clampPositiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
