import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotLunaDefaultWorld } from "../worlds/workbot-luna-default.ts";

const available = spec.world(workbotLunaDefaultWorld(true), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const unavailable = spec.world(workbotLunaDefaultWorld(false), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const unverified = spec.world(workbotLunaDefaultWorld(false, false), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

available("an owner enables the explicit Luna default and keeps their saved model through a rollback", async ({ world, user, probe, step, evidence }) => {
  await step("before: Workbot leaves its default to the runner while the rollout is off", async () => {
    await user.see({ role: "combobox", label: "Default model" }, { value: "Default (Another model)" });
    await user.notSee({ testId: "workbot-default-readiness" });
    evidence.recordAssertionEvidence("The rollout starts off", "The real settings page has the old runner default and no Luna readiness row", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.length === 0);
    await user.screenshot();
  });
  await step("the owner enables the Luna rollout for this workspace", async () => {
    await user.navigate(world.featureUrl);
    await user.click({ testId: "admin-capability-workbotLunaDefault" });
    await user.see({ testId: "admin-capability-source-workbotLunaDefault" }, { text: "Set for this organization" });
    const enabled = (await probe.dom('[data-testid="admin-capability-workbotLunaDefault"][aria-checked="true"]')).elements.length === 1;
    expect(enabled).toBe(true);
    evidence.recordAssertionEvidence("The owner explicitly enables Luna", "The workspace feature switch is on", enabled);
    await user.screenshot();
  });
  await step("after: the owner sees GPT-6 Luna as the available default", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "GPT-6 Luna available" });
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "GPT-6 Luna available" });
    evidence.recordAssertionEvidence("Luna is explicit, not the runner's unrelated default", "Default: GPT-6 Luna; GPT-6 Luna available", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("the owner keeps an explicit organization model instead of Luna", async () => {
    await user.click({ role: "combobox", label: "Default model" });
    await user.click({ role: "option", label: "Another model" });
    await user.click({ role: "button", label: "Save model" });
    await user.see({ text: "Saved. New messages use Another model." });
    await user.reload();
    await user.see({ role: "combobox", label: "Default model" }, { value: "Another model" });
    evidence.recordAssertionEvidence("An explicit model survives reload", "Another model remains selected with Luna still available", (await probe.dom('[data-testid="workbot-model-picker"] input[value="Another model"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("turning off the rollout keeps the organization's saved model", async () => {
    await user.navigate(world.featureUrl);
    await user.click({ testId: "admin-capability-workbotLunaDefault" });
    await user.see({ testId: "admin-capability-source-workbotLunaDefault" }, { text: "Set for this organization" });
    await user.navigate(world.settingsUrl);
    await user.see({ role: "combobox", label: "Default model" }, { value: "Another model" });
    await user.notSee({ testId: "workbot-default-readiness" });
    evidence.recordAssertionEvidence("Rollback preserves the saved choice", "Another model remains selected; the new readiness row is absent", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.length === 0);
    await user.screenshot();
  });
});

unavailable("an owner sees unavailable Luna without a silent fallback", async ({ user, probe, step, evidence }) => {
  await step("an unavailable Luna stays named as the default", async () => {
    await user.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "GPT-6 Luna unavailable" });
    await user.see({ text: "Workbot can't use GPT-6 Luna right now." });
    evidence.recordAssertionEvidence("The default is unavailable, not replaced", "Default: GPT-6 Luna; GPT-6 Luna unavailable; existing conversations are kept", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("checking again never substitutes the runner's other model", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "GPT-6 Luna unavailable" });
    await user.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    evidence.recordAssertionEvidence("A fresh check keeps the unavailable state honest", "No model was silently selected for the owner", (await probe.dom('[data-testid="workbot-model-picker"] input[value="Default: GPT-6 Luna"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("the owner explicitly chooses an available model to recover", async () => {
    await user.click({ role: "combobox", label: "Default model" });
    await user.click({ role: "option", label: "Another model" });
    await user.click({ role: "button", label: "Save model" });
    await user.see({ text: "Saved. New messages use Another model." });
    await user.notSee({ text: "Workbot can't use GPT-6 Luna right now." });
    await user.see({ testId: "workbot-default-readiness" }, { text: "GPT-6 Luna unavailable" });
    evidence.recordAssertionEvidence("Recovery is the owner's choice", "Another model was saved explicitly; Luna remains unavailable", (await probe.dom('[data-testid="workbot-model-picker"] input[value="Another model"]')).elements.length === 1);
    await user.screenshot();
  });
});

unverified("an owner cannot mistake an unverified runner fallback for a ready default", async ({ user, probe, step, evidence }) => {
  await step("the owner sees that Luna could not be verified", async () => {
    await user.see({ testId: "workbot-default-readiness" }, { text: "Couldn't verify GPT-6 Luna" });
    await user.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    evidence.recordAssertionEvidence("A configured fallback is not readiness", "Couldn't verify GPT-6 Luna", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.some(element => element.text === "Couldn't verify GPT-6 Luna"));
    await user.screenshot();
  });
  await step("unverified models cannot be saved as if access had been checked", async () => {
    await user.see({ role: "button", label: "Save model" });
    const disabled = (await probe.dom('[data-testid="workbot-model-picker"] input[disabled]')).elements.length === 1;
    expect(disabled).toBe(true);
    evidence.recordAssertionEvidence("The picker stays blocked until models can be verified", "The default-model input is disabled", disabled);
    await user.screenshot();
  });
  await step("a new check keeps the honest state and gives the owner a recovery action", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Couldn't verify GPT-6 Luna" });
    await user.see({ text: "ask your deployment admin to check access" });
    evidence.recordAssertionEvidence("No unrelated model is selected after a failed verification", "Default: GPT-6 Luna remains selected and the deployment admin is named as the next action", (await probe.dom('[data-testid="workbot-model-picker"] input[value="Default: GPT-6 Luna"]')).elements.length === 1);
    await user.screenshot();
  });
});
