import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { teamPageTabs } from "../worlds/team-page-tabs.ts";

const test = spec.world(teamPageTabs, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

const texts = async (probe: Probe, selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.trim());
const tabs = (probe: Probe) => texts(probe, '[role="tab"]');

test("an owner finds a team's browser rules and AI models on their own tabs, laid out like its Agents tab", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);

  await step("before: Open websites sits in the Agents tab with commands and skills, and there is no Browser or Models tab", async () => {
    await owner.see({ testId: "agent-permission-websites" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "agent-permission-commands" });
    const shown = await tabs(probe);
    evidence.recordAssertionEvidence("Contractors' tabs", shown.join(" · "), !shown.includes("Browser") && !shown.includes("Models"));
    expect(shown).not.toContain("Browser");
    expect(shown).not.toContain("Models");
    await owner.screenshot();
  });

  await step("after: with Team page tabs on, Contractors has Role, Members, Access, Agents, Browser and Models, and Agents no longer holds Open websites", async () => {
    await world.setTabs(true);
    await owner.reload();
    await owner.see({ role: "tab", label: "Browser" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "agent-permission-commands" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "agent-permission-websites" });
    const shown = await tabs(probe);
    evidence.recordAssertionEvidence("Contractors' tabs", shown.join(" · "), shown.join(",") === "Role,Members,Access,Agents,Browser,Models");
    expect(shown).toEqual(["Role", "Members", "Access", "Agents", "Browser", "Models"]);
    await owner.screenshot();
  });

  await step("the Browser tab uses the Agents row: name and one line, Changed for Contractors with Use Everyone's, and the same status and control lanes", async () => {
    const agentLane = (await probe.dom('[data-testid="agent-permission-commands-source"]')).elements[0]?.rect;
    await owner.click({ role: "tab", label: "Browser" });
    await owner.see({ testId: "agent-permission-websites-source" }, { text: /Changed for Contractors/, timeoutMs: 30_000 });
    await owner.see({ role: "button", label: "Use Everyone's setting for Open websites" });
    await owner.see({ testId: "agent-permission-websites-allow" }, { text: /docs\.example\.com/ });
    await owner.notSee({ testId: "agent-permission-commands" });
    const browserLane = (await probe.dom('[data-testid="agent-permission-websites-source"]')).elements[0]?.rect;
    const same = Boolean(agentLane && browserLane && Math.round(agentLane.left) === Math.round(browserLane.left) && Math.round(agentLane.width) === Math.round(browserLane.width));
    evidence.recordAssertionEvidence("status lane on Agents and Browser", `Agents ${Math.round(agentLane?.left ?? 0)}px, ${Math.round(agentLane?.width ?? 0)}px wide; Browser ${Math.round(browserLane?.left ?? 0)}px, ${Math.round(browserLane?.width ?? 0)}px wide`, same);
    expect(same).toBe(true);
    await owner.screenshot();
  });

  await step("Use Everyone's and Save: Contractors follows Everyone for websites and Riley's app stops getting the Contractors block", async () => {
    const before = await world.rileyWebsiteRules();
    await owner.click({ role: "button", label: "Use Everyone's setting for Open websites" });
    await owner.see({ testId: "agent-permission-websites-source" }, { text: "From Everyone" });
    await owner.click({ role: "button", label: "Save changes" });
    await probe.eventually(() => probe.dom('[data-testid="agent-permissions-save-bar"]'), { within: 30_000, label: "the save lands", until: (bar) => bar.elements.length === 0 });
    const after = await world.rileyWebsiteRules();
    evidence.recordAssertionEvidence("Riley's website rules", `before: ${before.join("; ") || "none"} → after: ${after.join("; ") || "none"}`, before.some((rule) => rule.includes("Contractors")) && !after.some((rule) => rule.includes("Contractors")));
    expect(before.some((rule) => rule.includes("Contractors"))).toBe(true);
    expect(after.some((rule) => rule.includes("Contractors"))).toBe(false);
    await owner.screenshot();
  });

  await step("the Models tab lists the providers Contractors can use, the one it can't, its own spend limit with Edit, and New limit for Contractors", async () => {
    await owner.click({ role: "tab", label: "Models" });
    await owner.see({ text: "Claude for Contractors" }, { timeoutMs: 30_000 });
    await owner.see({ text: "Shared OpenRouter" });
    await owner.see({ testId: "team-models-provider-withheld" }, { text: /Engineering models/ });
    await owner.see({ testId: "gateway-limit-row" }, { text: /\$50\.00 a day, \$500\.00 a month each/ });
    await owner.see({ role: "link", label: "Edit Contractors" });
    await owner.see({ testId: "team-default-model-section" });
    const usable = await texts(probe, '[data-testid="team-models-provider"]');
    const limits = await texts(probe, '[data-testid="gateway-limit-row"]');
    const ok = usable.length === 2 && limits.length === 1 && !limits[0]?.includes("Everyone default");
    evidence.recordAssertionEvidence("providers Contractors can use, and its limits", `${usable.length} usable providers; limits: ${limits.join(" | ")}`, ok);
    expect(usable).toHaveLength(2);
    expect(limits).toHaveLength(1);
    await owner.screenshot();
  });

  await step("New limit opens the AI Gateway limit editor already aimed at Contractors", async () => {
    await owner.click({ testId: "team-models-new-limit" });
    await owner.see({ testId: "gateway-limit-editor" }, { text: /Contractors/, timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("limit editor target", (await texts(probe, '[data-testid="gateway-limit-editor"]'))[0]?.slice(0, 160) ?? "", true);
    await owner.screenshot();
  });

  await step("Everyone's page has the same Browser and Models tabs, holding the organization defaults", async () => {
    await owner.navigate(world.everyoneUrl("browser"));
    await owner.see({ testId: "agent-permissions-browser" }, { text: /built-in browser can open on every member's computer/, timeoutMs: 60_000 });
    await owner.see({ testId: "agent-permission-websites" });
    await owner.click({ role: "tab", label: "Models" });
    await owner.see({ testId: "gateway-limit-row" }, { text: /Everyone default/, timeoutMs: 30_000 });
    const shown = await tabs(probe);
    evidence.recordAssertionEvidence("Everyone's tabs", shown.join(" · "), shown.join(",") === "Role,Agents,Browser,Models");
    expect(shown).toEqual(["Role", "Agents", "Browser", "Models"]);
    await owner.screenshot();
  });

  await step("turned off again, the tabs go away and Open websites is back on the Agents tab", async () => {
    await world.setTabs(false);
    await owner.navigate(world.teamUrl("browser"));
    await owner.see({ role: "tab", label: "Agents" }, { timeoutMs: 60_000 });
    const shown = await tabs(probe);
    await owner.click({ role: "tab", label: "Agents" });
    await owner.see({ testId: "agent-permission-websites" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("Contractors' tabs with the feature off", shown.join(" · "), !shown.includes("Browser") && !shown.includes("Models"));
    expect(shown).not.toContain("Browser");
    expect(shown).not.toContain("Models");
    await owner.screenshot();
  });
});
