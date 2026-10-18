import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotConnect } from "../worlds/workbot-connect.ts";

const test = spec.world(workbotConnect, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member connects Drive from Documents without a dashboard detour or a false success", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: Documents needs the member's account", async () => {
    await user.see({ role: "button", label: "Connect Google Drive" });
    await user.notSee({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    evidence.recordAssertionEvidence("No document appears before consent", `ready=${await world.ready()}; starts=${world.starts()}`, !await world.ready() && world.starts() === 0);
    await user.screenshot();
  });
  await step("Calendar opens consent for the same assigned account and preserves the calendar view", async () => {
    await user.navigate(`${world.url}calendar`);
    await user.see({ role: "button", label: "Connect Google Calendar" });
    await user.click({ role: "button", label: "Connect Google Calendar" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "Calendar opens provider consent", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Decline access" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    expect(await probe.url()).toContain("/calendar");
    evidence.recordAssertionEvidence("Calendar does not detour through a dashboard", `URL=${await probe.url()}; starts=${world.starts()}; token exchanges=${world.exchanges()}`, world.starts() === 1 && world.exchanges() === 0);
    await user.screenshot();
    await user.navigate(`${world.url}documents`);
  });
  await step("the member declines provider consent and stays unconnected", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "provider consent opens directly", until: value => Boolean(value) });
    await user.on(consent).see({ role: "button", label: "Approve access" });
    await user.on(consent).screenshot();
    await user.on(consent).click({ role: "button", label: "Decline access" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    expect(await probe.url()).toContain("/documents");
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("Declining never claims Connected", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 0);
    await user.screenshot();
  });
  await step("expired consent leaves an honest retry beside Documents", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "provider consent opens again", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Use expired consent" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("An expired provider code is not a connection", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 1);
    await user.screenshot();
  });
  await step("incomplete permissions do not unlock Drive", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "the member reviews provider permissions", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Grant incomplete access" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    await user.notSee({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("The real readiness read rejects the partial grant", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 2);
    await user.screenshot();
  });
  await step("after: reconnecting with full access opens the real Drive list in place", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "the member reconnects the same account", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Approve access" });
    await user.see({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    await user.notSee({ role: "button", label: "Connect Google Drive" });
    expect(await probe.url()).toContain("/documents");
    expect(await world.ready()).toBe(true);
    evidence.recordAssertionEvidence("Connected is confirmed by Den, without leaving Documents", `ready=${await world.ready()}; starts=${world.starts()}; token exchanges=${world.exchanges()}; URL=${await probe.url()}`, await world.ready() && world.starts() === 5 && world.exchanges() === 3);
    await user.screenshot();
  });
  await step("Welcome reports the same account as Connected only after the verified grant", async () => {
    await user.navigate(world.url);
    await user.see({ role: "button", label: "Get started" });
    await user.click({ role: "button", label: "Get started" });
    await user.see({ text: "You're all connected" });
    await user.see({ text: /^Connected$/ });
    evidence.recordAssertionEvidence("Welcome uses the verified connection rather than the popup result", `ready=${await world.ready()}; starts=${world.starts()}`, await world.ready() && world.starts() === 5);
    await user.screenshot();
  });
});
