import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentPermissionsMoved } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsMoved, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner finds agent permissions under Members › Teams, and old Agent permissions links still land there", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const path = async () => (await probe.hash()).replace(/^#/, "");
  const landsOn = async (expected: string) => probe.eventually(path, { within: 30_000, label: `the page moves to ${expected}`, until: (current) => current === expected });

  await step("search for agent permissions offers Members, and Settings no longer lists Agent permissions", async () => {
    await owner.see({ testId: "den-command-palette-trigger" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "den-command-palette-trigger" });
    await owner.type({ testId: "den-command-palette-input" }, "agent permissions");
    await owner.see({ role: "option", label: /^Members/ });
    await owner.notSee({ role: "option", label: /Agent permissions/ });
    evidence.recordAssertionEvidence("searching agent permissions", "Members is offered; no Settings › Agent permissions page", true);
    await owner.screenshot();
    await owner.press("Escape");
  });

  await step("an old Agent permissions link opens Everyone in Members › Teams", async () => {
    await owner.navigate(`${world.webUrl}/dashboard/agent-permissions`);
    const landed = await landsOn("/dashboard/members/teams/everyone");
    await owner.see({ testId: "everyone-screen" });
    await owner.see({ testId: "agent-permissions-intro" }, { text: /^What agents can do on every member/ });
    await owner.see({ testId: "agent-permissions-editor" });
    evidence.recordAssertionEvidence("/dashboard/agent-permissions", `→ ${landed}`, landed === "/dashboard/members/teams/everyone");
    expect(landed).toBe("/dashboard/members/teams/everyone");
    await owner.screenshot();
  });

  await step("an old team link opens that team, and the old create link opens Members", async () => {
    await owner.navigate(`${world.webUrl}/dashboard/agent-permissions/${encodeURIComponent(world.teamId)}`);
    const team = await landsOn(`/dashboard/members/teams/${world.teamId}`);
    await owner.see({ testId: "agent-permissions-intro" }, { text: /people in Contractors/ });
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone" });
    await owner.screenshot();
    await owner.navigate(`${world.webUrl}/dashboard/agent-permissions/new`);
    const created = await landsOn("/dashboard/members");
    evidence.recordAssertionEvidence("old team and create links", `team → ${team}; new → ${created}`, team === `/dashboard/members/teams/${world.teamId}` && created === "/dashboard/members");
    expect([team, created]).toEqual([`/dashboard/members/teams/${world.teamId}`, "/dashboard/members"]);
    await owner.see({ role: "tab", label: /^Teams/ });
    await owner.see({ testId: "team-row-everyone" });
    await owner.screenshot();
  });
});
