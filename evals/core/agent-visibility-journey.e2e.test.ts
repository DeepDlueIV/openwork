import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { chatReadWorkingScreen, chatWorkingSeconds, type ChatWorkingScreen } from "@openwork/behaviors";
import { agentVisibility } from "../worlds/agent-visibility.ts";

const test = spec.world((seed) => agentVisibility(seed), {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

type Sample = ChatWorkingScreen & { at: number };

test(`AGENT-VIS-01 ${resolveEvalEngine()}: a person asks a research question and can always tell the agent is still working`, async ({ world, user, probe, step, evidence }) => {
  const samples: Sample[] = [];

  await step("the person asks why nobody can tell when agents are running", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.prompt });
    await user.screenshot();
  });

  await step("while the agent reads, runs a slow command and starts a helper, a Working line never leaves the screen", async () => {
    const started = Date.now();
    // Sample like a person glancing at the screen: every 150 ms, until the helper is running.
    await probe.eventually(async () => {
      samples.push({ at: Date.now() - started, ...(await chatReadWorkingScreen(probe)) });
      return samples.filter((sample) => sample.helperRow).length;
    }, { within: 60_000, intervalMs: 150, label: "ten glances with the helper running", until: (count) => count >= 10 }).catch(() => undefined);
    const firstWorking = samples.findIndex((sample) => sample.working !== null);
    const afterStart = firstWorking >= 0 ? samples.slice(firstWorking) : samples;
    const gaps = afterStart.filter((sample) => sample.working === null);
    evidence.recordJsonArtifact("What the person saw every 150 ms", samples);
    evidence.recordAssertionEvidence(
      "Working stays on screen for the whole run",
      `${afterStart.length - gaps.length} of ${afterStart.length} glances showed a Working line; missing at ${gaps.map((gap) => `${gap.at}ms`).join(", ") || "none"}`,
      firstWorking >= 0 && gaps.length === 0,
    );
    await user.screenshot();
    expect(firstWorking, "a Working line appears after sending").toBeGreaterThanOrEqual(0);
    expect.soft(gaps.map((gap) => gap.at), "glances where Working had disappeared").toEqual([]);
  });

  await step("the turn's timer only counts up while it runs", async () => {
    const seconds = samples.map((sample) => chatWorkingSeconds(sample.working)).filter((value): value is number => value !== null);
    const backwards = seconds.slice(1).map((value, index) => ({ from: seconds[index]!, to: value })).filter((pair) => pair.to < pair.from);
    evidence.recordAssertionEvidence(
      "The Working timer never jumps back",
      `${seconds.length} readings from ${seconds[0] ?? "-"}s to ${seconds.at(-1) ?? "-"}s; ${backwards.length} jumps back (${backwards.map((pair) => `${pair.from}→${pair.to}`).join(", ") || "none"})`,
      backwards.length === 0,
    );
    expect.soft(backwards, "Working timer jumps back").toEqual([]);
  });

  await step("the running steps never shrink under the person's eyes", async () => {
    const heights = samples.map((sample) => sample.liveHeight).filter((height): height is number => height !== null);
    const shrinks = heights.slice(1).map((height, index) => heights[index]! - height).filter((drop) => drop > 8);
    evidence.recordAssertionEvidence(
      "The live steps area only grows while the turn runs",
      `${heights.length} measurements, ${shrinks.length} drops over 8px (${shrinks.join(", ") || "none"})`,
      shrinks.length === 0,
    );
    expect.soft(shrinks, "height drops of the live steps area").toEqual([]);
  });

  await step("the helper shows as its own row the person can open", async () => {
    await user.see({ text: "Check the error log" }, { timeoutMs: 30_000 });
    const rows = await probe.dom("[data-subagent-run]");
    evidence.recordAssertionEvidence("One helper row is visible", `${rows.elements.length} helper row(s)`, rows.elements.length === 1);
    expect(rows.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("the sidebar shows the chat is working, and the helper row opens the helper's own live conversation", async () => {
    const spinner = await probe.eventually(async () => (await probe.dom(`[data-sidebar-session-id="${world.session.sessionId}"] [data-session-loading-indicator]`)).elements.length, {
      within: 15_000, label: "the chat's sidebar row shows it is working", until: (count) => count === 1,
    });
    expect(spinner).toBe(1);
    await user.click({ role: "button", label: /Check the error log/ });
    await user.see({ text: world.helperMarker }, { timeoutMs: 30_000 });
    await user.see({ text: /Working/ });
    await user.screenshot();
    await user.click({ testId: `sidebar-session-${world.session.sessionId}` });
    await user.see({ text: world.prompt }, { timeoutMs: 30_000 });
  });

  await step("after: the helper finishes, the answer arrives, and the turn ends cleanly", async () => {
    await world.releaseHelper();
    await world.releaseAnswer();
    await user.see({ text: world.answer }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /Working\s*\d/ });
    await user.screenshot();
  });

  await step("the agent really did what the person watched: read, command, helper", async () => {
    const tools = (await world.requests()).filter((request) => request.kind === "tool").map((request) => request.toolName);
    const helperTools = (await world.helperRequests()).filter((request) => request.kind === "tool").map((request) => request.toolName);
    const expected = ["read", world.shell, world.engine === "v2" ? "subagent" : "task"];
    evidence.recordAssertionEvidence("Model calls match the screen", `parent: ${tools.join(" → ")}; helper: ${helperTools.join(" → ")}`,
      JSON.stringify(tools) === JSON.stringify(expected) && helperTools.length === 1);
    expect(tools).toEqual(expected);
    expect(helperTools).toEqual([world.shell]);
  });
});

test(`AGENT-VIS-02 ${resolveEvalEngine()}: a person follows up while a helper works, then stops, and nothing they typed is lost or sent behind their back`, async ({ world, user, probe, step, evidence }) => {
  await step("the person starts the research and the helper begins working", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: "Check the error log" }, { timeoutMs: 60_000 });
    await user.see("Stop");
    await user.screenshot();
  });

  await step("they add a follow-up with Enter, and it waits instead of interrupting", async () => {
    await user.type("composer", world.followUp, { verify: true });
    await user.press("Enter");
    await user.see({ text: /1 queued/ }, { timeoutMs: 10_000 });
    const delivered = (await world.followUpRequests()).length;
    evidence.recordAssertionEvidence("The follow-up waits for the current run", `shows "1 queued"; the model received it ${delivered} times`, delivered === 0);
    expect(delivered).toBe(0);
    await user.screenshot();
  });

  await step("they stop just the helper from its own row, and the turn keeps going", async () => {
    await user.see({ role: "button", label: /Check the error log\. Stop sub-agent/ });
    await user.click({ role: "button", label: /Check the error log\. Stop sub-agent/ });
    const helperStopped = await probe.eventually(async () => (await probe.dom('[data-subagent-activity="shimmer"]')).elements.length === 0,
      { within: 30_000, intervalMs: 250, label: "helper no longer running", until: Boolean }).catch(() => false);
    const turnStillRunning = (await probe.dom('button[aria-label="Stop"]')).elements.length > 0;
    evidence.recordAssertionEvidence("Stopping one helper leaves the turn running", `helper stopped: ${helperStopped}; the turn's Stop is still offered: ${turnStillRunning}`, helperStopped && turnStillRunning);
    expect(helperStopped).toBe(true);
    expect(turnStillRunning).toBe(true);
    const helperText = (await probe.dom("[data-subagent-run]")).elements.map((element) => element.text).join(" ");
    evidence.recordAssertionEvidence("A stopped helper says Stopped, not error", `helper row reads "${helperText.slice(0, 100)}"`, /Stopped/.test(helperText) && !/reported an error/i.test(helperText));
    expect(helperText).toMatch(/Stopped/);
    expect(helperText).not.toMatch(/reported an error/i);
    await user.screenshot();
  });

  await step("after: they press Stop, and the whole turn stops", async () => {
    await user.click("Stop");
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /Working\s*\d/ }, { timeoutMs: 15_000 });
    await user.screenshot();
  });

  await step("the words they queued are still there to send or edit", async () => {
    const kept = await probe.eventually(async () => {
      const onScreen = (await probe.text()).includes(world.followUp);
      const inComposer = (await probe.composer()).draftText.includes(world.followUp);
      return onScreen || inComposer;
    }, { within: 5_000, intervalMs: 250, label: "queued words kept", until: Boolean }).catch(() => false);
    evidence.recordAssertionEvidence("Stop does not throw away a queued message", kept ? "the follow-up is still visible" : "the follow-up vanished after Stop", kept);
    expect.soft(kept, "queued follow-up kept after Stop").toBe(true);
    await user.screenshot();
  });

  await step("the model never receives the follow-up on its own after Stop", async () => {
    // Watch for 4 s: the follow-up must never reach the model during that window.
    const watchedFrom = Date.now();
    const delivered = await probe.eventually(async () => {
      const count = (await world.followUpRequests()).length;
      expect(count).toBe(0);
      return { count, watchedMs: Date.now() - watchedFrom };
    }, { within: 6_000, intervalMs: 250, label: "4 s after Stop without the follow-up reaching the model", until: (value) => value.watchedMs >= 4_000 });
    evidence.recordAssertionEvidence("Nothing is sent behind the person's back", `${delivered.watchedMs} ms after Stop the model had received the follow-up ${delivered.count} times`, delivered.count === 0);
    expect(delivered.count).toBe(0);
  });
});

const backgroundTest = spec.world((seed) => agentVisibility(seed, { background: true }), {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

backgroundTest("AGENT-VIS-03 v2: a person keeps chatting while a background helper works, and the chat tells them when it's done", async ({ world, user, probe, step }) => {
  const bg = world.background;
  await step("the person hands a long comparison to a background helper, and the chat is free again while it works", async () => {
    await user.type("composer", bg.prompt);
    await user.click("Run task");
    await user.see({ text: bg.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: /1 agent running/ }, { timeoutMs: 30_000 });
    // The launch step completes at once; only the helper's own activity says it still runs.
    const helperRows = (await probe.dom("[data-subagent-run]")).elements.map((element) => element.text).join(" | ");
    expect((await probe.dom('[data-subagent-activity="shimmer"]')).elements).toHaveLength(1);
    expect(helperRows).not.toMatch(/Completed|Finished/i);
    await user.screenshot();
  });

  await step("they ask something else and get an answer without waiting for the helper", async () => {
    await user.type("composer", bg.quickQuestion);
    await user.click("Run task");
    await user.see({ text: bg.quickAnswer }, { timeoutMs: 60_000 });
    expect((await bg.helperState()).complete).toBe(false);
    await user.screenshot();
  });

  await step("after: the helper finishes and the chat reports its result as a new turn, with no raw hand-off markup", async () => {
    await bg.finishHelper();
    await user.see({ text: bg.wakeReply }, { timeoutMs: 60_000 });
    await user.notSee({ text: /1 agent running/ }, { timeoutMs: 15_000 });
    const text = await probe.text();
    expect(text.indexOf(bg.started)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(bg.started)).toBeLessThan(text.indexOf(bg.wakeReply));
    // v2 delivers the result as a hidden <subagent state="completed" …> message.
    expect(text).not.toMatch(/<subagent\b/);
    await user.screenshot();
  });
});
