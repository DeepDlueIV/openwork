import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  agentPermissionsAdminView,
  agentPermissionsEditor,
  agentPermissionsFeatureOff,
  agentPermissionsSales,
  agentPermissionsTeamTab,
  agentPermissionsTwoTeams,
} from "../worlds/agent-permissions.ts";

const editorTest = spec.world(agentPermissionsEditor, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const teamTabTest = spec.world(agentPermissionsTeamTab, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const salesTest = spec.world(agentPermissionsSales, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const twoTeamsTest = spec.world(agentPermissionsTwoTeams, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const adminViewTest = spec.world(agentPermissionsAdminView, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const featureOffTest = spec.world(agentPermissionsFeatureOff, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

type Rule = { action: string; resource: string; effect: string; source: string };
const rule = (action: string, resource: string, effect: string, source: string): Rule => ({ action, resource, effect, source });

function describeRules(rules: Record<string, unknown>[] | null): string {
  if (rules === null) return "no agent permissions";
  return rules.map((entry) => `${String(entry.action)} ${String(entry.resource)} → ${String(entry.effect)} (${String(entry.source)})`).join("; ") || "none";
}

salesTest("an admin makes Sales agents ask before running commands, and undoes it later", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const status = async (key: string) => (await probe.dom(`[data-testid="agent-permission-${key}-source"]`)).elements.map((element) => element.text).join(" ").trim();
  const askRules = [rule("shell", "*", "ask", "Sales")];

  await step("before: on Sales' Agents tab, Run commands follows Everyone and Riley's app receives no rules", async () => {
    await admin.click({ role: "link", label: "Sales" });
    await admin.click({ role: "tab", label: "Agents" });
    await admin.see({ testId: "agent-permissions-intro" }, { text: "What agents can do on the computers of people in Sales. Rows you don't change follow Everyone.", timeoutMs: 90_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Run commands for Sales, and Riley's rules", `${await status("commands")}; Riley: ${describeRules(received)}`, received?.length === 0);
    expect(received).toEqual([]);
    await admin.screenshot();
  });

  await step("the admin sets Run commands to Ask first: the row says it changed for Sales and the save bar counts one change", async () => {
    await admin.click({ role: "button", label: "Run commands" });
    await admin.click({ role: "option", label: "Ask first" });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Sales/ });
    await admin.see({ testId: "agent-permissions-save-bar" }, { text: /^1 change for Sales\. Members' apps pick them up the next time they refresh\./ });
    evidence.recordAssertionEvidence("Run commands' status", await status("commands"), (await status("commands")).startsWith("Changed for Sales"));
    await admin.screenshot();
  });

  await step("after saving: Riley, in Sales, is asked before commands run, and Morgan, in no team, is not", async () => {
    await admin.click({ role: "button", label: "Save changes" });
    await admin.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const riley = await world.receivedRules("riley");
    const morgan = await world.receivedRules("morgan");
    evidence.recordAssertionEvidence("rules after saving", `Riley: ${describeRules(riley)}; Morgan: ${describeRules(morgan)}`,
      JSON.stringify(riley) === JSON.stringify(askRules) && morgan?.length === 0);
    expect(riley).toEqual(askRules);
    expect(morgan).toEqual([]);
    await admin.screenshot();
  });

  await step("later, Reset to Everyone asks first and names what Sales loses", async () => {
    await admin.reload();
    await admin.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Sales/, timeoutMs: 60_000 });
    await admin.click({ testId: "agent-permissions-reset" });
    await admin.see({ text: "Reset Sales to Everyone's agent permissions?" });
    await admin.see({ text: "Sales loses its 1 change: Run commands. People in Sales get Everyone's rules the next time their apps refresh." });
    const stillAsks = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("nothing changes until the admin confirms", `Riley: ${describeRules(stillAsks)}`, JSON.stringify(stillAsks) === JSON.stringify(askRules));
    expect(stillAsks).toEqual(askRules);
    await admin.screenshot();
  });

  await step("after the reset: Run commands follows Everyone again and Riley's app receives no rules", async () => {
    await admin.click({ testId: "agent-permissions-reset-confirm" });
    await admin.see({ text: "Sales reset to Everyone" }, { timeoutMs: 30_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 30_000 });
    await admin.notSee({ testId: "agent-permissions-reset" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after the reset", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await admin.screenshot();
  });

  await step("Undo on the confirmation puts Sales' change back", async () => {
    await admin.click({ role: "button", label: "Undo" });
    await admin.see({ text: "Changes for Sales restored" }, { timeoutMs: 30_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Sales/, timeoutMs: 30_000 });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after Undo", describeRules(received), JSON.stringify(received) === JSON.stringify(askRules));
    expect(received).toEqual(askRules);
    await admin.screenshot();
  });
});

teamTabTest("an owner changes Contractors' agent permissions on the team's Agents tab, and only that team's members receive the rule", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const tryResult = async () => (await probe.dom('[data-testid="agent-permission-try-result"]')).elements.map((element) => element.text).join(" ").trim();

  await step("before: every row on Contractors' Agents tab follows Everyone and Riley's app receives no rules", async () => {
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 90_000 });
    await owner.notSee({ testId: "agent-permissions-reset" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's desktop config", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });

  await step("the owner blocks commands for Contractors except echo, and trying rm -rf build shows it would be blocked", async () => {
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-commands-allow-add" });
    await owner.type({ testId: "agent-permission-commands-allow-input" }, "echo *");
    await owner.press("Enter");
    await owner.type({ testId: "agent-permission-try-input" }, "rm -rf build");
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Blocked/ });
    const blocked = await tryResult();
    await owner.type({ testId: "agent-permission-try-input" }, "echo done", { replace: true });
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Allowed/ });
    const allowed = await tryResult();
    evidence.recordAssertionEvidence("trying requests before saving", `rm -rf build → ${blocked}; echo done → ${allowed}`, blocked.startsWith("Blocked") && allowed.startsWith("Allowed"));
    expect(blocked).toContain("Run commands is set to Block for Contractors");
    expect(allowed).toContain('Matches "echo *" for Contractors');
    await owner.see({ testId: "agent-permissions-save-bar" }, { text: /^1 change for Contractors/ });
    await owner.screenshot();
  });

  await step("after: the owner saves, and Riley's app receives the rules in order", async () => {
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const received = await world.receivedRules("riley");
    const expected = [rule("shell", "*", "deny", "Contractors"), rule("shell", "echo *", "allow", "Contractors")];
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("Everyone's tab shows the row changed for Contractors, a member outside the team receives no rules, and a member cannot change the permissions", async () => {
    await owner.click({ testId: "agent-permissions-open-everyone" });
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "Changed for Contractors", timeoutMs: 30_000 });
    const outside = await world.receivedRules("morgan");
    const status = await world.memberSaveStatus();
    evidence.recordAssertionEvidence("boundaries", `Morgan: ${describeRules(outside)}; Riley saving everyone's permissions → HTTP ${status}`, outside?.length === 0 && status === 403);
    expect(outside).toEqual([]);
    expect(status).toBe(403);
    await owner.screenshot();
  });
});

editorTest("Everyone's permissions reach every member, and a team's own choice replaces Everyone's while the blocked lists still apply", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  const everyoneRules = [
    rule("shell", "*", "ask", "Everyone"),
    rule("shell", "rm *", "deny", "Everyone"),
    rule("webfetch", "*", "deny", "Everyone"),
    rule("webfetch", "docs.example.com", "allow", "Everyone"),
    rule("websearch", "*", "deny", "Everyone"),
  ];

  await step("before: nobody has agent permissions yet", async () => {
    await owner.see({ testId: "agent-permissions-intro" }, { text: "What agents can do on every member's computer. A team can change any row on its own Agents tab.", timeoutMs: 90_000 });
    const [riley, morgan] = [await world.receivedRules("riley"), await world.receivedRules("morgan")];
    evidence.recordAssertionEvidence("rules before", `Riley: ${describeRules(riley)}; Morgan: ${describeRules(morgan)}`, riley?.length === 0 && morgan?.length === 0);
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
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
  });

  await step("on Contractors' Agents tab, Everyone's blocked command shows as locked and the team blocks commands except echo", async () => {
    await owner.click({ role: "link", label: "Back" });
    await owner.click({ role: "link", label: "Contractors" });
    await owner.click({ role: "tab", label: "Agents" });
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
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const morgan = await world.receivedRules("morgan");
    const riley = await world.receivedRules("riley");
    const rileyRules = [
      rule("shell", "*", "deny", "Contractors"),
      rule("shell", "echo *", "allow", "Contractors"),
      rule("shell", "rm *", "deny", "Everyone"),
      ...everyoneRules.slice(2),
    ];
    evidence.recordAssertionEvidence("Morgan's rules (no team)", describeRules(morgan), JSON.stringify(morgan) === JSON.stringify(everyoneRules));
    evidence.recordAssertionEvidence("Riley's rules (Contractors)", describeRules(riley), JSON.stringify(riley) === JSON.stringify(rileyRules));
    expect(morgan).toEqual(everyoneRules);
    expect(riley).toEqual(rileyRules);
    await owner.screenshot();
  });
});

twoTeamsTest("a member in two teams gets the strictest decision of the two, and both teams' lists", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });

  await step("before: Contractors blocks commands except echo, and Riley, also in Engineering, receives that", async () => {
    await owner.reload();
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 90_000 });
    const received = await world.receivedRules("riley");
    const expected = [rule("shell", "*", "deny", "Contractors"), rule("shell", "echo *", "allow", "Contractors")];
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("Everyone turns web search off and Contractors turns it on: Engineering changes nothing of its own, so Riley keeps Everyone's block", async () => {
    await world.save({ webSearch: { decision: "deny" } });
    await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] }, webSearch: { decision: "allow" } });
    const received = await world.receivedRules("riley");
    const searchRules = received?.filter((entry) => entry.action === "websearch") ?? null;
    evidence.recordAssertionEvidence("Riley's web search rules", describeRules(searchRules), JSON.stringify(searchRules) === JSON.stringify([rule("websearch", "*", "deny", "Everyone")]));
    expect(searchRules).toEqual([rule("websearch", "*", "deny", "Everyone")]);
    await world.save({});
    await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });
  });

  await step("on Engineering's Agents tab the owner allows commands, but always blocks git push", async () => {
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Allow" });
    await owner.click({ testId: "agent-permission-commands-block-add" });
    await owner.type({ testId: "agent-permission-commands-block-input" }, "git push *");
    await owner.press("Enter");
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    await owner.screenshot();
  });

  await step("after: Riley still cannot run other commands, Contractors' Block being stricter, and git push is blocked too", async () => {
    const received = await world.receivedRules("riley");
    const expected = [
      rule("shell", "*", "deny", "Contractors"),
      rule("shell", "echo *", "allow", "Contractors"),
      rule("shell", "git push *", "deny", "Engineering"),
    ];
    evidence.recordAssertionEvidence("Riley's rules (Contractors and Engineering)", describeRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
  });
});

teamTabTest("an owner undoes a save, and Use Everyone's puts one row back without touching the rest", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  const contractorRules = [rule("shell", "*", "deny", "Contractors"), rule("shell", "echo *", "allow", "Contractors")];
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });

  await step("before: Contractors blocks commands except echo", async () => {
    await owner.reload();
    await owner.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Contractors/, timeoutMs: 90_000 });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), JSON.stringify(received) === JSON.stringify(contractorRules));
    expect(received).toEqual(contractorRules);
    await owner.screenshot();
  });

  await step("the owner turns web search off for Contractors, saves, and undoes it from the confirmation", async () => {
    await owner.click({ role: "switch", label: "Search the web" });
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const saved = await world.receivedRules("riley");
    await owner.click({ role: "button", label: "Undo" });
    await owner.see({ text: "Agent permissions restored" }, { timeoutMs: 30_000 });
    const restored = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after save, then undo", `${describeRules(saved)} → ${describeRules(restored)}`,
      saved?.some((entry) => entry.action === "websearch") === true && JSON.stringify(restored) === JSON.stringify(contractorRules));
    expect(saved).toContainEqual(rule("websearch", "*", "deny", "Contractors"));
    expect(restored).toEqual(contractorRules);
    await owner.screenshot();
  });

  await step("after: Use Everyone's on Run commands puts that row back, and once saved Riley receives no rules", async () => {
    await owner.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Contractors/, timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Use Everyone's setting for Run commands" });
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone" });
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

editorTest("the editor refuses a website it cannot match, and discarding keeps what was saved", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const tryResult = async () => (await probe.dom('[data-testid="agent-permission-try-result"]')).elements.map((element) => element.text).join(" ").trim();

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
    evidence.recordAssertionEvidence("trying websites", `api.example.com/guides/setup → ${allowed}; example.org → ${blocked}`, allowed.startsWith("Allowed") && blocked.startsWith("Blocked"));
    expect(allowed).toContain('Matches "*.example.com/guides" for Everyone');
    expect(blocked).toContain("Open websites is set to Block for Everyone");
    await owner.screenshot();
  });

  await step("after: discarding returns websites to Allow, and members' apps still receive no rules", async () => {
    await owner.click({ role: "button", label: "Discard" });
    await owner.notSee({ testId: "agent-permissions-save-bar" });
    await owner.see({ testId: "agent-permission-websites" }, { text: /Allow/ });
    const received = await world.receivedRules("morgan");
    evidence.recordAssertionEvidence("Morgan's rules", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

editorTest("blocking file edits blocks every command too, and the editor says why", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const tryResult = async () => (await probe.dom('[data-testid="agent-permission-try-result"]')).elements.map((element) => element.text).join(" ").trim();

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
    const blocked = await tryResult();
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const received = await world.receivedRules("morgan");
    const expected = [rule("edit", "*", "deny", "Everyone"), rule("shell", "*", "deny", "Everyone")];
    evidence.recordAssertionEvidence("Morgan's rules with file edits blocked", `${describeRules(received)}; trying echo done → ${blocked}`,
      JSON.stringify(received) === JSON.stringify(expected) && blocked.startsWith("Blocked"));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });
});

adminViewTest("an admin who is not an owner can read a team's agent permissions but not change them, and a member cannot open them", async ({ world, user, step, evidence }) => {
  const admin = user.on(world.web);

  await step("Morgan, an admin, sees Contractors' Agents tab with every control locked and no reset", async () => {
    await admin.see({ text: "Read only. Needs the “Manage agent permissions” permission. Ask the organization owner." }, { timeoutMs: 90_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: "Changed for Contractors" });
    await admin.notSee({ testId: "agent-permissions-reset" });
    await admin.notSee({ role: "button", label: "Use Everyone's setting for Run commands" });
    const controls = await world.permissionControls();
    evidence.recordAssertionEvidence("the permission controls for an admin", `${controls.disabled} of ${controls.count} disabled`, controls.count === 6 && controls.disabled === 6);
    expect(controls).toEqual({ count: 6, disabled: 6 });
    await admin.screenshot();
  });

  await step("the API refuses Morgan's change, and refuses Riley, a member, even reading the permissions", async () => {
    const adminSave = await world.saveStatus("morgan");
    const memberRead = await world.readStatus("riley");
    const ownerRead = await world.readStatus("owner");
    evidence.recordAssertionEvidence("who may do what", `Morgan saving → HTTP ${adminSave}; Riley reading → HTTP ${memberRead}; Avery reading → HTTP ${ownerRead}`,
      adminSave === 403 && memberRead === 403 && ownerRead === 200);
    expect([adminSave, memberRead, ownerRead]).toEqual([403, 403, 200]);
  });
});

featureOffTest("agent permissions stay off until a platform admin turns them on for the organization", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);

  await step("before: the team's Agents tab shows Agent permissions as an Enterprise feature, and the API and members' apps have none", async () => {
    await owner.see({ testId: "agent-permissions-feature-off" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Agent permissions is an Enterprise feature" });
    await owner.see({ text: "Contact us to turn it on for your organization." });
    const read = await world.readStatus("owner");
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("while off", `GET /v1/agent-permissions → HTTP ${read}; Riley: ${describeRules(received)}`, read === 404 && received === null);
    expect(read).toBe(404);
    expect(received).toBeNull();
    await owner.screenshot();
  });

  await step("after: once it is on, the owner sees the editor, and members' apps receive empty rules", async () => {
    await world.enableFeature();
    await owner.reload();
    await owner.see({ testId: "agent-permissions-editor" }, { timeoutMs: 60_000 });
    const read = await world.readStatus("owner");
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("once on", `GET /v1/agent-permissions → HTTP ${read}; Riley: ${describeRules(received)}`, read === 200 && received?.length === 0);
    expect(read).toBe(200);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});
