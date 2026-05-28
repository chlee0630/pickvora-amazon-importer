import dotenv from "dotenv";

dotenv.config();

const DEFAULT_BASE_URL = "https://api.zinc.io/v1";
const DEFAULT_TIMEOUT_MS = 30000;

export function getZincConfig() {
  return {
    apiKey: process.env.ZINC_API_KEY || "",
    baseUrl: process.env.ZINC_API_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs: readNumberEnv("ZINC_API_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    retailer: process.env.ZINC_RETAILER || "amazon",
    maxPriceCents: readNumberEnv("ZINC_MAX_PRICE_CENTS", 0) || null,
  };
}

export function requireZincApiKey(apiKey = "") {
  if (!apiKey) {
    throw new Error("Missing required environment variable: ZINC_API_KEY");
  }
  return apiKey;
}

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
