import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentPermissionTryResult, agentRule, saveAgentPermissions, openTeamAgentsTab, agentPermissionRowShape } from "@openwork/behaviors";
import { agentPermissionsEditor, agentPermissionsTwoTeams } from "../worlds/agent-permissions.ts";

// How Everyone's and each team's agent permissions combine into the rules a
// member's desktop app receives (agent-permissions-editor is the admin's journey).
const editorTest = spec.world(agentPermissionsEditor, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const twoTeamsTest = spec.world(agentPermissionsTwoTeams, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

editorTest("Everyone's permissions reach every member, and a team's own choice replaces Everyone's while the blocked lists still apply", async ({ world, user, step, probe }) => {
  const owner = user.on(world.web);
  const everyoneRules = [
    agentRule("shell", "*", "ask", "Everyone"),
    agentRule("shell", "rm *", "deny", "Everyone"),
    agentRule("webfetch", "*", "deny", "Everyone"),
    agentRule("webfetch", "docs.example.com", "allow", "Everyone"),
    agentRule("websearch", "*", "deny", "Everyone"),
  ];

  await step("before: nobody has agent permissions yet", async () => {
    await owner.see({ testId: "agent-permissions-intro" }, { text: "What agents can do on every member's computer. A team can change any row on its own Agents tab.", timeoutMs: 90_000 });
    const [riley, morgan] = [await world.receivedRules("riley"), await world.receivedRules("morgan")];
    expect([riley, morgan]).toEqual([[], []]);
    await owner.screenshot();
  });

  await step("the owner asks first before any command and blocks rm, blocks websites except the docs site, turns web search off for everyone, and saves, told desktop apps can take up to 5 minutes to pick it up", async () => {
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Ask first" });
    await owner.click({ testId: "agent-permission-commands-block-add" });
    await owner.type({ testId: "agent-permission-commands-block-input" }, "rm *");
    await owner.press("Enter");
    await owner.click({ role: "button", label: "Open websites" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-websites-allow-add" });
    await owner.type({ testId: "agent-permission-websites-allow-input" }, "docs.example.com");
    await owner.press("Enter");
    await owner.click({ role: "switch", label: "Search the web" });
    await owner.see({ testId: "agent-permissions-save-bar" }, { text: /^3 changes for Everyone/ });
    await owner.see({ testId: "agent-permissions-propagation-note" }, { text: "Members' desktop apps can take up to 5 minutes to pick up changes." });
    await owner.screenshot();
    await saveAgentPermissions(owner, probe);
  });

  await step("on Contractors' Agents tab, Everyone's blocked command shows as locked and the team blocks commands except echo", async () => {
    await openTeamAgentsTab(owner, "Contractors");
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 30_000 });
    await owner.see({ label: "rm *, set for Everyone" });
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Block" });
    await owner.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Contractors/ });
    await owner.click({ testId: "agent-permission-commands-allow-add" });
    await owner.type({ testId: "agent-permission-commands-allow-input" }, "echo *");
    await owner.press("Enter");
    await owner.see({ testId: "agent-permissions-save-bar" }, { text: /^1 change for Contractors/ });
    await owner.screenshot();
  });

  await step("after: Morgan receives Everyone's rules and Riley the team's choice with Everyone's blocked list last", async () => {
    await saveAgentPermissions(owner, probe);
    const morgan = await world.receivedRules("morgan");
    const riley = await world.receivedRules("riley");
    const rileyRules = [
      agentRule("shell", "*", "deny", "Contractors"),
      agentRule("shell", "echo *", "allow", "Contractors"),
      agentRule("shell", "rm *", "deny", "Everyone"),
      ...everyoneRules.slice(2),
    ];
    expect(morgan).toEqual(everyoneRules);
    expect(riley).toEqual(rileyRules);
    await owner.screenshot();
  });
});

twoTeamsTest("a member in two teams gets the strictest decision of the two, and both teams' lists", async ({ world, user, step, probe }) => {
  const owner = user.on(world.web);
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });

  await step("before: Contractors blocks commands except echo, and Riley, also in Engineering, receives that", async () => {
    await owner.reload();
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 90_000 });
    const received = await world.receivedRules("riley");
    const expected = [agentRule("shell", "*", "deny", "Contractors"), agentRule("shell", "echo *", "allow", "Contractors")];
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("Everyone turns web search off and Contractors turns it on: Engineering changes nothing of its own, so Riley keeps Everyone's block", async () => {
    await world.save({ webSearch: { decision: "deny" } });
    await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] }, webSearch: { decision: "allow" } });
    const received = await world.receivedRules("riley");
    const searchRules = received?.filter((entry) => entry.action === "websearch") ?? null;
    expect(searchRules).toEqual([agentRule("websearch", "*", "deny", "Everyone")]);
    await world.save({});
    await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });
  });

  await step("on Engineering's Agents tab the owner allows commands, but always blocks git push", async () => {
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Allow" });
    await owner.click({ testId: "agent-permission-commands-block-add" });
    await owner.type({ testId: "agent-permission-commands-block-input" }, "git push *");
    await owner.press("Enter");
    await saveAgentPermissions(owner, probe);
    await owner.screenshot();
  });

  await step("after: Riley still cannot run other commands, Contractors' Block being stricter, and git push is blocked too", async () => {
    const received = await world.receivedRules("riley");
    const expected = [
      agentRule("shell", "*", "deny", "Contractors"),
      agentRule("shell", "echo *", "allow", "Contractors"),
      agentRule("shell", "git push *", "deny", "Engineering"),
    ];
    expect(received).toEqual(expected);
  });
});

editorTest("the editor refuses a website it cannot match, and discarding keeps what was saved", async ({ world, user, probe, step }) => {
  const owner = user.on(world.web);
  const tryResult = () => agentPermissionTryResult(probe);

  await step("before: websites are allowed for everyone", async () => {
    await owner.see({ testId: "agent-permission-websites" }, { text: /Allow/, timeoutMs: 90_000 });
    await owner.screenshot();
  });
  await step("the owner blocks websites, and an address with a query is refused with what to enter instead", async () => {
    await owner.click({ role: "button", label: "Open websites" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-websites-allow-add" });
    await owner.type({ testId: "agent-permission-websites-allow-input" }, "https://docs.example.com/guides?page=2");
    await owner.press("Enter");
    await owner.see({ text: "Enter a site like docs.example.com, *.example.com or example.com/docs." });
    await owner.screenshot();
  });

  await step("a site with its subdomains and a path is accepted, and trying addresses shows which open", async () => {
    await owner.type({ testId: "agent-permission-websites-allow-input" }, "*.example.com/guides", { replace: true });
    await owner.press("Enter");
    await owner.see({ testId: "agent-permission-websites-allow" }, { text: /\*\.example\.com\/guides/ });
    await owner.click({ role: "button", label: "Request type" });
    await owner.click({ role: "option", label: "Website" });
    await owner.type({ testId: "agent-permission-try-input" }, "https://api.example.com/guides/setup");
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Allowed/ });
    const allowed = await tryResult();
    await owner.type({ testId: "agent-permission-try-input" }, "https://example.org/", { replace: true });
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Blocked/ });
    const blocked = await tryResult();
    expect(allowed).toContain('Matches "*.example.com/guides" for Everyone');
    expect(blocked).toContain("Open websites is set to Block for Everyone");
    await owner.screenshot();
  });

  await step("after: discarding returns websites to Allow, and members' apps still receive no rules", async () => {
    await owner.click({ role: "button", label: "Discard" });
    await owner.notSee({ testId: "agent-permissions-save-bar" });
    await owner.see({ testId: "agent-permission-websites" }, { text: /Allow/ });
    const received = await world.receivedRules("morgan");
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

editorTest("blocking file edits blocks every command too, and the editor says why", async ({ world, user, probe, step }) => {
  const owner = user.on(world.web);

  await step("before: commands and file edits are allowed for everyone, and echo would run", async () => {
    await owner.see({ testId: "agent-permission-try-input" }, { timeoutMs: 90_000 });
    await owner.type({ testId: "agent-permission-try-input" }, "echo done");
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Allowed/ });
    await owner.notSee({ testId: "agent-permission-commands-blocked-by-edits" });
    await owner.screenshot();
  });

  await step("after: with Edit files blocked, Run commands says it is blocked too and echo would be blocked", async () => {
    await owner.click({ role: "button", label: "Edit files" });
    await owner.click({ role: "option", label: "Block" });
    await owner.see({ testId: "agent-permission-commands-blocked-by-edits" }, { text: "Blocked while Edit files is blocked, because any command can change files." });
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Blocked/ });
    await saveAgentPermissions(owner, probe);
    const received = await world.receivedRules("morgan");
    const expected = [agentRule("edit", "*", "deny", "Everyone"), agentRule("shell", "*", "deny", "Everyone")];
    expect(received).toEqual(expected);
    await owner.screenshot();
  });
});

editorTest("local skills and local MCP servers are Allowed or Blocked switches, and a team can override Everyone's and go back", async ({ world, user, probe, step }) => {
  const owner = user.on(world.web);
  const row = (key: string) => agentPermissionRowShape(probe, key);

  await step("before: Everyone's local skills and local MCP servers are allowed, each one switch with no lists and no Ask first", async () => {
    await owner.see({ testId: "agent-permissions-editor" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "agent-permission-localSkills" }, { text: /Use local skills/ });
    await owner.see({ testId: "agent-permission-localMcpServers" }, { text: /Use local MCP servers/ });
    const [skills, servers] = [await row("localSkills"), await row("localMcpServers")];
    for (const entry of [skills, servers]) {
      expect(entry).toMatchObject({ switches: 1, picklists: 0, lists: 0 });
      expect(entry.text).not.toMatch(/Always|Ask first/);
    }
    await owner.screenshot();
  });

  await step("the owner blocks local skills and local MCP servers for everyone, and members receive one rule for each", async () => {
    await owner.click({ role: "switch", label: "Use local skills" });
    await owner.click({ role: "switch", label: "Use local MCP servers" });
    await owner.see({ testId: "agent-permission-localSkills" }, {});
    await owner.see({ testId: "agent-permission-localMcpServers" }, {});
    await owner.notSee({ testId: "agent-permission-localSkills-lists" });
    await saveAgentPermissions(owner, probe);
    const received = await world.receivedRules("morgan");
    const expected = [agentRule("skill", "*", "deny", "Everyone"), agentRule("mcp", "*", "deny", "Everyone")];
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("Contractors turn local MCP servers back on: the row shows Changed for Contractors and Riley's MCP servers are allowed", async () => {
    await openTeamAgentsTab(owner, "Contractors");
    await owner.see({ testId: "agent-permission-localMcpServers-source" }, { text: "From Everyone" });
    await owner.see({ testId: "agent-permission-localMcpServers" }, {});
    await owner.click({ role: "switch", label: "Use local MCP servers" });
    await owner.see({ testId: "agent-permission-localMcpServers-source" }, { text: /Changed for Contractors/ });
    await owner.see({ testId: "agent-permission-localMcpServers" }, {});
    await saveAgentPermissions(owner, probe);
    const received = await world.receivedRules("riley");
    // A team's Allow adds no rule: Everyone's block on local MCP servers no longer applies to Riley.
    const expected = [agentRule("skill", "*", "deny", "Everyone")];
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("after: the reset shows Everyone's Blocked again, and discarding keeps the team's override", async () => {
    await owner.click({ role: "button", label: "Use Everyone's setting for Use local MCP servers" });
    await owner.see({ testId: "agent-permission-localMcpServers-source" }, { text: "From Everyone" });
    await owner.see({ testId: "agent-permission-localMcpServers" }, {});
    await owner.screenshot();
    await owner.click({ role: "button", label: "Discard" });
    await owner.see({ testId: "agent-permission-localMcpServers-source" }, { text: /Changed for Contractors/ });
    const received = await world.receivedRules("riley");
    expect(received).toEqual([agentRule("skill", "*", "deny", "Everyone")]);
  });
});
