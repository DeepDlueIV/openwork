import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentPermissionsTeamsList } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsTeamsList, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner sees in Members › Teams which teams change agent permissions, starting from Everyone", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const cells = async () => (await probe.dom('[data-testid="team-row-agent-permissions"]')).elements.map((element) => element.text.trim());

  await step("before: without agent permissions the Teams list has no Everyone row and no Agent permissions column", async () => {
    await owner.see({ text: "Contractors" }, { timeoutMs: 90_000 });
    await owner.notSee({ testId: "team-row-everyone" });
    await owner.notSee({ text: "Agent permissions" });
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
