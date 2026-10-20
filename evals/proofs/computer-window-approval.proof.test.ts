import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerWindowApproval } from "../worlds/computer-window-approval.ts";

const test = spec.world(computerWindowApproval, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a local app window waits for an explicit choice and can be declined", async ({ world, user, probe, step, evidence }) => {
  await step("before: the app names the task and window without approving access", async () => {
    await user.see({ testId: "session-computer-window-approval" });
    await user.see({ role: "button", label: "Allow this window" });
    expect(world.decisions()).toEqual([]);
    evidence.recordAssertionEvidence("Window access waits for the person", "The task, selected window and model-provider disclosure are visible. No native decision was sent.", world.decisions().length === 0);
    await user.screenshot();
  });
  await step("after: allowing the chosen window sends exactly that decision", async () => {
    await user.click({ role: "combobox", label: "Window to allow" });
    await user.click({ role: "option", label: "Planning notes" });
    await user.click({ role: "button", label: "Allow this window" });
    await user.see({ text: "Selected window approved" });
    await user.notSee({ testId: "session-computer-window-approval" });
    expect(world.decisions()).toEqual([{ sessionId: "fixture-chat", id: "fixture-window-choice", action: "approve", windowId: 18 }]);
    evidence.recordAssertionEvidence("Only the selected window is approved", "One explicit Allow action sent window 18, Planning notes.", world.decisions().length === 1);
    await user.screenshot();
  });
  await step("declining a new request sends no additional approval", async () => {
    await user.navigate(world.url);
    await user.see({ testId: "session-computer-window-approval" });
    await user.click({ role: "button", label: "Not now" });
    await user.see({ text: "Window access declined" });
    await probe.eventually(world.decisions, { within: 3000, until: value => value.length === 2, label: "the denial reaches the helper fixture" });
    expect(world.decisions()[1]).toEqual({ sessionId: "fixture-chat", id: "fixture-window-choice", action: "deny" });
    evidence.recordAssertionEvidence("Not now refuses window access", "The new request sent deny, without a window ID or another approval.", world.decisions().length === 2);
    await user.screenshot();
  });
});
