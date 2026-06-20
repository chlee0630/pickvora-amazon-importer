import assert from "node:assert/strict";
import test from "node:test";

import {
  getConfiguredOrderProviderName,
  getOrderProvider,
  resolveOrderProvider,
} from "../app/services/order-providers/index.server.js";

test("ORDER_PROVIDER unset selects zinc by default", async () => {
  await withOrderProviderEnv(undefined, async () => {
    assert.equal(getConfiguredOrderProviderName(), "zinc");

    const selected = await resolveOrderProvider({}, makeSelectorDeps());
    assert.equal(selected.providerName, "zinc");
    assert.equal(selected.provider.name, "zinc");
  });
});

test("ORDER_PROVIDER=zinc selects the Zinc provider", async () => {
  await withOrderProviderEnv("zinc", async () => {
    assert.equal(getConfiguredOrderProviderName(), "zinc");

    const selected = await resolveOrderProvider({}, makeSelectorDeps());
    assert.equal(selected.providerName, "zinc");
    assert.equal(selected.provider.name, "zinc");
  });
});

test("ORDER_PROVIDER=priceyak selects the PriceYak skeleton provider", async () => {
  await withOrderProviderEnv("priceyak", async () => {
    assert.equal(getConfiguredOrderProviderName(), "priceyak");

    const selected = await resolveOrderProvider({}, makeSelectorDeps());
    assert.equal(selected.providerName, "priceyak");
    assert.equal(selected.provider.name, "priceyak");
    await assert.rejects(
      () => selected.provider.createOrder({ apiKey: "should-not-appear" }),
      (err) => (
        err.code === "PRICEYAK_NOT_IMPLEMENTED" &&
        err.provider === "priceyak" &&
        err.retryable === false &&
        err.manualReviewRequired === true &&
        !String(err.message).includes("should-not-appear")
      )
    );
  });
});

test("getOrderProvider rejects unsupported providers", () => {
  assert.throws(
    () => getOrderProvider("unknown"),
    /Unsupported order provider: unknown/
  );
});

test("ORDER_PROVIDER rejects unsupported configured providers", async () => {
  await withOrderProviderEnv("unknown", async () => {
    assert.throws(
      () => getConfiguredOrderProviderName(),
      /Unsupported order provider: unknown/
    );
    await assert.rejects(
      () => resolveOrderProvider({}, makeSelectorDeps()),
      /Unsupported order provider: unknown/
    );
  });
});

function makeSelectorDeps() {
  return {
    getProviderHealth: async (providerName) => ({
      providerName,
      status: "ACTIVE",
      disabledReason: null,
    }),
    logProviderEvent: () => {},
  };
}

async function withOrderProviderEnv(value, callback) {
  const original = process.env.ORDER_PROVIDER;
  if (value === undefined) {
    delete process.env.ORDER_PROVIDER;
  } else {
    process.env.ORDER_PROVIDER = value;
  }

  try {
    await callback();
  } finally {
    if (original === undefined) {
      delete process.env.ORDER_PROVIDER;
    } else {
      process.env.ORDER_PROVIDER = original;
    }
  }
}
