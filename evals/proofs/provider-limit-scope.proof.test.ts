import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providerLimitScope } from "../worlds/provider-limit-scope.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(providerLimitScope, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an owner keeps a saved provider scope through slow and failed lookups and can retry the real choices", async ({ world, user, probe, step, evidence }) => {
  await step("a slow lookup retains the saved provider instead of presenting a complete default-only list", async () => {
    await user.see("Checking provider choices. The saved scope is unchanged.", { timeoutMs: 60_000 });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved provider (unverified)" });
    const disabled = await probe.dom('[data-testid="gateway-limit-provider"] input:disabled');
    expect(disabled.elements.length).toBe(1);
    evidence.recordAssertionEvidence("pending choices cannot replace the saved provider", `saved scope shown unverified; disabled provider pickers=${disabled.elements.length}`, disabled.elements.length === 1);
    await user.screenshot();
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved model provider", timeoutMs: 60_000 });
  });
  await step("a failed lookup offers retry and does not claim the provider was removed", async () => {
    await user.reload();
    await user.see("Could not verify provider choices. The saved scope is unchanged.", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Retry providers" });
    await user.see({ role: "combobox", label: "Provider" }, { value: "Saved provider (unverified)" });
    await user.notSee("Removed provider");
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
  });
});
