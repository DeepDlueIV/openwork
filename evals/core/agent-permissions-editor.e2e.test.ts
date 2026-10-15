import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentPermissionTryResult, agentRule, describeAgentRules, saveAgentPermissions } from "@openwork/behaviors";
import { agentPermissionsAdminView, agentPermissionsFeatureOff, agentPermissionsSales, agentPermissionsTeamTab } from "../worlds/agent-permissions.ts";

// An admin changes what a team's agents may do on the team's Agents tab, and
// undoes it; how Everyone's and teams' rules combine is agent-permissions-editor-rules.
const salesTest = spec.world(agentPermissionsSales, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const teamTabTest = spec.world(agentPermissionsTeamTab, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const adminViewTest = spec.world(agentPermissionsAdminView, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const featureOffTest = spec.world(agentPermissionsFeatureOff, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

salesTest("an admin makes Sales agents ask before running commands, and undoes it later", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const status = async (key: string) => (await probe.dom(`[data-testid="agent-permission-${key}-source"]`)).elements.map((element) => element.text).join(" ").trim();
  const askRules = [agentRule("shell", "*", "ask", "Sales")];

  await step("before: on Sales' Agents tab, Run commands follows Everyone and Riley's app receives no rules", async () => {
    await admin.click({ role: "link", label: "Sales" });
    await admin.click({ role: "tab", label: "Agents" });
    await admin.see({ testId: "agent-permissions-intro" }, { text: "What agents can do on the computers of people in Sales. Rows you don't change follow Everyone.", timeoutMs: 90_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Run commands for Sales, and Riley's rules", `${await status("commands")}; Riley: ${describeAgentRules(received)}`, received?.length === 0);
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
    await saveAgentPermissions(admin, probe);
    const riley = await world.receivedRules("riley");
    const morgan = await world.receivedRules("morgan");
    evidence.recordAssertionEvidence("rules after saving", `Riley: ${describeAgentRules(riley)}; Morgan: ${describeAgentRules(morgan)}`,
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
    evidence.recordAssertionEvidence("nothing changes until the admin confirms", `Riley: ${describeAgentRules(stillAsks)}`, JSON.stringify(stillAsks) === JSON.stringify(askRules));
    expect(stillAsks).toEqual(askRules);
    await admin.screenshot();
  });

  await step("after the reset: Run commands follows Everyone again and Riley's app receives no rules", async () => {
    await admin.click({ testId: "agent-permissions-reset-confirm" });
    await admin.see({ text: "Sales reset to Everyone" }, { timeoutMs: 30_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 30_000 });
    await admin.notSee({ testId: "agent-permissions-reset" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after the reset", describeAgentRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await admin.screenshot();
  });

  await step("Undo on the confirmation puts Sales' change back", async () => {
    await admin.click({ role: "button", label: "Undo" });
    await admin.see({ text: "Changes for Sales restored" }, { timeoutMs: 30_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Sales/, timeoutMs: 30_000 });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after Undo", describeAgentRules(received), JSON.stringify(received) === JSON.stringify(askRules));
    expect(received).toEqual(askRules);
    await admin.screenshot();
  });
});

teamTabTest("an owner changes Contractors' agent permissions on the team's Agents tab, and only that team's members receive the rule", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const tryResult = () => agentPermissionTryResult(probe);

  await step("before: every row on Contractors' Agents tab follows Everyone and Riley's app receives no rules", async () => {
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone", timeoutMs: 90_000 });
    await owner.notSee({ testId: "agent-permissions-reset" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's desktop config", describeAgentRules(received), received?.length === 0);
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
    await saveAgentPermissions(owner, probe);
    const received = await world.receivedRules("riley");
    const expected = [agentRule("shell", "*", "deny", "Contractors"), agentRule("shell", "echo *", "allow", "Contractors")];
    evidence.recordAssertionEvidence("Riley's rules", describeAgentRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("Everyone's tab shows the row changed for Contractors, a member outside the team receives no rules, and a member cannot change the permissions", async () => {
    await owner.click({ testId: "agent-permissions-open-everyone" });
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "Changed for Contractors", timeoutMs: 30_000 });
    const outside = await world.receivedRules("morgan");
    const status = await world.memberSaveStatus();
    evidence.recordAssertionEvidence("boundaries", `Morgan: ${describeAgentRules(outside)}; Riley saving everyone's permissions → HTTP ${status}`, outside?.length === 0 && status === 403);
    expect(outside).toEqual([]);
    expect(status).toBe(403);
    await owner.screenshot();
  });
});

teamTabTest("an owner undoes a save, and Use Everyone's puts one row back without touching the rest", async ({ world, user, step, evidence, probe }) => {
  const owner = user.on(world.web);
  const contractorRules = [agentRule("shell", "*", "deny", "Contractors"), agentRule("shell", "echo *", "allow", "Contractors")];
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });

  await step("before: Contractors blocks commands except echo", async () => {
    await owner.reload();
    await owner.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Contractors/, timeoutMs: 90_000 });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", describeAgentRules(received), JSON.stringify(received) === JSON.stringify(contractorRules));
    expect(received).toEqual(contractorRules);
    await owner.screenshot();
  });

  await step("the owner turns web search off for Contractors, saves, and undoes it from the confirmation", async () => {
    await owner.click({ role: "switch", label: "Search the web" });
    await saveAgentPermissions(owner, probe);
    const saved = await world.receivedRules("riley");
    await owner.click({ role: "button", label: "Undo" });
    await owner.see({ text: "Agent permissions restored" }, { timeoutMs: 30_000 });
    const restored = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after save, then undo", `${describeAgentRules(saved)} → ${describeAgentRules(restored)}`,
      saved?.some((entry) => entry.action === "websearch") === true && JSON.stringify(restored) === JSON.stringify(contractorRules));
    expect(saved).toContainEqual(agentRule("websearch", "*", "deny", "Contractors"));
    expect(restored).toEqual(contractorRules);
    await owner.screenshot();
  });

  await step("after: Use Everyone's on Run commands puts that row back, and once saved Riley receives no rules", async () => {
    await owner.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Contractors/, timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Use Everyone's setting for Run commands" });
    await owner.see({ testId: "agent-permission-commands-source" }, { text: "From Everyone" });
    await saveAgentPermissions(owner, probe);
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", describeAgentRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

adminViewTest("an admin who is not an owner can read a team's agent permissions but not change them, and a member cannot open them", async ({ world, user, step, evidence }) => {
  const admin = user.on(world.web);

  await step("Morgan, an admin, sees Contractors' Agents tab with every control locked and no reset", async () => {
    await admin.see({ text: "Read only. Needs the “Manage agent permissions” permission. Ask the organization owner." }, { timeoutMs: 90_000 });
    await admin.see({ testId: "agent-permission-commands-source" }, { text: /Changed for Contractors/ });
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
    evidence.recordAssertionEvidence("while off", `GET /v1/agent-permissions → HTTP ${read}; Riley: ${describeAgentRules(received)}`, read === 404 && received === null);
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
    evidence.recordAssertionEvidence("once on", `GET /v1/agent-permissions → HTTP ${read}; Riley: ${describeAgentRules(received)}`, read === 200 && received?.length === 0);
    expect(read).toBe(200);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});
