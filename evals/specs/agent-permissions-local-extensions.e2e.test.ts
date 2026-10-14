import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { randomUUID } from "node:crypto";
import { agentPermissionsDesktop, contractorDesktopPermissions, folderSkills } from "../worlds/agent-permissions.ts";

const test = spec.world(agentPermissionsDesktop, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Local skills, local MCP servers and the built-in browser follow a member's agent permissions only in the desktop app, whose local OpenWork server and Electron browser receive them with the member's Den session.",
  },
  needs: { placement: "local" },
});

test("a contractor's agent uses no local skills or local MCP servers while the team blocks them, keeps OpenWork Cloud, and uses both once the team allows them", async ({ world, user, agent, probe, step, evidence }) => {
  const skill = folderSkills.allowed;
  /** The witness model loads `name` from the skill catalog the engine offers. */
  const loadSkill = (name: string): MockAgentToolStep[] => [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: name } }];
  const isSkill = (name: string) => (input: Record<string, unknown>) => input.name === name || input.id === name || input.skill === name;
  const send = async (prompt: string) => {
    await user.type("composer", prompt);
    await user.click("Run task");
  };
  const local = (rules: Record<string, unknown>[]) => rules.filter((rule) => rule.action === "skill" || rule.action === "mcp")
    .map((rule) => `${String(rule.action)} ${String(rule.resource)} → ${String(rule.effect)}`);

  await step("given Riley's OpenWork blocks local skills and local MCP servers as a whole for Contractors", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const rules = local(await world.enforcedRules());
    evidence.recordAssertionEvidence("local skill and MCP server rules Riley's OpenWork enforces", rules.join("; "), rules.join("; ") === "skill * → deny; mcp * → deny");
    expect(rules).toEqual(["skill * → deny", "mcp * → deny"]);
    await user.screenshot();
  });

  await step("before: the folder's checklist skill never reaches the agent", async () => {
    const prompt = `Follow the team checklist. ${randomUUID()}`;
    const reply = `Checklist unavailable. ${randomUUID()}`;
    await world.prepareTurn(prompt, reply, loadSkill(skill.name));
    await send(prompt);
    await user.see({ text: reply }, { timeoutMs: 120_000 });
    await user.notSee({ text: skill.marker });
    const call = await world.toolCall("skill", isSkill(skill.name));
    const reason = `${call?.error ?? ""} ${call?.output ?? ""}`.trim();
    // v2 leaves a blocked skill out of the catalog it offers; a call that still names it is refused with the rule.
    const kept = call === null
      ? (await world.mock.agentRequests({ promptMarker: prompt })).every((request) => request.toolName !== "skill")
      : call.status === "error" && reason.includes(`Your organization's agent permissions block the local skill "${skill.name}" (set for Contractors)`);
    evidence.recordAssertionEvidence("the team-checklist skill", call === null
      ? "not offered to the agent, and the agent loaded no skill"
      : `${call.status}; the agent was told: ${reason || "(nothing)"}`, kept);
    expect(kept).toBe(true);
    await user.screenshot();
  });

  await step("the folder's MCP server is off while OpenWork Cloud, the organization's connection, stays on", async () => {
    const servers = await probe.eventually(() => world.mcpServers(), {
      within: 60_000, label: "the engine lists OpenWork Cloud", until: (found) => found["openwork-cloud"] !== undefined,
    });
    const notes = servers["notes-server"] ?? null;
    const cloud = servers["openwork-cloud"];
    evidence.recordAssertionEvidence("MCP servers in Riley's engine", JSON.stringify(servers),
      (notes === null || notes === "disabled") && cloud !== undefined && cloud !== "disabled");
    expect(notes === null || notes === "disabled").toBe(true);
    expect(cloud).toBeDefined();
    expect(cloud).not.toBe("disabled");
  });

  await step("adding a local skill or a local MCP server in OpenWork is refused with the Contractors rule", async () => {
    const workspace = encodeURIComponent(world.app.workspaceId);
    const skillAdded = await agent.desktopApi(`/workspace/${workspace}/skills`, {
      method: "POST", body: { name: "meeting-notes", description: "Summarize meeting notes.", content: "Summarize the meeting notes." },
    });
    const serverAdded = await agent.desktopApi(`/workspace/${workspace}/mcp`, {
      method: "POST", body: { name: "issue-tracker", config: { type: "remote", url: world.mock.mcpUrl, oauth: false } },
    });
    const [skillMessage, serverMessage] = [JSON.stringify(skillAdded.body), JSON.stringify(serverAdded.body)];
    evidence.recordAssertionEvidence("adding meeting-notes and issue-tracker", `skill: HTTP ${skillAdded.status} ${skillMessage}; MCP server: HTTP ${serverAdded.status} ${serverMessage}`,
      skillAdded.status === 403 && serverAdded.status === 403
        && skillMessage.includes('block the local skill \\"meeting-notes\\" (set for Contractors)')
        && serverMessage.includes('block the local MCP server \\"issue-tracker\\" (set for Contractors)'));
    expect(skillAdded.status).toBe(403);
    expect(skillMessage).toContain('block the local skill \\"meeting-notes\\" (set for Contractors)');
    expect(serverAdded.status).toBe(403);
    expect(serverMessage).toContain('block the local MCP server \\"issue-tracker\\" (set for Contractors)');
  });

  await step("the built-in browser opens the briefing page, which Contractors allow, and shows the blocked-site page for the private report", async () => {
    const tab = await world.openTab(world.briefingUrl);
    await user.see({ placeholder: "Enter URL..." }, { timeoutMs: 30_000 });
    expect(tab.label).toBe("Project briefing");
    expect(tab.loadError).toBeNull();
    await user.type({ placeholder: "Enter URL..." }, world.reportUrl, { replace: true });
    await user.press("Enter");
    await user.see({ testId: "browser-blocked-site" }, { timeoutMs: 30_000 });
    await user.see({ text: "Your organization doesn't allow you to view this site." });
    const served = await world.servedPages();
    evidence.recordAssertionEvidence("the built-in browser", `briefing: ${tab.label}; pages served: ${served.join(", ")}`,
      served.includes("/briefing") && !served.includes("/private-report"));
    expect(served).toContain("/briefing");
    expect(served).not.toContain("/private-report");
    await user.screenshot();
  });

  await step("the owner allows local skills and local MCP servers for Contractors, and Riley's OpenWork drops both blocks", async () => {
    await world.saveContractors({ ...contractorDesktopPermissions, localSkills: { decision: "allow" }, localMcpServers: { decision: "allow" } });
    const rules = await probe.eventually(async () => local(await world.enforcedRules()), {
      within: 60_000, label: "Riley's OpenWork no longer blocks local skills or MCP servers", until: (found) => found.length === 0,
    });
    evidence.recordAssertionEvidence("local skill and MCP server rules after the change", rules.join("; ") || "none", rules.length === 0);
    expect(rules).toEqual([]);
  });

  await step("after: the folder's MCP server connects, and the agent loads the checklist skill", async () => {
    const notes = await probe.eventually(() => world.notesServerStatus(), {
      within: 120_000, label: "the folder's MCP server connects", until: (status) => status === "connected",
    });
    const prompt = `Follow the team checklist again. ${randomUUID()}`;
    await world.prepareTurn(prompt, `Checklist loaded. ${randomUUID()}`, loadSkill(skill.name), "last-tool-text");
    await send(prompt);
    await user.see({ text: new RegExp(skill.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }, { timeoutMs: 120_000 });
    const call = (await world.toolCalls("skill", isSkill(skill.name))).find((entry) => entry.status === "completed") ?? null;
    const servers = await world.mcpServers();
    evidence.recordAssertionEvidence("local skills and MCP servers once allowed", `notes-server: ${String(notes)}; OpenWork Cloud: ${String(servers["openwork-cloud"])}; team-checklist skill: ${call?.status ?? "none"}`,
      notes === "connected" && call?.status === "completed");
    expect(notes).toBe("connected");
    expect(call?.status).toBe("completed");
    expect(servers["openwork-cloud"]).not.toBe("disabled");
    await user.screenshot();
  });
});
