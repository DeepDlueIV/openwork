import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerLimitScope, providerLimitScopeOff } from "../worlds/provider-limit-scope.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(providerLimitScope, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const offTest = spec.world(providerLimitScopeOff, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

offTest("turning provider limits off restores an all-provider default without deleting retained provider policies", async ({ world, user, probe, step, evidence }) => {
  await step("the default covers all providers while the retained provider policy is marked unenforced", async () => {
    await user.see({ text: "All providers" }, { timeoutMs: 60_000 });
    await user.see({ text: "Not enforced while off" });
    await user.notSee({ text: "Providers without their own limit" });
    const label = await probe.dom(`[data-policy-id="${world.defaultPolicyId}"] [data-testid="gateway-limit-provider-label"]`);
    expect(label.elements.map((entry) => entry.text).join()).toBe("All providers");
    evidence.recordAssertionEvidence("the off-state default names its actual admission scope", `retained provider row visible; default label=${label.elements.map((entry) => entry.text).join()}`, label.elements.length === 1 && label.elements[0]?.text === "All providers");
    await user.screenshot();
  });
  await step("the default editor never suggests a provider exclusion while the rollout is off", async () => {
    await user.click({ role: "link", label: "Edit Default provider limit" });
    await user.see({ testId: "gateway-limit-editor" });
    await user.notSee({ testId: "gateway-limit-provider" });
    const org = await probe.api(world.den.admin, "/v1/org");
    const features = isRecord(org.body) && isRecord(org.body.features) ? org.body.features : null;
    expect(features?.gatewayProviderUsageLimits).toBe(false);
    evidence.recordAssertionEvidence("the disabled rollout is observed, not inferred from an empty list", `organization flag=${features?.gatewayProviderUsageLimits}; no exclusion picker in default editor`, org.response.ok && features?.gatewayProviderUsageLimits === false);
    await user.screenshot();
    await user.click({ role: "link", label: "Cancel" });
  });
  await step("the retained provider scope remains visible and locked rather than being reset to the default", async () => {
    await user.click({ role: "link", label: "Edit Saved provider limit" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
    await user.see({ testId: "gateway-limit-provider-off" });
    const disabled = await probe.dom('[data-testid="gateway-limit-provider"] input:disabled');
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const retained = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.policyId) : null;
    expect(retained?.providerId).toBe(world.providerId);
    expect(disabled.elements.length).toBe(1);
    evidence.recordAssertionEvidence("turning off enforcement does not delete saved policy scope", `retained provider=${retained?.providerId === world.providerId}; locked pickers=${disabled.elements.length}`, read.response.ok && retained?.providerId === world.providerId && disabled.elements.length === 1);
    await user.screenshot();
  });
});

test("an owner keeps a saved provider scope through slow and failed lookups and can retry the real choices", async ({ world, user, probe, step, evidence }) => {
  await step("a slow lookup retains the saved provider instead of presenting a complete default-only list", async () => {
    await user.see({ text: "Checking provider choices. The saved scope is unchanged." }, { timeoutMs: 60_000 });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved provider (unverified)" });
    const disabled = await probe.dom('[data-testid="gateway-limit-provider"] input:disabled');
    expect(disabled.elements.length).toBe(1);
    evidence.recordAssertionEvidence("pending choices cannot replace the saved provider", `saved scope shown unverified; disabled provider pickers=${disabled.elements.length}`, disabled.elements.length === 1);
    await user.screenshot();
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
  });
  await step("a failed lookup offers retry and does not claim the provider was removed", async () => {
    await user.reload();
    await user.see({ text: "Could not verify provider choices. The saved scope is unchanged." }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Retry providers" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved provider (unverified)" });
    await user.notSee({ text: "Removed provider" });
    const failed = (await world.faults.requestLog()).filter((entry) => entry.path.includes("inference-providers") && entry.status === 503);
    evidence.recordAssertionEvidence("lookup failure has an actual recovery action", `faulted provider requests=${failed.length}; retry shown; no removal claim`, failed.length === 1);
    expect(failed.length).toBe(1);
    await user.screenshot();
  });
  await step("after: retry restores choices and the default names providers without their own limit", async () => {
    await user.click({ role: "button", label: "Retry providers" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
    await user.click({ role: "combobox", label: "Provider" });
    await user.see({ role: "option", label: /Providers without their own limit/ });
    await user.notSee({ role: "option", label: /^All providers$/ });
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const saved = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.policyId) : null;
    expect(saved?.providerId).toBe(world.providerId);
    evidence.recordAssertionEvidence("recovery leaves the stored scope untouched", `saved provider scope retained=${saved?.providerId === world.providerId}; default explicitly excludes providers with their own limit`, read.response.ok && saved?.providerId === world.providerId);
    await user.screenshot();
    await user.press("Escape");
  });
  await step("saving an amount change after recovery retains the existing provider assignment", async () => {
    await user.type({ testId: "gateway-limit-amount-month" }, "25", { replace: true });
    await user.click({ testId: "gateway-limit-save" });
    await user.see({ testId: "gateway-limit-row" }, { text: /Saved provider limit/, timeoutMs: 60_000 });
    const read = await probe.api(world.den.admin, "/v1/gateway/usage-limit-policies");
    const saved = isRecord(read.body) ? records(read.body.policies).find((entry) => entry.id === world.policyId) : null;
    const limit = records(saved?.limits).find((entry) => entry.timeframe === "month");
    expect(saved?.providerId).toBe(world.providerId);
    expect(String(limit?.costLimitMicroUsd)).toBe("25000000");
    evidence.recordAssertionEvidence("an unrelated edit cannot silently reset provider scope", `stored provider preserved=${saved?.providerId === world.providerId}; monthly amount=${String(limit?.costLimitMicroUsd)} microUSD`, read.response.ok && saved?.providerId === world.providerId && String(limit?.costLimitMicroUsd) === "25000000");
    await user.screenshot();
  });
});
