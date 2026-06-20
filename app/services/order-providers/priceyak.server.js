export function createPriceYakProvider() {
  return {
    name: "priceyak",

    async createOrder() {
      throw buildPriceYakNotImplementedError("createOrder");
    },

    async getOrderStatus() {
      throw buildPriceYakNotImplementedError("getOrderStatus");
    },

    async getTracking() {
      throw buildPriceYakNotImplementedError("getTracking");
    },

    async cancelOrder() {
      throw buildPriceYakNotImplementedError("cancelOrder");
    },
  };
}

function buildPriceYakNotImplementedError(operation) {
  const error = new Error(`PriceYak order provider ${operation} is not implemented. PriceYak API documentation is required before enabling live calls.`);
  error.code = "PRICEYAK_NOT_IMPLEMENTED";
  error.provider = "priceyak";
  error.retryable = false;
  error.manualReviewRequired = true;
  return error;
}
