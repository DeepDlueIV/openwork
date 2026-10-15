import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveAsAgent, archiveFromSidebar, archiveReadArchivedAt, type ArchiveTarget } from "@openwork/behaviors";
import { archiveActiveSessions } from "../worlds/session-shell.ts";
import { awayFirstPrompt, awayQueuedPrompt } from "../worlds/chat.ts";

// Archive is a v1 engine feature; the world reports Incomplete on v2.
const test = spec.world(archiveActiveSessions, { timeout: 12 * 60_000 });

const stillWorking = { text: "This session is still working" };
const archivedToast = { text: "Session archived" };
const undo = { role: "button", label: "Undo" } as const;
const stopAndArchive = { role: "button", label: "Stop and archive" } as const;
const keepOpen = { role: "button", label: "Keep session open" } as const;
const unsentDraft = "Keep this unsent draft when I cancel archiving.";

test("SESSION-ARCHIVE: a person archives a conversation, a working one only after confirming Stop, and can undo it", async ({ world, user, agent, probe, step }) => {
  const { a1, a2, b1 } = world;
  const route = (target: ArchiveTarget) => `#/workspace/${target.workspaceId}/session/${target.sessionId}`;
  const start = (target: ArchiveTarget) => `#/workspace/${target.workspaceId}/session`;
  const row = (target: ArchiveTarget) => ({ testId: `sidebar-session-${target.sessionId}` });
  const atRoute = (hash: string, label: string) => probe.eventually(() => probe.hash(), { within: 30_000, label, until: (value) => value === hash });
  const open = async (target: ArchiveTarget) => {
    await user.click(row(target));
    await atRoute(route(target), "the conversation opens");
    await user.see("composer", { editable: true });
  };
  const archivedOnServer = (target: ArchiveTarget, archived: boolean) => probe.eventually(() => archiveReadArchivedAt(probe, target), {
    within: 30_000, label: `the server reports archived=${archived}`, until: (at) => (at > 0) === archived,
  });
  const clickUndo = async () => {
    await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "the Undo toast has settled" });
    await user.click(undo);
  };
  const send = async (text: string) => {
    await user.type("composer", text, { replace: true, verify: true });
    await user.press("Enter");
    await user.see({ text });
  };
  // A cancelled queue must never reach the model later, including after the drain's observation timeout.
  const noNewModelCalls = async (count: number, label: string) => {
    const from = Date.now();
    await probe.eventually(async () => {
      expect(await world.requests()).toHaveLength(count);
      return Date.now() - from;
    }, { within: 20_000, intervalMs: 500, label, until: (elapsed) => elapsed >= 12_000 });
  };

  await step("archiving an idle conversation returns to the same workspace and takes it out of the sidebar; Undo reopens it without sending", async () => {
    await open(a2);
    await archiveFromSidebar(user, a2);
    await user.see(archivedToast);
    await user.notSee(stillWorking);
    await atRoute(start(a2), "the same workspace's start page");
    await user.notSee(row(a2), { timeoutMs: 15_000 });
    expect(await archivedOnServer(a2, true)).toBeGreaterThan(0);
    await user.see(row(a1));
    await user.see({ role: "button", label: "View" });
    await user.screenshot();
    await clickUndo();
    await user.see(row(a2), { timeoutMs: 15_000 });
    await atRoute(route(a2), "Undo reopens the conversation");
    expect(await archivedOnServer(a2, false)).toBe(0);
    expect(await world.requests()).toHaveLength(0);
  });

  await step("archiving a conversation in another workspace leaves the open one in place; View opens it read-only and Restore brings it back", async () => {
    await archiveFromSidebar(user, b1);
    await user.see(archivedToast);
    await archivedOnServer(b1, true);
    expect(await probe.hash()).toBe(route(a2));
    await user.see({ role: "button", label: /^Archived\s*1$/ });
    await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "the View toast has settled" });
    await user.click({ role: "button", label: "View" });
    await atRoute(route(b1), "View opens the archived conversation");
    await user.see({ testId: "archived-session" });
    await user.notSee("composer");
    expect(await archiveReadArchivedAt(probe, b1)).toBeGreaterThan(0);
    await user.screenshot();
    await user.click({ role: "button", label: "Restore" });
    await user.see("composer", { editable: true, timeoutMs: 30_000 });
    await archivedOnServer(b1, false);
    await user.notSee({ testId: "archived-session" });
    expect(await world.requests()).toHaveLength(0);
  });

  await step("a working conversation with a queued follow-up and a draft asks to confirm Stop; keeping it open changes nothing", async () => {
    await open(a1);
    await send(awayFirstPrompt);
    await probe.eventually(() => world.requests(), { within: 60_000, label: "the task reaches the held model", until: (requests) => requests.length === 1 });
    await send(awayQueuedPrompt);
    await user.type("composer", unsentDraft);
    await archiveFromSidebar(user, a1);
    await user.see(stillWorking);
    await user.see({ text: "Stop the current task and archive?" });
    await user.screenshot();
    await user.click(keepOpen);
    await user.notSee(stillWorking);
    await user.see(row(a1));
    await user.see({ text: awayQueuedPrompt });
    await user.see("composer", { text: unsentDraft });
    await user.see({ role: "button", label: "Stop" });
    expect(await archiveReadArchivedAt(probe, a1)).toBe(0);
    expect(await probe.hash()).toBe(route(a1));
    expect(await world.requests()).toHaveLength(1);
  });

  await step("an agent's request to archive the working conversation is refused through its own channel, without a dialog or a stop", async () => {
    const result = await archiveAsAgent(agent, a2, a1);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, id: "session.archive", code: "target_working", hint: expect.stringContaining("ask them to stop it in the app") });
    expect(result.elapsedMs).toBeLessThan(5_000);
    await user.notSee(stillWorking);
    await user.see({ role: "button", label: "Stop" });
    expect(await archiveReadArchivedAt(probe, a1)).toBe(0);
  });

  await step("when stopping fails, the conversation stays open and unarchived with a dialog that can try again", async () => {
    await archiveFromSidebar(user, a1);
    await user.see(stillWorking);
    await world.networkFault("error", a1.sessionId);
    await user.click(stopAndArchive);
    await user.see({ text: /The session has not been archived/ }, { timeoutMs: 25_000 });
    await user.see(stopAndArchive, { timeoutMs: 25_000 });
    expect(await archiveReadArchivedAt(probe, a1)).toBe(0);
    expect(await probe.hash()).toBe(route(a1));
    expect(await world.requests()).toHaveLength(1);
    await user.screenshot();
  });

  await step("Stop and archive stops the task and archives it; Undo restores the transcript without replaying the cancelled follow-up", async () => {
    await world.networkFault("none", a1.sessionId);
    await user.click(stopAndArchive);
    await user.see(archivedToast, { timeoutMs: 30_000 });
    await atRoute(start(a1), "the workspace start page after archiving");
    await user.notSee(row(a1), { timeoutMs: 15_000 });
    await archivedOnServer(a1, true);
    await clickUndo();
    await atRoute(route(a1), "Undo reopens the stopped conversation");
    await archivedOnServer(a1, false);
    await user.see({ text: awayFirstPrompt });
    await user.notSee({ text: awayQueuedPrompt });
    await user.notSee({ role: "button", label: "Stop" }, { timeoutMs: 15_000 });
    await noNewModelCalls(1, "the cancelled follow-up never reaches the model after Undo");
    await open(a2);
    await open(a1);
    await user.notSee({ text: awayQueuedPrompt });
    expect(await world.requests()).toHaveLength(1);
    await user.screenshot();
  });

  await step("a task that finishes while the dialog is open archives without restarting it", async () => {
    await open(a2);
    await send("Finish this task while the archive dialog is open.");
    await probe.eventually(() => world.requests(), { within: 60_000, label: "the task reaches the model", until: (requests) => requests.length === 2 });
    await archiveFromSidebar(user, a2);
    await user.see(stillWorking);
    await world.releaseRun();
    await user.see({ text: "Archive fixture reply." }, { timeoutMs: 60_000 });
    await user.click(stopAndArchive);
    await user.see(archivedToast, { timeoutMs: 30_000 });
    await archivedOnServer(a2, true);
    await clickUndo();
    await archivedOnServer(a2, false);
    expect(await world.requests()).toHaveLength(2);
  });
});
