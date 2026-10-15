import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { teamAccess } from "../worlds/team-access.ts";

const test = spec.world(teamAccess, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner reviews team plugin access and confirms a revoke without changing other access", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  await step("before: access is a wide table with colored badges and granted-by details", async () => {
    await owner.see({ text: "Granted by" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Research briefing" });
    const legacy = await probe.dom('[data-testid="team-plugin-access"]');
    evidence.recordAssertionEvidence("the compact rows are off by default", `${legacy.elements.length} compact panels`, legacy.elements.length === 0);
    expect(legacy.elements).toHaveLength(0);
    await owner.screenshot();
  });
  await step("after: names and component counts sit beside plain Everyone, This team and Through Shared tools lanes", async () => {
    await world.setRows(true);
    await owner.reload();
    await owner.see({ testId: "team-plugin-access-row" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Through Shared tools" });
    await owner.notSee({ text: "Granted by" });
    const rows = (await probe.dom('[data-testid="team-plugin-access-row"]')).elements;
    const statuses = (await probe.dom('[data-testid="team-plugin-access-row"] [data-item-status]')).elements.map((entry) => entry.text.trim());
    evidence.recordAssertionEvidence("three access paths have separate rows", `${rows.length} rows; ${statuses.join(" / ")}`, rows.length === 3 && statuses.join("|") === "Everyone|This team|Through Shared tools");
    expect(rows).toHaveLength(3);
    expect(statuses).toEqual(["Everyone", "This team", "Through Shared tools"]);
    const nameLanes = (await probe.dom('[data-testid="team-plugin-access-row"] > span:first-child > span:last-child')).elements;
    const accessLanes = (await probe.dom('[data-testid="team-plugin-access-row"] [data-item-status]')).elements;
    expect(nameLanes.every((lane) => lane.rect.width >= 280)).toBe(true);
    expect(new Set(accessLanes.map((lane) => Math.round(lane.rect.left))).size).toBe(1);
    await owner.screenshot();
  });
  await step("Revoke names the team, plugin and loss of access; Cancel leaves the grant unchanged", async () => {
    await owner.click({ role: "button", label: "More for Research briefing, This team" });
    await owner.click({ role: "menuitem", label: "Revoke" });
    await owner.see({ testId: "confirm-dialog" }, { text: /Remove Research's direct access to Research briefing and its 1 component/ });
    const before = await world.access();
    evidence.recordAssertionEvidence("confirmation does not revoke access", `${before.length} access paths remain before confirmation`, before.length === 3);
    expect(before).toHaveLength(3);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Cancel" });
    expect(await world.access()).toHaveLength(3);
  });
  await step("a member outside Research cannot revoke its grant or see its private briefing", async () => {
    const outsider = user.on(world.member);
    await outsider.see({ text: "My Library" }, { timeoutMs: 90_000 });
    await outsider.notSee({ text: "Research briefing" });
    const denied = await world.outsiderRevoke();
    const remaining = await world.access();
    evidence.recordAssertionEvidence("a member cannot revoke the team's grant", `HTTP ${denied.response.status}; ${remaining.length} access paths remain`, denied.response.status === 403 && remaining.length === 3);
    expect(denied.response.status).toBe(403);
    expect(remaining).toHaveLength(3);
    await outsider.screenshot();
  });
  await step("confirming Revoke removes only This team; Everyone and the catalog stay", async () => {
    await owner.click({ role: "button", label: "More for Research briefing, This team" });
    await owner.click({ role: "menuitem", label: "Revoke" });
    await owner.click({ role: "button", label: "Revoke" });
    await probe.eventually(() => probe.dom('[data-testid="team-plugin-access-row"]'), { within: 30_000, label: "the direct grant leaves the list", until: (rows) => rows.elements.length === 2 });
    await owner.notSee({ role: "button", label: "More for Research briefing, This team" });
    const remaining = await world.access();
    evidence.recordAssertionEvidence("only the direct team grant is removed", `${remaining.length} access paths: ${remaining.map((item) => item.edge).join(", ")}`, remaining.length === 2 && !remaining.some((item) => item.edge === "direct_team"));
    expect(remaining).toHaveLength(2);
    expect(remaining.some((item) => item.edge === "direct_team")).toBe(false);
    await owner.screenshot();
  });
  await step("Open catalog goes to Shared tools without changing catalog access", async () => {
    await owner.click({ role: "button", label: "More for Shared research tools for planning and reviewing unusually detailed project briefs, Through Shared tools" });
    await owner.click({ role: "menuitem", label: "Open catalog" });
    await owner.see({ role: "heading", label: "Shared tools" }, { timeoutMs: 30_000 });
    const remaining = await world.access();
    expect(remaining).toHaveLength(2);
    evidence.recordAssertionEvidence("catalog access remains usable after revocation", `Shared tools opened; ${remaining.length} access paths remain`, remaining.length === 2);
    await owner.screenshot();
  });
  await step("switching off restores the table without restoring the revoked grant", async () => {
    await world.setRows(false);
    await owner.navigate(world.teamUrl);
    await owner.see({ text: "Granted by" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Research briefing" });
    const remaining = await world.access();
    evidence.recordAssertionEvidence("rollback preserves access data", `${remaining.length} access paths remain`, remaining.length === 2);
    expect(remaining).toHaveLength(2);
    await owner.screenshot();
  });
});
