import { expect } from "vitest";
import { readTranscriptMessages, spec } from "@openwork/testkit";
import { arrangeControl, unfinishedToolsWeb } from "../worlds/chat.ts";

const test = spec.world((seed) => unfinishedToolsWeb(seed), {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("STOP-01 unfinished current-turn tools expose Stop feedback and active, waiting, and unknown outcomes", async ({ world, user, seed, probe, step, evidence }) => {
  await step("a completed turn grounds later Stop errors in the native snapshot", async () => {
    await user.type("composer", world.warmup.prompt, { replace: true, verify: true });
    await user.press("Enter");
    await user.see({ text: world.warmup.reply }, { timeoutMs: 45_000 });
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
  });

  await using stopFault = await world.startStopFault();
  await step("a real native tool makes the current run stoppable", async () => {
    await probe.eventually(() => stopFault.read(), {
      within: 30_000,
      label: "the completed fixture turn in the session snapshot",
      until: (value) => value.snapshotMessageCount > 0,
    });
    await user.type("composer", world.prompt, { replace: true, verify: true });
    await user.press("Enter");
    await probe.eventually(() => world.nativeStatus(), {
      within: 45_000,
      label: "the controlled native tool run",
      until: (value) => value === "busy" || value === "retry",
    });
    await user.see({ text: /sleep 120/ }, { timeoutMs: 45_000 });
    await user.see({ role: "button", label: "Stop" }, { timeoutMs: 45_000 });
  });

  await step("Stop immediately shows bounded pending feedback without duplicate aborts", async () => {
    await user.dblclick({ role: "button", label: "Stop" });
    await user.press("Escape");
    await user.press("Escape");
    const pending = await probe.eventually(() => stopFault.read(), {
      within: 5_000,
      intervalMs: 20,
      label: "the held native Stop response and pending feedback",
      until: (value) => value.attempts === 1 && value.held === 1 && value.elapsedMs !== null,
    });
    expect(pending).toMatchObject({
      attempts: 1,
      held: 1,
      nativeStatus: null,
      nativeFailed: false,
      clickCaptured: true,
      trusted: true,
      expired: false,
      stoppingVisible: true,
      stoppingDisabled: true,
      ariaBusy: "true",
      spinnerVisible: true,
      retryEnabled: false,
      runVisible: false,
    });
    expect(pending.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(pending.elapsedMs).toBeLessThan(100);
    evidence.recordJsonArtifact("Stop pending feedback", { engine: world.engine, ...pending });
  });

  await step("a failed Stop shows an error and restores retry without claiming completion", async () => {
    await stopFault.fail();
    const failed = await probe.eventually(() => stopFault.read(), {
      within: 5_000,
      intervalMs: 20,
      label: "failed Stop feedback and retry",
      until: (value) => value.held === 0 && value.retryEnabled && value.errorText.includes("Stop unavailable"),
    });
    expect(failed).toMatchObject({
      attempts: 1,
      held: 0,
      nativeStatus: 503,
      released: true,
      failed: true,
      stoppingVisible: false,
      retryEnabled: true,
      runVisible: false,
    });
    await user.see({ text: /Stop unavailable/ });
    expect(failed.aggregateText).not.toMatch(/\b(?:Ran command|Read brief\.md)\b/);
    const nativeStatus = await world.nativeStatus();
    expect(["busy", "retry"]).toContain(nativeStatus);
    evidence.recordJsonArtifact("Failed Stop feedback", { ...failed, nativeRunStatus: nativeStatus });
  });

  await step("retrying Stop after the failure aborts the native run", async () => {
    await user.click({ role: "button", label: "Stop" });
    await probe.eventually(() => world.nativeStatus(), {
      within: 45_000,
      label: "the aborted native tool run",
      until: (value) => value === "idle",
    });
    await user.see({ role: "button", label: "Run task" }, { timeoutMs: 15_000 });
    await user.notSee({ role: "button", label: /^Stop/ });
    const settled = await stopFault.read();
    expect(settled).toMatchObject({ attempts: 1, held: 0, released: true, stoppingVisible: false, runVisible: true });
  });

  // Synthetic lifecycle coverage starts only after native failure recovery is proven.
  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  await step("active unfinished tools remain visibly in progress", async () => {
    await user.see("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "waiting" });
  await step("a blocked unfinished step says what it needs", async () => {
    await user.see({ text: /Waiting for your action/ });
    await user.see({ text: "Choose an option or approve the request to continue." });
    await user.notSee("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "idle" });
  await step("idle unfinished tools expose an unknown terminal state", async () => {
    await user.see({ text: /Status unknown/ });
    await user.see({ text: "No terminal result was observed. This step may still be running; check the session before retrying." });
    await user.notSee({ text: /Waiting for your action/ });
    await user.notSee("Running command, reading 1 file");
  });
});

const editTest = spec.world((seed) => unfinishedToolsWeb(seed, { editRunning: true }), {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

editTest("EDIT-BUSY a person replaces a running message with an edit instead of queueing it, while a new follow-up still queues", async ({ world, user, probe, step }) => {
  const edit = world.editRunning;
  await step("before: the original message is running with part of its answer on screen", async () => {
    await user.type("composer", edit.original, { replace: true, verify: true });
    await user.click("Run task");
    await user.see({ text: edit.partial }, { timeoutMs: 45_000 });
    await user.see({ role: "button", label: "Stop" });
    await user.screenshot();
  });

  await step("editing the running message and sending it replaces that turn without queueing", async () => {
    // The context menu stays put while streamed text moves the hover toolbar.
    await user.rightClick({ text: edit.original }, { hitTest: false });
    await user.click({ role: "menuitem", label: "Edit message" });
    await user.see("composer", { text: edit.original });
    await user.type("composer", edit.edited, { replace: true, verify: true });
    await user.press("Enter");
    await user.notSee({ text: "1 queued" });
    await user.see({ text: edit.answer }, { timeoutMs: 45_000 });
    await user.see("Run task");
    await user.notSee({ text: edit.original });
    await user.notSee({ text: edit.neverReleased });
    const users = await readTranscriptMessages(probe, "user");
    expect(users.filter((text) => text.includes(edit.edited))).toHaveLength(1);
    expect(users.some((text) => text.includes(edit.original))).toBe(false);
    await user.screenshot();
  });

  await step("an ordinary follow-up typed during a running turn waits in the queue", async () => {
    await user.type("composer", edit.held, { replace: true, verify: true });
    await user.click("Run task");
    await user.see({ text: edit.heldPartial }, { timeoutMs: 45_000 });
    await user.type("composer", edit.followup, { verify: true });
    await user.press("Enter");
    await user.see({ text: "1 queued" });
    await user.see("composer", { text: "" });
    expect((await readTranscriptMessages(probe, "user")).some((text) => text.includes(edit.followup))).toBe(false);
    await user.screenshot();
    // The held answer is never released behind the UI; Stop owns it.
    await user.click({ role: "button", label: "Stop" });
  });
});
