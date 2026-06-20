import { createZincProvider } from "./zinc.server.js";
import { createPriceYakProvider } from "./priceyak.server.js";
import { getProviderHealth } from "./provider-health.server.js";
import { logProviderEvent } from "../../utils/provider-errors.server.js";

const providers = {
  priceyak: createPriceYakProvider,
  zinc: createZincProvider,
};

const DEFAULT_ORDER_PROVIDER = "zinc";
const ORDER_PROVIDER_ENV = "ORDER_PROVIDER";

export function getOrderProvider(providerName = DEFAULT_ORDER_PROVIDER) {
  const normalizedProviderName = normalizeProviderName(providerName) || DEFAULT_ORDER_PROVIDER;
  const createProvider = providers[normalizedProviderName];
  if (!createProvider) throw new Error(`Unsupported order provider: ${normalizedProviderName}`);
  return createProvider();
}

export function listOrderProviderNames() {
  return Object.keys(providers);
}

export function getConfiguredOrderProviderName(env = process.env) {
  const providerName = normalizeProviderName(env?.[ORDER_PROVIDER_ENV]) || DEFAULT_ORDER_PROVIDER;
  assertSupportedProvider(providerName);
  return providerName;
}

export async function resolveOrderProvider({ preferredProvider } = {}, deps = {}) {
  const getProviderHealthFn = deps.getProviderHealth || getProviderHealth;
  const logProviderEventFn = deps.logProviderEvent || logProviderEvent;
  const primaryProvider = getConfiguredOrderProviderName(deps.env || process.env);
  const requestedProvider = normalizeProviderName(preferredProvider) || primaryProvider;
  assertSupportedProvider(requestedProvider);

  const providerNames = uniqueProviderNames([requestedProvider, primaryProvider, DEFAULT_ORDER_PROVIDER]);
  const unavailable = [];

  for (const providerName of providerNames) {
    const health = await getProviderHealthFn(providerName);
    if (health.status === "DISABLED") {
      unavailable.push({ providerName, status: health.status, reason: health.disabledReason });
      logProviderEventFn("provider_disabled", {
        provider: providerName,
        status: health.status,
        disabledReason: health.disabledReason,
      });
      continue;
    }

    logProviderEventFn("provider_selected", {
      provider: providerName,
      status: health.status,
      preferredProvider: requestedProvider,
    });

    return {
      providerName,
      provider: getOrderProvider(providerName),
      health,
      failoverAttempted: providerName !== preferredProvider,
      unavailable,
    };
  }

  logProviderEventFn("provider_unavailable", {
    preferredProvider: requestedProvider,
    unavailable,
  });

  return {
    providerName: null,
    provider: null,
    health: null,
    failoverAttempted: false,
    unavailable,
  };
}

function uniqueProviderNames(names) {
  return names.filter((name, index) => name && names.indexOf(name) === index);
}

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function assertSupportedProvider(providerName) {
  if (!providers[providerName]) {
    throw new Error(`Unsupported order provider: ${providerName}`);
  }
}
