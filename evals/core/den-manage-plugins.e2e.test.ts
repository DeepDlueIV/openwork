import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { callMcpTool, fillPluginWithSkill, mintMcpToken, pluginIdNamed, pluginSkillAsAgent, pluginSkillCapabilities, sharePluginWithMember } from "@openwork/behaviors";
import { isRecord, records } from "../worlds/library.ts";
import { denManagePluginsAsAdmin } from "../worlds/den-library-manage.ts";

// Admins build a plugin once in Manage and choose which teams get it.
const test = spec.world(denManagePluginsAsAdmin, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });

const names = (items: { name: string }[]) => items.map((item) => item.name);
const salesCallPrep = { name: "Sales call prep", description: "Get ready for a sales call" };
const prepSkill = { name: "Prep a sales call", whenToUse: "Before any call with a customer", steps: "Read the account notes, then list three questions to ask." };

test("an admin: I want to give the Sales team a plugin so they all get the same skills", async ({ world, user, probe, step }) => {
  const reach = world.teamSize("Sales");
  let directoryUrl = "";

  await step("1. I open Plugins in Manage: there are none yet", async () => {
    await user.see({ testId: "plugins-empty" }, { timeoutMs: 120_000 });
    await user.see({ text: "Create a plugin to share skills with your team." });
    await user.see({ text: "Only you can use it until you choose who gets access." });
    await user.notSee({ text: "GitHub" });
    expect((await probe.dom('a[href$="/plugins/new"]')).elements.filter((item) => item.text.includes("Create a plugin"))).toHaveLength(1);
    await user.screenshot();
  });

  await step("2. I create a plugin with the skill every sales call needs", async () => {
    await user.click({ role: "link", label: "Create a plugin" });
    await user.see({ testId: "plugin-create-form" }, { timeoutMs: 60_000 });
    await user.see({ text: "Nobody else gets it until you choose who can use it." });
    await fillPluginWithSkill(user, salesCallPrep, prepSkill);
    await user.screenshot();
  });

  await step("3. I create it: only I have it so far", async () => {
    await user.click({ role: "button", label: "Create plugin" });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ role: "heading", label: /Sales call prep$/ });
    await user.see({ text: "Off. Only you have it so far." });
    await user.see({ testId: "whats-inside" }, { text: /Prep a sales call/ });
    await user.notSee({ role: "link", label: "Share" });
    expect(names(await world.library(world.den.members.omar))).not.toContain("Sales call prep");
    await user.screenshot();
  });

  await step("4. I choose Add team and pick Sales", async () => {
    await user.click({ role: "button", label: "Add team" });
    await user.see({ placeholder: "Search teams" });
    await user.click({ role: "option", label: /Sales/ });
    await user.see({ text: "1 team selected" });
    await user.screenshot();
  });

  await step("5. I add Sales and they can use it right away", async () => {
    await user.click({ role: "button", label: "Add Sales" });
    await user.see({ testId: "den-toast" }, { text: /Sales can use it now/, timeoutMs: 60_000 });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${reach} people will find it in My Library\\.`) });
    await user.see({ testId: "access-team" }, { text: /Sales/ });
    await user.screenshot();
  });

  await step("6. I go back to Plugins and see who has it, loaded as one bounded page", async () => {
    const logStart = (await world.proxy.requestLog()).length;
    await user.click({ role: "link", label: "Plugins" });
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/, timeoutMs: 60_000 });
    // The row says Shared; its data-plugin-access attribute keeps who exactly has it.
    const shared = await probe.eventually(async () => (await probe.dom('[data-plugin-row="Sales call prep"][data-plugin-access="Sales"]')).elements.length, {
      within: 30_000, label: "who has the plugin", until: (count) => count === 1,
    });
    expect(shared).toBe(1);
    await user.see({ testId: "admin-plugins" }, { text: /Shared/ });
    const listCalls = (await world.proxy.requestLog()).slice(logStart).map((entry) => entry.path)
      .filter((path) => path.startsWith("/v1/plugins?") || /^\/v1\/plugins\/[^/?]+\/access/.test(path));
    expect(listCalls, "the directory fetches a bounded page with access").toContain("/v1/plugins?status=active&limit=50&includeAccess=true&includeTotal=true&includeFacets=true");
    expect(listCalls.some((path) => /\/access/.test(path))).toBe(false);
    await user.screenshot();
  });

  await step("after: I find the plugin by name and by Sales access, and the filter survives opening it", async () => {
    await user.type({ placeholder: "Filter by name" }, "Sales call");
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/ });
    await user.click({ role: "button", label: "Team" });
    await user.see({ text: "Plugins available to a team" });
    await user.click({ role: "button", label: "Sales" });
    await user.see({ role: "button", label: /Team: Sales/ });
    expect((await probe.dom("[data-plugin-row]")).elements).toHaveLength(1);
    directoryUrl = new URL(await world.location(), world.den.ref.webUrl).toString();
    await user.screenshot();
    await user.click({ role: "link", label: /Sales call prep/ });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.navigate(directoryUrl);
    await user.see({ role: "button", label: /Team: Sales/ });
    expect(await world.location()).toContain(`name=Sales+call&teamId=${world.teamIds.Sales}`);
  });

  await step("Owner filters the creator, not a person who was given access", async () => {
    expect(names(await world.library(world.den.members.omar))).toContain("Sales call prep");
    await user.click({ role: "button", label: "Owner" });
    await user.see({ text: "Plugins created by" });
    await user.click({ role: "button", label: "Omar Diaz" });
    await user.see({ text: "No plugins match. Try another name, team, or owner." });
    await user.screenshot();
    await user.click({ role: "button", label: /Owner: Omar Diaz/ });
    await user.click({ role: "button", label: "Riley Admin" });
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/ });
    expect((await probe.dom("[data-plugin-row]")).elements).toHaveLength(1);
    await user.reload();
    await user.see({ role: "button", label: /Owner: Riley Admin/ });
    await user.see({ role: "button", label: /Team: Sales/ });
    const inventory = await probe.api(world.den.admin, `/v1/plugins?status=active&includeTotal=true&includeFacets=true&teamId=${world.teamIds.Sales}`);
    if (!isRecord(inventory.body)) throw new Error("Plugin inventory is missing.");
    expect(inventory.body.total).toBe(1);
    expect(records(inventory.body.teamCounts).find((entry) => entry.id === world.teamIds.Sales)?.count).toBe(1);
    expect(records(inventory.body.ownerCounts).find((entry) => entry.id === world.memberIds.omar)).toBeUndefined();
    const matching = records(inventory.body.items)[0];
    expect(records(inventory.body.ownerCounts)).toContainEqual({ id: matching?.createdByOrgMembershipId, count: 1 });
    await user.screenshot();
  });

  await step("after: Omar and Tess in Sales find Sales call prep in My Library, and Kai, who is outside Sales, does not", async () => {
    for (const person of ["omar", "tess"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has the plugin`).toContain("Sales call prep");
    }
    expect(names(await world.library(world.den.members.kai)), "Kai is outside Sales").not.toContain("Sales call prep");
  });

  await step("after: Omar's agent loads the skill through OpenWork, Kai's cannot find or load it, and Omar cannot pass it on", async () => {
    const pluginId = await pluginIdNamed(world.den.admin, "Sales call prep");
    const omarToken = await mintMcpToken(world.den.members.omar);
    const [capability] = await pluginSkillCapabilities(world.den.ref, omarToken, pluginId);
    if (!capability) throw new Error("Omar's agent does not list the Sales call prep skill.");
    const loaded = await callMcpTool(world.den.ref, omarToken, "execute_capability", { name: capability });
    expect(loaded.isError).toBe(false);
    expect(loaded.text).toContain(prepSkill.steps);

    const kai = await pluginSkillAsAgent(world.den.ref, await mintMcpToken(world.den.members.kai), pluginId, capability, "Sales call prep");
    expect(kai.listed).toEqual([]);
    expect(kai.found).toBe(false);
    expect(kai.run.isError).toBe(true);
    expect(kai.run.body).toMatchObject({ error: "forbidden" });
    expect(kai.run.text.includes("Read the account notes")).toBe(false);
    expect(kai.get.isError).toBe(true);
    expect(kai.get.text.includes("Read the account notes")).toBe(false);

    const passedOn = await sharePluginWithMember(world.den.members.omar, pluginId, world.memberIds.kai);
    expect(passedOn.response.status).toBe(403);
    expect(names(await world.library(world.den.members.kai))).not.toContain("Sales call prep");
  });

  await step("a Sales member can use the plugin but cannot manage or remove it", async () => {
    if (!world.memberWeb) throw new Error("The member browser was not arranged.");
    const member = user.on(world.memberWeb);
    const memberProbe = probe.on(world.memberWeb);
    await member.reload();
    await member.see({ text: "Sales call prep" }, { timeoutMs: 60_000 });
    const status = (await memberProbe.dom('[data-library-item="Sales call prep"] [data-item-status]')).elements;
    expect(status[0]?.text).toBe("Ready");
    await member.click({ role: "link", label: /Sales call prep/ });
    await member.see({ testId: "plugin-manage-locked" });
    expect((await memberProbe.dom('[data-testid="plugin-page"] button[disabled]')).elements.some((item) => item.text === "Manage")).toBe(true);
    await member.notSee({ role: "button", label: "More for Sales call prep" });
    await member.notSee({ role: "button", label: "Add team" });
    expect((await memberProbe.dom('[data-testid="whats-inside"]')).elements[0]?.text).toContain("Prep a sales call");
    const pluginId = await pluginIdNamed(world.den.admin, "Sales call prep");
    const memberLibrary = await probe.api(world.den.members.omar, "/v1/me/library");
    const granted = isRecord(memberLibrary.body) ? records(memberLibrary.body.items).find((item) => item.id === pluginId) : undefined;
    expect(granted?.role).toBe("viewer");
    const context = await probe.api(world.den.members.omar, "/v1/org");
    expect(isRecord(context.body) && isRecord(context.body.currentMember) && context.body.currentMember.role).toBe("member");
    await member.screenshot();
  });

  await step("after: browsing the connector catalog from My Library never adds a connection", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library`);
    await user.see({ text: "Sales call prep" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ testId: "library-add-dialog" });
    await user.see({ role: "radio", label: /^Connector/ });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ testId: "connector-catalog" }, { timeoutMs: 60_000 });
    await user.see({ role: "link", label: "Add Slack" });
    await user.notSee({ role: "textbox", label: "Address" });
    await user.click({ role: "button", label: "Add another MCP" });
    await user.see({ role: "textbox", label: "Address" });
    await user.click({ role: "button", label: "Cancel" });
    const connections = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(isRecord(connections.body) ? records(connections.body.connections) : []).toHaveLength(0);
    await user.screenshot();
  });

});
