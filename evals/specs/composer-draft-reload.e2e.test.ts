import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { failedSendDraft } from "../worlds/session-draft.ts";
import { emptySession } from "../worlds/desktop.ts";

const test = spec.world(emptySession, { resources: { surfaces: ["appWeb"], services: [] } });

test("reloading a session with a persisted composer draft keeps the renderer stable", async ({ user, probe, step }) => {
  const draft = "Keep this persisted draft through reload";
  await user.type("composer", draft);
  const revision = await probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("nextRevision" in value)) return undefined;
    return value.nextRevision;
  });
  await step("draft survives three reloads", async () => {
    for (let reload = 1; reload <= 3; reload += 1) {
      await user.reload();
      await user.see("composer", { editable: true, text: draft });
    }
  });
  expect(await probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("nextRevision" in value)) return undefined;
    return value.nextRevision;
  })).toBe(revision);
});

const failureTest = spec.world(failedSendDraft, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  timeout: 240_000,
});

failureTest("a failed send and a newer draft both survive reload without an automatic resend", async ({ world, user, agent, probe, step, evidence }) => {
  const submitted = "Keep this failed message until I choose to resend it.";
  const newer = "Keep this newer draft separate.";
  await user.type("composer", submitted);
  await user.press("Enter");
  await probe.eventually(world.submissionAttempts, {
    within: 15_000, label: "the first send is held before acceptance", until: (count) => count === 1,
  });
  await step("before: a newer draft is typed while the submitted message is still waiting", async () => {
    await user.type("composer", newer);
    await user.see("composer", { editable: true, text: newer });
    await user.screenshot();
  });
  await world.rejectSubmission();
  await user.see({ text: "Couldn’t confirm your message was received" });
  await user.click({ role: "button", label: "Check status" });
  await user.see({ text: "Your unsent message is saved. Clear the current draft to restore it." });
  await user.see("composer", { text: newer });
  const stored = () => probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("drafts" in value)
      || typeof value.drafts !== "object" || value.drafts === null) return [];
    return Object.values(value.drafts);
  });
  expect(await stored()).toContainEqual(expect.objectContaining({ text: newer, failed: [submitted] }));
  await step("after: reload keeps the newer draft and offers the failed message separately", async () => {
    await user.reload();
    await user.see("composer", { editable: true, text: newer });
    await user.see({ text: "Your unsent message is saved. Clear the current draft to restore it." });
    const transcript = await agent.run("session.read_transcript", { count: 30 });
    expect(JSON.stringify(transcript)).not.toContain(submitted);
    expect(JSON.stringify(transcript)).not.toContain(newer);
    evidence.recordAssertionEvidence("Reload preserves both texts without sending either",
      "The newer draft remains in the editor, the failed message remains in scoped draft storage, and neither is in the engine transcript.", true);
    await user.screenshot();
  });
  await step("another conversation does not offer this conversation's failed message", async () => {
    await agent.run("session.open", { sessionId: world.neighbor.sessionId });
    await user.see("composer", { text: "" });
    await user.notSee({ text: "Your unsent message is saved. Clear the current draft to restore it." });
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see("composer", { text: newer });
  });
  await step("restore consumes the saved message once and leaves it unsent across another reload", async () => {
    await user.type("composer", "", { replace: true });
    await user.click({ role: "button", label: "Restore unsent message" });
    await user.see("composer", { text: submitted });
    await user.notSee({ text: "Your unsent message is saved. Clear the current draft to restore it." });
    await user.reload();
    await user.see("composer", { text: submitted });
    await user.notSee({ text: "Your unsent message is saved. Clear the current draft to restore it." });
    expect(JSON.stringify(await agent.run("session.read_transcript", { count: 30 }))).not.toContain(submitted);
    expect(await stored()).toContainEqual(expect.objectContaining({ text: submitted, failed: [] }));
    await user.screenshot();
  });
});
