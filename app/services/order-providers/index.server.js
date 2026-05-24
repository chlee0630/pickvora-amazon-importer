import { createZincProvider } from "./zinc.server.js";

const providers = {
  zinc: createZincProvider,
};

export function getOrderProvider(providerName = "zinc") {
  const createProvider = providers[providerName];
  if (!createProvider) throw new Error(`Unsupported order provider: ${providerName}`);
  return createProvider();
}
