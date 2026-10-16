import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { offlineRecoveryWorld, localOfflineRecoveryWorld, RETRY_PROMPT, SAVED_PROMPT, SAVED_REPLY } from "../worlds/offline-recovery.ts";

const test = spec.world(offlineRecoveryWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 480_000,
});

test("a member keeps completed work and explicitly continues after losing their internet connection", async ({ world, user, probe, step, evidence }) => {
  await step("before: with the feature off, the conversation keeps its existing offline behavior", async () => {
    await user.see("composer", { editable: true });
    await world.offline(true);
    await user.notSee({ text: "You’re offline" });
    const counts = await world.counts();
    expect(counts.probes).toBe(0);
    evidence.recordAssertionEvidence("The disabled feature does not probe or change the conversation", "No connectivity warning or probe with the organization switch off.", counts.probes === 0);
    await user.screenshot();
    await world.offline(false);
  });

  await step("the organization enables recovery and the member completes a report", async () => {
    await world.enable();
    await probe.eventually(() => probe.dom("[data-offline-recovery-enabled]"), {
      within: 15_000, label: "the enabled recovery switch has reached the conversation", until: (value) => value.elements.length === 1,
    });
    await user.see("composer", { editable: true });
    await user.type("composer", SAVED_PROMPT);
    await user.click("Run task");
    await user.see({ text: SAVED_REPLY }, { timeoutMs: 90_000 });
    await user.see("Run task");
  });

  await step("after: offline requests keep the draft and completed report, with one connection warning", async () => {
    const before = await world.counts();
    await world.offline(true);
    await user.see({ text: "You’re offline" });
    await user.type("composer", RETRY_PROMPT);
    await user.click("Run task");
    await user.see("composer", { text: RETRY_PROMPT });
    await user.see({ text: SAVED_REPLY });
    await user.notSee({ text: "Couldn’t reach the model provider" });
    const after = await world.counts();
    expect(after.prompts).toBe(before.prompts);
    const notices = await probe.dom('[data-testid="offline-recovery"]');
    expect(notices.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("One offline warning keeps the draft and sends no prompt", JSON.stringify({ before, after, notices: notices.elements.length }), after.prompts === before.prompts && notices.elements.length === 1);
    await user.screenshot();
  });

  await step("reconnecting checks the connection without resending the draft", async () => {
    const before = await world.counts();
    await world.offline(false);
    await user.see({ text: "Connection restored" });
    await user.see("composer", { text: RETRY_PROMPT });
    const after = await world.counts();
    expect(after.prompts).toBe(before.prompts);
    evidence.recordAssertionEvidence("Reconnection sends no prompt or external action", JSON.stringify({ before, after }), after.prompts === before.prompts);
    await user.click("Continue");
    await user.screenshot();
  });

  await step("a provider outage alone retains its normal retry behavior", async () => {
    await user.click("Run task");
    await probe.eventually(() => world.modelRequests(), { within: 60_000, label: "the provider has received a report request", until: (requests) => requests.length > 0 });
    await user.see({ text: /Retrying|retrying|Reconnecting/ }, { timeoutMs: 60_000 });
    await user.notSee({ text: "You’re offline" });
    await user.notSee({ text: "Can’t reach online services" });
    await user.screenshot();
  });

  await step("losing connectivity stops the local engine retry and preserves completed work", async () => {
    await world.offline(true);
    await user.see({ text: "You’re offline" });
    const stopped = await probe.eventually(() => world.counts(), {
      within: 15_000, label: "the local engine receives one stop request", until: (value) => value.stops === 1,
    });
    await user.see("Run task", { timeoutMs: 15_000 });
    await user.see({ text: SAVED_REPLY });
    evidence.recordAssertionEvidence("The local engine is stopped at its retry boundary", JSON.stringify(stopped), stopped.stops === 1);
    await user.screenshot();
  });

  await step("after: connection recovery offers Continue task without replaying the interrupted turn", async () => {
    const before = await world.counts();
    await world.offline(false);
    await user.see("Continue task");
    const after = await world.counts();
    expect(after.prompts).toBe(before.prompts);
    expect(after.stops).toBe(1);
    evidence.recordAssertionEvidence("The interrupted task waits for an explicit continuation", JSON.stringify({ before, after }), after.prompts === before.prompts && after.stops === 1);
    await user.screenshot();
  });
});

const localTest = spec.world(localOfflineRecoveryWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 480_000,
});

localTest("a member can still use a local model while internet services are offline", async ({ world, user, probe, step, evidence }) => {
  await step("the member enables recovery and loses internet connectivity", async () => {
    await world.enable();
    await probe.eventually(() => probe.dom("[data-offline-recovery-enabled]"), {
      within: 15_000, label: "the enabled recovery switch has reached the conversation", until: (value) => value.elements.length === 1,
    });
    await user.see("composer", { editable: true });
    await world.offline(true);
    await user.see({ text: "You’re offline" });
  });
  await step("after: the local model answers while the offline warning remains visible", async () => {
    await user.type("composer", SAVED_PROMPT);
    await user.click("Run task");
    await user.see({ text: SAVED_REPLY }, { timeoutMs: 90_000 });
    const counts = await world.counts();
    expect(counts.prompts).toBeGreaterThan(0);
    expect(counts.stops).toBe(0);
    evidence.recordAssertionEvidence("The local model completes without a stop request", JSON.stringify(counts), counts.prompts > 0 && counts.stops === 0);
    await user.screenshot();
  });
});
