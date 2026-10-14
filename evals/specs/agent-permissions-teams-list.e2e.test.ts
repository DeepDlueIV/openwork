import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { LONG_TEAM_NAME, agentPermissionsTeamsList, teamsListLongNames } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsTeamsList, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const longNamesTest = spec.world(teamsListLongNames, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

const px = (value: number) => `${Math.round(value)}px`;
/** Row heights, ignoring the last row's missing 1px divider. */
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

test("an owner sees in Members › Teams which teams change agent permissions, starting from Everyone", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const cells = async () => (await probe.dom('[data-testid="team-row-agent-permissions"]')).elements.map((element) => element.text.trim());

  await step("before: without agent permissions the Teams list has no Everyone row and no Agent permissions column", async () => {
    await owner.see({ text: "Contractors" }, { timeoutMs: 90_000 });
    await owner.notSee({ testId: "team-row-everyone" });
    const shown = await cells();
    evidence.recordAssertionEvidence("agent permission cells while the feature is off", shown.length === 0 ? "none" : shown.join(", "), shown.length === 0);
    expect(shown).toEqual([]);
    await owner.screenshot();
  });

  await step("after: with it on and Contractors asking before commands, Everyone is pinned first as the base and each team says whether it changes it", async () => {
    await world.enableFeature();
    await world.saveContractors({ commands: { decision: "ask" } });
    await owner.reload();
    await owner.see({ testId: "team-row-everyone" }, { text: /Every member, including people in no team/, timeoutMs: 60_000 });
    await owner.see({ text: "1 override" }, { timeoutMs: 30_000 });
    await owner.see({ text: "Follows Everyone" });
    const shown = await cells();
    evidence.recordAssertionEvidence("Agent permissions column, top to bottom", shown.join(" · "), shown[0] === "Base for every team" && shown.includes("1 override") && shown.includes("Follows Everyone"));
    expect(shown[0]).toBe("Base for every team");
    expect([...shown.slice(1)].sort()).toEqual(["1 override", "Follows Everyone"]);
    await owner.screenshot();
  });

  await step("the counts follow what each team saves: Contractors adds a second change and Engineering gets its first", async () => {
    await world.saveContractors({ commands: { decision: "ask" }, webSearch: { decision: "deny" } });
    await world.save({ websites: { decision: "deny" } }, "Engineering");
    await owner.reload();
    await owner.see({ text: "2 overrides" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Follows Everyone" });
    const shown = await cells();
    evidence.recordAssertionEvidence("Agent permissions column, top to bottom", shown.join(" · "), shown[0] === "Base for every team" && shown.includes("2 overrides") && shown.includes("1 override"));
    expect([...shown.slice(1)].sort()).toEqual(["1 override", "2 overrides"]);
    await owner.screenshot();
  });
});

longNamesTest("an owner reads every team on one line in Members › Teams, even with long names, and deleting a team asks first", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const rects = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.rect);

  await step("after: Everyone and every team start their names at the same place, on one line, in rows of one height", async () => {
    await owner.see({ text: LONG_TEAM_NAME }, { timeoutMs: 90_000 });
    await owner.see({ testId: "team-row-everyone" }, { text: /Every member, including people in no team/ });
    await owner.see({ text: "Sales Team Permissions" });
    await owner.screenshot();
    await owner.see({ role: "button", label: "Create team" });
    const rows = await rects('[data-testid="team-row-everyone"], [data-testid="team-row"]');
    const names = await rects('[data-testid="team-row-name"]');
    const lines = await rects('[data-testid="team-row-name"], [data-testid="team-row-subtitle"], [data-testid="team-row-role"], [data-testid="team-row-members"]');
    const heights = rows.map((rect) => rect.height);
    const starts = [...new Set(names.map((rect) => px(rect.left)))];
    const tallest = Math.max(...lines.map((rect) => rect.height));
    const ok = rows.length === 4 && names.length === 4 && spread(heights) <= 1 && starts.length === 1 && tallest <= 20;
    evidence.recordAssertionEvidence(
      "rows, name starts and the tallest line",
      `${rows.length} rows ${px(Math.min(...heights))}–${px(Math.max(...heights))} tall; names start at ${starts.join(" / ")}; tallest name, subtitle, role or members line ${px(tallest)}`,
      ok,
    );
    expect(rows).toHaveLength(4);
    expect(spread(heights)).toBeLessThanOrEqual(1);
    expect(starts).toHaveLength(1);
    expect(tallest).toBeLessThanOrEqual(20);
  });

  await step("each team's actions sit in one menu, and Everyone's lane holds a same-size Open link", async () => {
    await owner.click({ role: "button", label: "Actions for Sales Team" });
    await owner.see({ role: "menuitem", label: "Edit" });
    await owner.see({ role: "menuitem", label: "Delete" });
    await owner.screenshot();
    const lanes = await rects('[data-testid="team-row-everyone"] [data-team-action], [data-testid="team-row"] [data-team-action]');
    const widths = [...new Set(lanes.map((rect) => px(rect.width)))];
    const lefts = [...new Set(lanes.map((rect) => px(rect.left)))];
    evidence.recordAssertionEvidence("action lanes", `${lanes.length} lanes, ${widths.join(" / ")} wide, starting at ${lefts.join(" / ")}`, lanes.length === 4 && widths.length === 1 && lefts.length === 1);
    expect(lanes).toHaveLength(4);
    expect(widths).toHaveLength(1);
    expect(lefts).toHaveLength(1);
  });

  await step("Delete names the team and what its members lose before anything is removed; Cancel keeps it", async () => {
    await owner.click({ role: "menuitem", label: "Delete" });
    await owner.see({ testId: "confirm-dialog" }, { text: /Delete Sales Team\?/ });
    await owner.see({ testId: "confirm-dialog" }, { text: /3 members lose this team's role, access and agent permissions/ });
    await owner.screenshot();
    await owner.click({ testId: "confirm-dialog-cancel" });
    await probe.eventually(() => probe.dom('[data-testid="confirm-dialog"]'), { within: 10_000, label: "the dialog closes", until: (found) => found.elements.length === 0 });
    const kept = (await probe.dom('[data-testid="team-row-name"]')).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("teams after Cancel", kept.join(" · "), kept.includes("Sales Team"));
    expect(kept).toContain("Sales Team");
  });

  await step("after: confirming removes Sales Team and the other rows keep their layout", async () => {
    await owner.click({ role: "button", label: "Actions for Sales Team" });
    await owner.click({ role: "menuitem", label: "Delete" });
    await owner.click({ role: "button", label: "Delete team" });
    await probe.eventually(() => probe.dom('[data-testid="confirm-dialog"], [data-testid="team-row-name"][title="Sales Team"]'), {
      within: 30_000,
      label: "the dialog closes and Sales Team leaves the list",
      until: (found) => found.elements.length === 0,
    });
    await owner.notSee({ text: "Sales Team Permissions" });
    const left = (await probe.dom('[data-testid="team-row-name"]')).elements.map((element) => element.text);
    const heights = (await rects('[data-testid="team-row-everyone"], [data-testid="team-row"]')).map((rect) => rect.height);
    evidence.recordAssertionEvidence("teams after Delete", `${left.join(" · ")}; rows ${px(Math.min(...heights))}–${px(Math.max(...heights))} tall`, !left.includes("Sales Team") && spread(heights) <= 1);
    expect(left).not.toContain("Sales Team");
    expect(spread(heights)).toBeLessThanOrEqual(1);
    await owner.screenshot();
  });
});
