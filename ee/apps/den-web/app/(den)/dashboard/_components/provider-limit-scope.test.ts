import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProviderLimitLabel, providerLimitLabel } from "./provider-limit-scope";

test("the enabled default scope names the exclusion instead of claiming all providers", () => {
  assert.equal(providerLimitLabel(null, [], true), "Providers without their own limit");
  assert.equal(providerLimitLabel(undefined, undefined, true), defaultProviderLimitLabel);
});

test("turning provider limits off makes the default apply to all providers, even with retained provider policies", () => {
  const retained = [{ id: "saved", name: "Existing provider" }];
  assert.equal(providerLimitLabel(null, retained, false), "All providers");
  assert.equal(providerLimitLabel("saved", retained, false), "Existing provider");
});

test("an unavailable lookup preserves a saved scope without claiming it was removed", () => {
  assert.equal(providerLimitLabel("saved", undefined, true), "Saved provider (unverified)");
});

test("absence from the manageable list does not prove deletion", () => {
  assert.equal(providerLimitLabel("saved", [], true), "Provider not in current list");
});

test("a known saved provider retains its name", () => {
  assert.equal(providerLimitLabel("saved", [{ id: "saved", name: "Existing provider" }], true), "Existing provider");
});
