import { expect } from "vitest";
import { routinePluginChanges } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { reauthPopup } from "../worlds/reauth-popup.ts";

const test = spec.world(reauthPopup, { timeout: 900_000 });

test("workspace SSO verifies through a real popup and safely recovers from interrupted sign-in", async ({ world, user, probe, step }) => {
  await step("validate and enable the real OIDC connection", async () => {
    await user.navigate(world.testUrl);
    await user.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Approve sign-in" });
    await user.see({ text: /authentication test finished/i }, { timeoutMs: 90_000 });
    await world.enable();
  });
  await user.navigate(new URL("/dashboard/org-settings", world.den.ref.webUrl).toString());
  await user.see({ role: "button", label: "Save settings" }, { timeoutMs: 90_000 });
  await world.ageSession();
  const changedName = `${world.originalName} updated`;
  await user.type({ role: "textbox", label: /^Name$/ }, changedName, { replace: true });
  await user.click({ role: "button", label: "Save settings" });
  await user.see({ role: "button", label: "Continue with SSO" });
  expect(await world.storedName()).toBe(world.originalName);
  const waiting = async () => {
    await user.see({ text: "Complete sign-in in the other window" });
    await user.notSee({ role: "button", label: "Continue with SSO" });
    await user.notSee({ role: "button", label: "Continue with Google" });
    const popup = await probe.eventually(() => world.popup(), { within: 60_000, label: "real identity-provider popup", until: (value) => value !== null });
    if (!popup) throw new Error("Expected SSO popup");
    await user.on(popup).see({ role: "button", label: "Approve sign-in" });
    expect(await world.popupCount()).toBe(1);
    return popup;
  };
  await step("blocked and closed windows preserve the pending change", async () => {
    await world.blockPopups(true);
    await user.click({ role: "button", label: "Continue with SSO" });
    await user.see({ text: /Allow popups for OpenWork/ });
    expect(await world.popupCount()).toBe(0);
    await world.blockPopups(false);
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await user.click({ role: "button", label: "Reopen sign-in" });
    expect(await world.popupCount()).toBe(1);
    await world.closePopup(popup);
    await user.see({ text: /closed before confirmation/ });
    await user.see({ role: "button", label: "Continue with SSO" });
    expect(await world.storedName()).toBe(world.originalName);
  });
  await step("provider denial and unrelated messages do not apply the mutation", async () => {
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await world.sendCompletion("wrong-nonce");
    await world.sendCompletion("foreign-origin");
    await user.see({ text: "Complete sign-in in the other window" });
    expect(await world.storedName()).toBe(world.originalName);
    await user.on(popup).click({ role: "button", label: "Deny sign-in" });
    await user.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 60_000 });
    expect(await world.storedName()).toBe(world.originalName);
    popup.client.close();
  });
  await step("a completion signal without fresh authentication cannot save settings", async () => {
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await world.sendCompletion("stale");
    await user.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 30_000 });
    expect(await world.storedName()).toBe(world.originalName);
    expect(await world.popupCount()).toBe(0);
    popup.client.close();
  });
  await step("Cancel closes the real popup and does not retry", async () => {
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await world.holdLateCompletion();
    await user.click({ role: "button", label: "Cancel" });
    await world.sendLateCompletion();
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    await probe.eventually(() => world.popupCount(), { within: 10_000, label: "cancel closes popup", until: (count) => count === 0 });
    expect(await world.storedName()).toBe(world.originalName);
    popup.client.close();
  });
  await step("a different SSO identity cannot approve the original user’s change", async () => {
    await user.click({ role: "button", label: "Save settings" });
    await user.see({ role: "button", label: "Continue with SSO" });
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await user.on(popup).type({ role: "textbox", label: "Email" }, world.otherEmail, { replace: true });
    await user.on(popup).click({ role: "button", label: "Approve sign-in" });
    await user.see({ text: `Sign in as ${world.den.admin.email} to confirm this change.` }, { timeoutMs: 60_000 });
    expect(await world.storedName()).toBe(world.originalName);
    popup.client.close();
  });
  await step("successful SSO resumes and persists the pending settings change", async () => {
    await user.see({ role: "button", label: "Continue with SSO" });
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await user.screenshot();
    await user.on(popup).screenshot();
    await user.on(popup).click({ role: "button", label: "Approve sign-in" });
    await user.see({ text: "Workspace settings updated." }, { timeoutMs: 60_000 });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    expect(await world.storedName()).toBe(changedName);
    await probe.eventually(() => world.popupCount(), { within: 10_000, label: "successful popup closes", until: (count) => count === 0 });
    await user.reload();
    await user.see({ role: "textbox", label: /^Name$/ }, { value: changedName, timeoutMs: 60_000 });
    await user.screenshot();
    popup.client.close();
  });

  const editUrl = new URL(`/dashboard/plugins/${world.pluginId}/skills/${world.skillId}/edit`, world.den.ref.webUrl).toString();
  const skillBody = { role: "textbox", label: /Skill body/ } as const;
  await step("routine plugin work on shared plugins never asks for verification", async () => {
    await world.ageSession(180);
    const changes = await routinePluginChanges(world.den.admin, world.organizationId, world.pluginId);
    expect(changes.map(({ label, status }) => ({ label, status }))).toEqual([{ label: "rename", status: 200 }, { label: "grant", status: 201 }, { label: "mcp", status: 201 }]);
    for (const change of changes) expect(change.text).not.toContain("fresh_auth_required");

    await user.navigate(editUrl);
    await user.see({ text: "Edit shared-editing" }, { timeoutMs: 60_000 });
    await user.type(skillBody, "Saved without another prompt.", { replace: true });
    await user.click("Save changes");
    await user.see({ text: "Complete skill body" }, { timeoutMs: 30_000 });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    const stored = await world.skillSnapshot();
    expect(stored.source).toContain("Saved without another prompt.");
    expect(stored.versions).toBe(2);
    await user.screenshot();
  });

  const joinUrl = await world.invite(world.inviteeEmail, "admin");
  const signInThroughIdp = async (email: string) => {
    const person = user.on(await world.freshBrowser(joinUrl));
    await person.see({ role: "button", label: "Sign in with SSO" }, { timeoutMs: 90_000 });
    await person.notSee({ role: "textbox", label: "Password" });
    await person.click({ role: "button", label: "Sign in with SSO" });
    await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
    await person.type({ role: "textbox", label: "Email" }, email, { replace: true });
    await person.click({ role: "button", label: "Approve sign-in" });
    return person;
  };
  await step("a different identity at the provider cannot claim someone else's SSO invitation", async () => {
    const person = await signInThroughIdp(world.otherEmail);
    await person.see({ text: "Switch accounts to continue." }, { timeoutMs: 90_000 });
    await person.notSee({ role: "button", label: /^Join / });
    expect(await world.membership(world.inviteeEmail)).toEqual({ roles: [], pending: 1 });
    expect((await world.membership(world.otherEmail)).roles).not.toContain("admin");
  });
  await step("the invited identity signs in through the provider and joins once with the invited role, without an emailed code", async () => {
    const person = await signInThroughIdp(world.inviteeEmail);
    await person.notSee({ role: "textbox", label: "Verification code" });
    await probe.eventually(() => world.membership(world.inviteeEmail), { within: 90_000, label: "SSO invitee joins", until: (value) => value.roles.length === 1 });
    expect(await world.membership(world.inviteeEmail)).toEqual({ roles: ["admin"], pending: 0 });
  });
});
