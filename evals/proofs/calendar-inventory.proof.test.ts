import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { calendarInventory } from "../worlds/calendar-inventory.ts";

const test = spec.world(calendarInventory, { timeout: 180_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member finds later automations and their full history without sharing an unseen selection", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("after: the calendar opens without choosing work for the member", async () => {
    await user.see({ text: /More automations are available/ });
    expect((await probe.dom("[data-calendar-detail]")).elements).toHaveLength(0);
    await user.type({ role: "textbox", label: "Message Workbot" }, "What is on my calendar?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "a range question has no selected item", until: values => values.length === 1 });
    expect(sent[0]).toMatchObject({ context: { kind: "calendar" } });
    expect(sent[0]).not.toHaveProperty("context.selected");
    evidence.recordAssertionEvidence("Data arrival opens no detail and shares no selected automation", JSON.stringify(sent[0]), (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
  await step("the member searches beyond the first page and opens an automation", async () => {
    await user.click({ text: /Find automations and history/ });
    await user.type({ label: "Search loaded calendar" }, "Weekly summary");
    await user.see({ text: /No matching automations in 100 loaded/ });
    await user.click({ role: "button", label: "Load more automations" });
    await user.click({ role: "button", label: "Weekly summary" });
    await user.see({ role: "heading", label: "Weekly summary" });
    const paged = world.requests().some(value => value.includes("/automations?limit=100&cursor=100"));
    expect(paged).toBe(true);
    expect((await probe.dom("[data-calendar-directory-results] li")).elements.length).toBeLessThanOrEqual(20);
    evidence.recordAssertionEvidence("The later automation remains reachable through the real cursor", "cursor=100 requested; Weekly summary opened", paged);
    await user.screenshot();
  });
  await step("a failed receipt is unknown until Retry verifies it", async () => {
    await user.click({ role: "button", label: "Open", nth: 0 });
    await user.see({ text: "Couldn't verify this result." });
    await user.notSee({ text: "No result was recorded for this run." });
    await user.screenshot();
    world.restoreReceipts();
    await user.click({ role: "button", label: "Retry" });
    await user.see({ text: "Recorded result 0" });
    await user.click({ role: "button", label: "Open", nth: 0 });
    await user.see({ text: "No result was recorded for this run." });
    evidence.recordAssertionEvidence("Failure and verified absence are different states", "503: Couldn't verify; Retry: Recorded result 0; successful empty receipt: No result was recorded", world.requests().filter(value => value.endsWith("/automation-runs/run_0")).length >= 2);
    await user.screenshot();
  });
  await step("the full history route pages past the overview and first request", async () => {
    await user.click({ role: "link", label: "Open full history" });
    await user.see({ role: "heading", label: "Run history" });
    expect(await probe.url()).toContain("history=automation_119");
    await user.click({ role: "button", label: "Load more runs" });
    await user.see({ text: "Showing 21–40 of 40 loaded; more runs available." });
    await user.click({ role: "button", label: "Load more runs" });
    await user.see({ text: "Showing 41–45 of 45 loaded; all runs loaded." });
    expect((await probe.dom("[data-calendar-past-run]")).elements).toHaveLength(5);
    const paged = world.requests().some(value => value.includes("/automation_119/runs?limit=20&cursor=40"));
    expect(paged).toBe(true);
    evidence.recordAssertionEvidence("All 45 runs are reachable with bounded rendered history", "history route reached runs 41–45 using cursor=40; five rows rendered", paged);
    await user.screenshot();
  });
  await step("changing range clears the detail and the next question's selected context", async () => {
    await user.click({ role: "button", label: /^Next$/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    await user.type({ role: "textbox", label: "Message Workbot" }, "What about this week?");
    await user.press("Enter");
    const sent = await probe.eventually(() => world.messages(), { within: 5000, label: "range navigation clears the shared selection", until: values => values.length === 2 });
    expect(sent[1]).not.toHaveProperty("context.selected");
    await user.click({ role: "button", label: /^Previous$/ });
    await user.notSee({ role: "heading", label: "Weekly summary" });
    evidence.recordAssertionEvidence("An earlier selection cannot silently return with an earlier range", JSON.stringify(sent[1]), (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
});

test("a member can distinguish partial calendar ranges and failed reads from an empty calendar", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("after: capped run and meeting reads remain visibly incomplete", async () => {
    await user.navigate(`${world.url}calendar?dense=1`);
    await user.see({ text: /Some runs may be missing from this range/ });
    await user.see({ text: /Some Google Calendar meetings may be missing/ });
    expect((await probe.dom("[data-calendar-automation]")).elements.length).toBeLessThanOrEqual(100);
    const runRequests = world.requests().filter(value => value.includes("automation-runs?from="));
    expect(runRequests.length).toBeGreaterThanOrEqual(10);
    evidence.recordAssertionEvidence("Bounded reads never claim complete coverage", `${runRequests.length} range pages; run and Google incompleteness shown`, (await probe.dom("[data-calendar-incomplete]")).elements.length >= 2);
    await user.screenshot();
  });
  await step("a range failure offers Retry instead of claiming there were no runs", async () => {
    world.failRange();
    await user.navigate(`${world.url}calendar?count=0`);
    await user.see({ text: "Couldn't verify runs for this range." });
    evidence.recordAssertionEvidence("A failed range is not an empty range", "503 range response; Couldn't verify runs for this range and Retry", world.requests().some(value => value.includes("automation-runs?from=")));
    await user.screenshot();
  });
  await step("Retry verifies the same range without opening a detail panel", async () => {
    world.restoreRange();
    await user.click({ role: "button", label: "Retry" });
    await probe.eventually(() => probe.dom('[role="alert"]'), { within: 5000, label: "the recovered range clears its verification error", until: value => value.elements.every(element => !element.text.includes("Couldn't verify runs for this range.")) });
    await user.notSee({ text: "Couldn't verify runs for this range." });
    expect((await probe.dom("[data-calendar-detail]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Recovery leaves selection to the member", "The range recovers; no automation detail is opened", (await probe.dom("[data-calendar-detail]")).elements.length === 0);
    await user.screenshot();
  });
});
