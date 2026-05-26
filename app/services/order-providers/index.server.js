import { createZincProvider } from "./zinc.server.js";
import { getProviderHealth } from "./provider-health.server.js";
import { logProviderEvent } from "../../utils/provider-errors.server.js";

const providers = {
  zinc: createZincProvider,
};

const PRIMARY_PROVIDER = "zinc";

export function getOrderProvider(providerName = "zinc") {
  const createProvider = providers[providerName];
  if (!createProvider) throw new Error(`Unsupported order provider: ${providerName}`);
  return createProvider();
}

export function listOrderProviderNames() {
  return Object.keys(providers);
}

export async function resolveOrderProvider({ preferredProvider = PRIMARY_PROVIDER } = {}) {
  const providerNames = uniqueProviderNames([preferredProvider, PRIMARY_PROVIDER, ...listOrderProviderNames()]);
  const unavailable = [];

  for (const providerName of providerNames) {
    if (!providers[providerName]) {
      unavailable.push({ providerName, status: "UNSUPPORTED", reason: "Provider is not registered" });
      continue;
    }

    const health = await getProviderHealth(providerName);
    if (health.status === "DISABLED") {
      unavailable.push({ providerName, status: health.status, reason: health.disabledReason });
      logProviderEvent("provider_disabled", {
        provider: providerName,
        status: health.status,
        disabledReason: health.disabledReason,
      });
      continue;
    }

    logProviderEvent("provider_selected", {
      provider: providerName,
      status: health.status,
      preferredProvider,
    });

    return {
      providerName,
      provider: getOrderProvider(providerName),
      health,
      failoverAttempted: providerName !== preferredProvider,
      unavailable,
    };
  }

  logProviderEvent("provider_unavailable", {
    preferredProvider,
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
