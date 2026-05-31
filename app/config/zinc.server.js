import dotenv from "dotenv";

dotenv.config();

const DEFAULT_BASE_URL = "https://api.zinc.io/v1";
const DEFAULT_TIMEOUT_MS = 30000;

export function getZincConfig() {
  const apiKey = String(process.env.ZINC_API_KEY || "").trim();
  assertDevelopmentZincSafety(apiKey);

  return {
    apiKey,
    dryRun: isZincDryRunEnabled(),
    baseUrl: process.env.ZINC_API_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs: readNumberEnv("ZINC_API_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    retailer: process.env.ZINC_RETAILER || "amazon",
    maxPriceCents: readNumberEnv("ZINC_MAX_PRICE_CENTS", 0) || null,
  };
}

export function requireZincApiKey(apiKey = "") {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) {
    throw new Error("Missing required environment variable: ZINC_API_KEY");
  }
  return trimmed;
}

export function isTestZincApiKey(apiKey = "") {
  return String(apiKey || "").startsWith("zn_test_");
}

export function isZincDryRunEnabled() {
  return process.env.ZINC_DRY_RUN === "true";
}

function assertDevelopmentZincSafety(apiKey) {
  if (process.env.NODE_ENV === "production") return;
  if (!apiKey) return;
  if (isTestZincApiKey(apiKey)) return;

  const allowProdKey = process.env.ALLOW_PRODUCTION_ZINC_IN_DEV === "true";
  const message = "Refusing to use a production Zinc API key in development. Use a zn_test_ key or set ALLOW_PRODUCTION_ZINC_IN_DEV=true explicitly for local testing.";

  if (!allowProdKey) {
    throw new Error(message);
  }

  console.warn(JSON.stringify({
    event: "zinc_dev_production_key_allowed",
    layer: "zinc_config",
    message: "ALLOW_PRODUCTION_ZINC_IN_DEV=true is enabled. Development testing will use a production Zinc key.",
  }));
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
