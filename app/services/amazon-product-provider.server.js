import { fetchProductDetails as fetchEasyParserProductDetails } from "./easyparser.server.js";
import { fetchProductDetails as fetchRainforestProductDetails } from "./rainforest.server.js";

const DEFAULT_PROVIDER = "easyparser";

export function getAmazonProductProviderName(env = process.env) {
  const provider = String(env.AMAZON_PRODUCT_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  return provider === "rainforest" ? "rainforest" : DEFAULT_PROVIDER;
}

export async function fetchProductDetails(asin) {
  if (getAmazonProductProviderName() === "rainforest") {
    return fetchRainforestProductDetails(asin);
  }

  return fetchEasyParserProductDetails(asin);
}
