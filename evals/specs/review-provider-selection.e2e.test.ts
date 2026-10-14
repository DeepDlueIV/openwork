import { expect } from "vitest";
import { spec, type Target } from "@openwork/testkit";
import { reviewBothProviders, reviewDaytonaOnly, reviewNoProviders } from "../worlds/review-provider-selection.ts";

const both = spec.world(reviewBothProviders, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local", commands: ["openssl"] } });
const daytona = spec.world(reviewDaytonaOnly, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local", commands: ["openssl"] } });
const none = spec.world(reviewNoProviders, { resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local", commands: ["openssl"] } });
const providerPicker: Target = { role: "combobox", label: "Sandbox provider" };

both("a reviewer chooses configured Daytona without a Cloud lookup and keeps existing access when new launches become unavailable", async ({ world, user, probe, step, evidence }) => {
  await step("before: both configured providers are available without Cloud authority", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see({ role: "button", text: "Launch in Freestyle" });
    await user.see(providerPicker);
    expect((await probe.dom('select[aria-label="Sandbox provider"] option')).elements.map((element) => element.text)).toEqual(["Freestyle", "Daytona"]);
    expect(world.requests).toHaveLength(0);
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("Provider configuration is server-derived and no sandbox or Cloud request occurs on page load", "The self-hosted review fixture offers both configured providers while its Cloud authority deliberately returns 503. Zero launch, Cloud-feature, or provider VM calls occurred.", world.providerCalls.length === 0);
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
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("The chosen provider is explicit and launch needs no Cloud rollout", "Trusted UI selection sent exactly provider=daytona/world=app-web. A synthetic signed Daytona response produced Open sandbox; the unavailable Cloud-feature endpoint was never read. This is a provider-boundary UI proof, not live VM provisioning.", true);
    await user.screenshot();
  });
  await step("provider unavailability refuses new launches but preserves the existing link", async () => {
    world.respond("unavailable");
    await user.click({ role: "button", text: "Launch another" });
    await user.see({ text: "Daytona launches are unavailable. Reload to check access, or ask the review app owner to check provider configuration." });
    await user.see({ role: "link", text: "Open sandbox" });
    expect(world.providerCalls).toHaveLength(0);
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("Unavailable launch does not clear already-issued access or imply a Cloud policy", "The local provider boundary returned 503. The UI retained the existing link, displayed an actionable provider-configuration error, and issued no provider VM or Cloud-feature request. Real credential-removal enforcement is covered by the launch unit regression.", true);
    await user.screenshot();
  });
  await step("unavailable preparation stops provider-pinned polling without a false running state", async () => {
    world.respond("building");
    await user.click({ role: "button", text: "Launch another" });
    await user.see({ text: /^Building OpenWork web for this commit/ });
    await probe.eventually(() => world.polls.length, { within: 5000, label: "Daytona build poll observed", until: (count) => count > 0 });
    world.respond("unavailable");
    await user.see({ text: "Daytona launches are unavailable. Reload to check access, or ask the review app owner to check provider configuration." });
    expect(world.polls.every((provider) => provider === "daytona")).toBe(true);
    expect((await probe.dom('section[aria-label="Sandbox build progress"]')).elements).toHaveLength(0);
    await user.see({ role: "link", text: "Open sandbox" });
    expect(world.providerCalls).toHaveLength(0);
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("Unavailable preparation does not fail over or leave a misleading build spinner", "Every readiness request named Daytona; the local boundary rejected the next poll with 503. Progress disappeared, existing access remained, and no provider VM or Cloud-feature call occurred.", true);
    await user.screenshot();
  });
});

daytona("a reviewer with only Daytona configured needs neither Freestyle nor a Cloud authority", async ({ world, user, probe, step, evidence }) => {
  await step("before: Daytona-only server configuration makes the implemented world available", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see(providerPicker, { value: "daytona" });
    await user.see({ role: "button", text: "Launch in Daytona" });
    await user.notSee({ role: "button", text: "Launch in Freestyle" });
    expect((await probe.dom('select[aria-label="Preview world"] option:disabled')).elements).toHaveLength(3);
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("Only supported configured infrastructure is available", "Daytona is selected without a Freestyle key or working Cloud authority; unsupported desktop/ACME worlds remain disabled. No provider VM calls occurred.", world.providerCalls.length === 0);
    await user.screenshot();
  });
  await step("a provider failure remains actionable without exposing a false access link", async () => {
    world.respond("failure");
    await user.click({ role: "button", text: "Launch in Daytona" });
    await user.see({ text: "The sandbox could not launch. Try again." });
    await user.notSee({ role: "link", text: "Open sandbox" });
    expect(world.requests).toEqual([{ world: "app-web", provider: "daytona" }]);
    evidence.recordAssertionEvidence("Failed launch has no false access link or success verdict", "The local provider-boundary response was 502; the report preserved its evidence and offered a Daytona retry without a sandbox link.", true);
    await user.screenshot();
  });
  await step("reloading still offers configured Daytona while Cloud authority is unavailable", async () => {
    await user.reload();
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see(providerPicker, { value: "daytona" });
    await user.see({ role: "button", text: "Launch in Daytona" });
    expect((await probe.dom("button.primary:disabled")).elements).toHaveLength(0);
    expect(world.providerCalls).toHaveLength(0);
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("Hosted reviewer infrastructure does not depend on product rollout state", "The cloud-deployment fixture reloads with Daytona available even though its configured Cloud-authority tripwire returns 503. No feature lookup or provider VM call occurred; availability does not claim a live sandbox is already running.", true);
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
    expect(world.cloudRequests).toHaveLength(0);
    evidence.recordAssertionEvidence("Missing server credentials remain a setup state, not a working launch", "Both providers are unconfigured; launch is disabled and no provider call, launch request or Cloud-feature request was made.", world.providerCalls.length === 0);
    await user.screenshot();
  });
});
