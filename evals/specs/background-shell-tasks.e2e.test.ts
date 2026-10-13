import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundShellTasks } from "../worlds/background-shell-tasks.ts";

const test = spec.world(backgroundShellTasks, {
  timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const RUNNING = /\d+ running background tasks?/;

test("a member sees the commands their agent left running in the background, and a row when each one finishes", async ({ world, user, probe, step, evidence }) => {
  const indicatorRows = async () => (await probe.dom("[data-background-tasks]")).elements.map((element) => element.text.trim());
  // Completion rows on screen. Older parts of a long chat may not be rendered, so
  // look for each command's own row rather than counting rows.
  const noticeRows = async () => (await probe.dom("[data-background-task-notice]")).elements.map((element) => element.text.trim());
  const rowFor = (rows: string[], command: string) => rows.find((row) => row.endsWith(command));

  await step("before: the agent leaves a photo sync running in the background and the chat shows nothing", async () => {
    await user.type("composer", world.before.prompt);
    await user.click("Run task");
    await user.see({ text: world.before.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const rows = await indicatorRows();
    const mentioned = RUNNING.test(await probe.text());
    evidence.recordAssertionEvidence(
      "With the feature off, the chat shows no running background task",
      `turn ended while "${world.before.command}" still runs; indicator rows: ${rows.length}; "running background task" on screen: ${mentioned}`,
      rows.length === 0 && !mentioned,
    );
    expect(rows).toEqual([]);
    expect(mentioned).toBe(false);
    await user.screenshot();
  });

  await step("the command really ran in the background: when it ends, the agent picks back up by itself", async () => {
    await world.release(world.before);
    await user.see({ text: world.before.wake }, { timeoutMs: 60_000 });
    const raw = /<shell\b/.test(await probe.text());
    evidence.recordAssertionEvidence("The engine woke the agent with the command's result", `"${world.before.wake}" appeared; raw <shell> markup on screen: ${raw}`, !raw);
    expect(raw).toBe(false);
  });

  await step("the organization turns on running background tasks, and the earlier command's finish shows in the history", async () => {
    await world.turnFeatureOn();
    await user.reload();
    await user.see({ text: world.before.wake }, { timeoutMs: 60_000 });
    const rows = await probe.eventually(noticeRows, { within: 30_000, intervalMs: 250, label: "the history shows the earlier command's completion row", until: (found) => rowFor(found, world.before.command) !== undefined });
    const row = rowFor(rows, world.before.command) ?? "";
    evidence.recordAssertionEvidence("Completion rows come from the conversation's history", `row: "${row}"`, row.startsWith("Background task finished"));
    expect(row.startsWith("Background task finished")).toBe(true);
  });

  await step("after: the agent leaves a report export running and the chat says 1 running background task", async () => {
    await world.armJumpSampler();
    await user.type("composer", world.report.prompt);
    await user.click("Run task");
    await user.see({ text: world.report.started }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "1 running background task" }, { timeoutMs: 30_000 });
    const shimmer = (await probe.dom("[data-background-tasks] .ow-text-shimmer")).elements.length;
    const working = (await probe.dom('[data-loading-message="working"]')).elements.length;
    evidence.recordAssertionEvidence(
      "The count stays after the turn ends, with the Working line's shimmer",
      `indicator: "${(await indicatorRows()).join(" | ")}"; shimmering: ${shimmer === 1}; Working line still on screen: ${working > 0}`,
      shimmer === 1 && working === 0,
    );
    expect(shimmer).toBe(1);
    expect(working).toBe(0);
    await user.screenshot();
  });

  await step("the chat does not jump when the turn ends and the count takes the Working line's place", async () => {
    // Keep sampling a moment after the turn ended, then read the status line's path.
    await user.notSee({ text: /Working \d/ }, { timeoutMs: 1_500 });
    const jumps = await world.readJumpSampler();
    // One upward move as the turn starts (Starting… settling) is the known baseline; the turn's end must add none.
    const steady = jumps !== null && jumps.turnEndMove === 0 && jumps.upward <= 1;
    evidence.recordAssertionEvidence("When the turn ends, the count takes the Working line's exact place", `move at turn end: ${jumps?.turnEndMove}px; upward moves in the whole turn: ${jumps?.upward}; path: ${jumps?.path}`, steady);
    expect(jumps?.turnEndMove).toBe(0);
    expect(jumps?.upward ?? 99).toBeLessThanOrEqual(1);
  });

  await step("after: while the agent keeps working, the count shares its Working line", async () => {
    await user.type("composer", world.images.prompt);
    await user.click("Run task");
    await user.see({ text: /Working \d+s · 2 running background tasks/ }, { timeoutMs: 30_000 });
    const line = (await probe.dom('[data-loading-message="working"]')).elements.map((element) => element.text.trim()).join(" | ");
    evidence.recordAssertionEvidence("A turn that is still working shows one line for both", `status line: "${line}"`, /^Working \d+s · 2 running background tasks$/.test(line));
    expect(line).toMatch(/^Working \d+s · 2 running background tasks$/);
    await user.screenshot();
  });

  await step("after: once the turn ends, 2 running background tasks stay, each listed on hover", async () => {
    await user.see({ text: world.images.started }, { timeoutMs: 60_000 });
    await user.see({ text: "2 running background tasks" }, { timeoutMs: 30_000 });
    await user.hover({ text: "2 running background tasks" });
    const listed = await probe.eventually(async () => (await probe.dom('[data-slot="tooltip-content"]')).elements.map((element) => element.text).join(" "),
      { within: 10_000, intervalMs: 150, label: "the running commands list", until: (text) => text.includes(world.images.command) });
    const both = listed.includes(world.report.command) && listed.includes(world.images.command);
    evidence.recordAssertionEvidence("Hovering the count lists each running command", `"${world.report.command}" and "${world.images.command}" listed: ${both}`, both);
    expect(both).toBe(true);
    await user.screenshot();
    // Move the pointer away so later screenshots show the chat, not the list.
    await user.hover("composer");
  });

  await step("after: the report export finishes, the count drops to 1 and a completion row appears in its place", async () => {
    await world.release(world.report);
    await user.see({ text: "1 running background task" }, { timeoutMs: 30_000 });
    const rows = await probe.eventually(noticeRows, { within: 30_000, intervalMs: 250, label: "the report's completion row", until: (found) => rowFor(found, world.report.command) !== undefined });
    await user.see({ text: world.report.wake }, { timeoutMs: 60_000 });
    const indicator = (await indicatorRows()).join(" | ");
    evidence.recordAssertionEvidence("A finished command leaves the count and gets its own row", `indicator: "${indicator}"; row: "${rowFor(rows, world.report.command)}"`, indicator === "1 running background task");
    expect(indicator).toBe("1 running background task");
    await user.screenshot();
  });

  await step("after: the last command finishes and the indicator goes away", async () => {
    await world.release(world.images);
    await probe.eventually(indicatorRows, { within: 30_000, intervalMs: 150, label: "the running count goes away", until: (found) => found.length === 0 });
    await user.notSee({ text: RUNNING }, { timeoutMs: 3_000 });
    await user.see({ text: world.images.wake }, { timeoutMs: 60_000 });
    const rows = await probe.eventually(noticeRows, { within: 30_000, intervalMs: 250, label: "the images' completion row", until: (found) => rowFor(found, world.images.command) !== undefined });
    const raw = /<shell\b/.test(await probe.text());
    evidence.recordAssertionEvidence(
      "No count is left once every command has ended, and no raw markup shows",
      `indicator rows: ${(await indicatorRows()).length}; row: "${rowFor(rows, world.images.command)}"; raw <shell> markup: ${raw}`,
      !raw,
    );
    expect(await indicatorRows()).toEqual([]);
    expect(raw).toBe(false);
    await user.screenshot();
  });

  await step("the completion rows are still there after reopening the chat, and nothing counts as running", async () => {
    await user.reload();
    await user.see({ text: world.images.wake }, { timeoutMs: 60_000 });
    const rows = await probe.eventually(noticeRows, { within: 30_000, intervalMs: 250, label: "completion rows after reload", until: (found) => rowFor(found, world.images.command) !== undefined && rowFor(found, world.report.command) !== undefined });
    const running = RUNNING.test(await probe.text());
    evidence.recordAssertionEvidence("History keeps the completion rows; the count is read from the engine", `rows: ${rows.join(" | ")}; running count on screen: ${running}`, !running);
    expect(running).toBe(false);
  });
});
