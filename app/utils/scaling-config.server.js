const CONFIG_DEFAULTS = {
  ORDER_WORKER_CONCURRENCY: { defaultValue: 3, min: 1, max: 10 },
  IMPORT_WORKER_CONCURRENCY: { defaultValue: 2, min: 1, max: 5 },
  TRACKING_WORKER_CONCURRENCY: { defaultValue: 2, min: 1, max: 5 },
  FULFILLMENT_WORKER_CONCURRENCY: { defaultValue: 2, min: 1, max: 5 },
  RETRY_WORKER_CONCURRENCY: { defaultValue: 1, min: 1, max: 3 },
  IMPORT_BATCH_SIZE: { defaultValue: 10, min: 1, max: 50 },
  IMPORT_BATCH_MAX_SIZE: { defaultValue: 50, min: 1, max: 50 },
  DASHBOARD_PAGE_SIZE: { defaultValue: 25, min: 1, max: 100 },
  DASHBOARD_MAX_PAGE_SIZE: { defaultValue: 100, min: 1, max: 100 },
  TRACKING_POLL_INTERVAL_MINUTES: { defaultValue: 30, min: 5, max: 24 * 60 },
  TRACKING_POLL_MAX_ATTEMPTS: { defaultValue: 24, min: 1, max: 100 },
  RAINFOREST_TIMEOUT_MS: { defaultValue: 15000, min: 1000, max: 60000 },
  RAINFOREST_MAX_RETRIES: { defaultValue: 3, min: 0, max: 5 },
  LOG_PAYLOAD_MAX_CHARS: { defaultValue: 5000, min: 500, max: 20000 },
};

export function getScalingConfig() {
  return Object.fromEntries(
    Object.entries(CONFIG_DEFAULTS).map(([name, options]) => [
      toCamelCase(name),
      readNumberEnv(name, options),
    ])
  );
}

export function readNumberEnv(name, { defaultValue, min, max }) {
  // eslint-disable-next-line no-undef
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn("Scaling config invalid number, using default:", { name, defaultValue });
    return defaultValue;
  }

  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max);
    console.warn("Scaling config clamped:", { name, value: parsed, clamped, min, max });
    return clamped;
  }

  return parsed;
}

function toCamelCase(name) {
  return name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
