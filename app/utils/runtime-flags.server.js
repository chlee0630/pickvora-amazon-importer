export function isProductionRuntime() {
  return process.env.NODE_ENV === "production" ||
    String(process.env.SHOPIFY_APP_ENV || "").toLowerCase() === "production";
}

export function isTestTrackingInjectionEnabled() {
  return process.env.ZINC_TEST_TRACKING_INJECTION_ENABLED === "true" && !isProductionRuntime();
}

export function canUseTestTrackingInjectionForShop(shop) {
  if (!isTestTrackingInjectionEnabled()) return false;
  if (!shop) return false;
  const protectedShop = String(process.env.SHOP_CUSTOM_DOMAIN || "").trim().toLowerCase();
  if (protectedShop && String(shop).trim().toLowerCase() === protectedShop) return false;
  return true;
}
