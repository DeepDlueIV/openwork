import { expect } from "vitest";
import { spec, type Target } from "@openwork/testkit";
import { reviewBothProviders, reviewDaytonaOnly, reviewNoProviders } from "../worlds/review-provider-selection.ts";

const both = spec.world(reviewBothProviders, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local", commands: ["openssl"] } });
const daytona = spec.world(reviewDaytonaOnly, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local", commands: ["openssl"] } });
const none = spec.world(reviewNoProviders, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local", commands: ["openssl"] } });
const providerPicker: Target = { role: "combobox", label: "Sandbox provider" };

both("a reviewer chooses Daytona without losing their existing preview when new launches are killed", async ({ world, user, probe, step, evidence }) => {
  await step("before: both configured providers are available and launching is separate from verification", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see({ role: "button", text: "Launch in Freestyle" });
    await user.see(providerPicker);
    expect((await probe.dom('select[aria-label="Sandbox provider"] option')).elements.map((element) => element.text)).toEqual(["Freestyle", "Daytona"]);
    expect(world.requests).toHaveLength(0);
    evidence.recordAssertionEvidence("Provider configuration is server-derived and no sandbox launches on page load", "The protected report offers Freestyle and Daytona; zero launch requests and zero provider VM calls. These local witnesses never provision resources.", world.providerCalls.length === 0);
    await user.screenshot();
  });
  await step("the reviewer selects Daytona and receives only its launched sandbox", async () => {
    await user.click(providerPicker); await user.press("Escape"); await user.press("d"); await user.press("Tab");
    await user.see(providerPicker, { value: "daytona" });
    await user.see({ role: "button", text: "Launch in Daytona" });
    await user.click({ role: "button", text: "Launch in Daytona" });
    await user.see({ role: "link", text: "Open sandbox" });
    expect(world.requests).toEqual([{ world: "app-web", provider: "daytona" }]);
    expect((await probe.dom('a.preview-open')).elements.map((element) => element.text)).toEqual(["Open sandbox"]);
    evidence.recordAssertionEvidence("The selected provider is included in the launch and the returned identity remains visible", "Trusted UI selection sent exactly provider=daytona/world=app-web; a synthetic signed Daytona response produced Open sandbox, not a test-run verdict.", true);
    await user.screenshot();
  });
  await step("after a rollout kill the server refuses new spend but the existing link survives", async () => {
    world.enable(false); world.respond("real");
    await user.click({ role: "button", text: "Launch another" });
    await user.see({ text: "Daytona launches are unavailable. Reload to check access, or ask the review app owner to check configuration and rollout." });
    await user.see({ role: "link", text: "Open sandbox" });
    expect(world.providerCalls).toHaveLength(0);
    evidence.recordAssertionEvidence("A stale enabled page cannot bypass the current kill switch", "The real production POST re-read the local no-store feature authority and returned unavailable before any provider API call; the previously issued link was preserved.", true);
    await user.screenshot();
  });
});

daytona("a reviewer with only Daytona configured sees truthful launch, failure and unavailable states", async ({ world, user, probe, step, evidence }) => {
  await step("before: Daytona-only configuration needs no Freestyle credential", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see(providerPicker, { value: "daytona" });
    await user.see({ role: "button", text: "Launch in Daytona" });
    await user.notSee({ role: "button", text: "Launch in Freestyle" });
    expect((await probe.dom('select[aria-label="Preview world"] option:disabled')).elements).toHaveLength(3);
    evidence.recordAssertionEvidence("Only the implemented fresh Daytona world can be selected", "Daytona is selected with no Freestyle key; unsupported desktop/ACME choices remain present but disabled. No provider API calls occurred.", world.providerCalls.length === 0);
    await user.screenshot();
  });
  await step("a provider failure stays on the report with an actionable retry", async () => {
    world.respond("failure");
    await user.click({ role: "button", text: "Launch in Daytona" });
    await user.see({ text: "The sandbox could not launch. Try again." });
    await user.notSee({ role: "link", text: "Open sandbox" });
    expect(world.requests).toEqual([{ world: "app-web", provider: "daytona" }]);
    evidence.recordAssertionEvidence("Failed launch has no false access link or success verdict", "The local provider-boundary response was 502; the report preserved its evidence and offered a Daytona retry without a sandbox link.", true);
    await user.screenshot();
  });
  await step("an unreachable rollout authority disables new launches instead of reusing stale permission", async () => {
    world.unavailable(true);
    await user.reload();
    await user.click({ role: "button", text: "Show sandbox" });
    await user.click(providerPicker); await user.press("Escape"); await user.press("d"); await user.press("Tab");
    await user.see({ text: "Daytona preview availability could not be verified. Try again or contact the review app owner." });
    expect((await probe.dom("button.primary:disabled")).elements).toHaveLength(1);
    expect(world.providerCalls).toHaveLength(0);
    evidence.recordAssertionEvidence("Feature-authority failure is fail-closed and does not spend provider quota", "Reloaded production UI shows an unavailable reason and a disabled launch button; zero provider API calls.", true);
    await user.screenshot();
  });
});

none("a reviewer with no configured provider gets setup direction rather than a working-looking launch", async ({ world, user, probe, step, evidence }) => {
  await step("neither provider is connected and launch is visibly blocked", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see({ text: "Freestyle is not connected. The review app owner can connect it." });
    expect((await probe.dom("button.primary:disabled")).elements).toHaveLength(1);
    await user.notSee({ role: "link", text: "Open sandbox" });
    expect(world.requests).toHaveLength(0);
    evidence.recordAssertionEvidence("Missing credentials are setup state, not a claim that a VM can run", "Both providers are unconfigured, the launch button is disabled, and no provider call or launch request was made.", world.providerCalls.length === 0);
    await user.screenshot();
  });
});
