import assert from "node:assert/strict";
import test from "node:test";

import { withEmbeddedAppContext } from "../app/utils/embedded-app-url.js";

test("withEmbeddedAppContext appends embedded app context to a plain app path", () => {
  assert.equal(
    withEmbeddedAppContext("/app/import", "?embedded=1&host=abc&shop=test.myshopify.com"),
    "/app/import?embedded=1&host=abc&shop=test.myshopify.com",
  );
});

test("withEmbeddedAppContext preserves existing path query before appending context", () => {
  assert.equal(
    withEmbeddedAppContext("/app/filters?tab=blocked", "?embedded=1&host=abc&shop=test.myshopify.com"),
    "/app/filters?tab=blocked&embedded=1&host=abc&shop=test.myshopify.com",
  );
});

test("withEmbeddedAppContext returns original path when search is empty", () => {
  assert.equal(withEmbeddedAppContext("/app/import", ""), "/app/import");
});

test("withEmbeddedAppContext keeps path query values when context has duplicate keys", () => {
  assert.equal(
    withEmbeddedAppContext("/app/products?page=2", "?embedded=1&page=1&host=abc&shop=test.myshopify.com"),
    "/app/products?page=2&embedded=1&host=abc&shop=test.myshopify.com",
  );
});
