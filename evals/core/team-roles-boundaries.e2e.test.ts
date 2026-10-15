import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  allowedPermissionKeys, assignMemberRole, changePermissions, createTeamRole, describeCall, findPermissionSet, heldPermissions,
  inviteToTeam, memberRole, pendingInvitationEmails, readPermissionSets, readTeam, revokePluginGrant, teamPluginGrants,
} from "@openwork/behaviors";
import { ENGINEERING_KEYS, teamRolesWorld } from "../worlds/team-roles.ts";

// What people outside a team's role cannot do (team-roles is the owner's
// journey). Same world: Olivia owns it, Maya is in Sales, Lee in Engineering
// (custom role), Nora in no team.
const test = spec.world((seed) => teamRolesWorld(seed), {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});
const salesPluginTest = spec.world((seed) => teamRolesWorld(seed, { salesPlugin: true }), {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an owner reads what the Engineering team can do from its team page; a member without team access can't open it", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const nora = user.on(world.noraWeb);

  await step("from the dashboard, the owner opens Members › Teams › Engineering", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Teams/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ role: "link", label: "Engineering" }, { timeoutMs: 30_000 });
    await owner.click({ role: "link", label: "Engineering" });
    await owner.see({ testId: "team-role-name" }, { text: "Custom", timeoutMs: 60_000 });
  });

  await step("after: the role, what it adds, and what everyone can do are on one screen", async () => {
    await owner.see({ testId: "team-role-also" }, { text: /Share with everyone/, timeoutMs: 30_000 });
    await owner.see({ testId: "team-role-also" }, { text: /Create and remove marketplaces/ });
    await owner.see({ testId: "team-role-also" }, { text: /Import plugins from GitHub/ });
    await owner.see({ testId: "team-role-everyone" }, { text: /Make their own skills and plugins/ });
    const lee = await heldPermissions(world.lee, world.scope);
    const ok = ENGINEERING_KEYS.every((key) => lee.includes(key));
    evidence.recordAssertionEvidence("The page matches what Lee, in Engineering, actually holds", `Lee holds ${ENGINEERING_KEYS.filter((key) => lee.includes(key)).join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: Nora, without View any team, is sent back to her dashboard and the API refuses the team", async () => {
    await nora.navigate(world.url(`/dashboard/members/teams/${encodeURIComponent(world.teams.engineering)}`));
    await nora.see({ text: "My Library" }, { timeoutMs: 60_000 });
    await nora.notSee({ testId: "team-role" });
    const team = await readTeam(world.nora, world.scope, world.teams.engineering);
    expect(team.status).toBe(403);
    expect(team.body).toMatchObject({ requiredPermission: "teams.view" });
    // Without View permissions she cannot list roles either, so no custom role name reaches her.
    const sets = await readPermissionSets(world.nora, world.scope);
    expect(sets.status).toBe(403);
    expect(JSON.stringify(sets.body)).not.toContain("Engineering");
    await nora.screenshot();
  });

  await step("boundary: once Engineering's role may change member roles, Lee still cannot make Maya or himself an admin", async () => {
    const engineering = await findPermissionSet(world.owner, world.scope, { teamId: world.teams.engineering });
    const granted = await changePermissions(world.owner, world.scope, engineering, [{ key: "members.update", status: "allow" }]);
    expect(granted.status).toBe(200);
    const lee = await heldPermissions(world.lee, world.scope);
    const promote = await assignMemberRole(world.lee, world.scope, world.ids.maya, "admin");
    const self = await assignMemberRole(world.lee, world.scope, world.ids.lee, "admin");
    const [mayaRole, leeRole] = await Promise.all([memberRole(world.owner, world.scope, world.ids.maya), memberRole(world.owner, world.scope, world.ids.lee)]);
    const ok = lee.includes("members.update") && promote.status === 403 && self.status === 403 && mayaRole === "member" && leeRole === "member";
    evidence.recordAssertionEvidence("Changing roles through a team never mints an admin", `Lee holds Change member roles: ${lee.includes("members.update")}; Lee makes Maya admin → ${describeCall(promote)}; Lee makes himself admin → ${describeCall(self)}; Maya is ${mayaRole}, Lee is ${leeRole}`, ok);
    expect(lee).toContain("members.update");
    expect(promote.status).toBe(403);
    expect(promote.body).toMatchObject({ error: "forbidden", message: "Only the owner or an admin can make someone an admin." });
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ error: "forbidden", message: "You can't change your own role. Ask the owner or another admin." });
    expect(mayaRole).toBe("member");
    expect(leeRole).toBe("member");
  });

  await step("boundary: once Engineering's role may manage permissions, Lee still cannot give every member a permission he does not hold", async () => {
    const engineering = await findPermissionSet(world.owner, world.scope, { teamId: world.teams.engineering });
    const granted = await changePermissions(world.owner, world.scope, engineering, [{ key: "permissions.view", status: "allow" }, { key: "permissions.manage", status: "allow" }]);
    expect(granted.status).toBe(200);
    const memberDefaults = await findPermissionSet(world.lee, world.scope, { kind: "member_default" });
    const escalate = await changePermissions(world.lee, world.scope, memberDefaults, [{ key: "billing.manage", status: "allow" }]);
    const [lee, nora] = await Promise.all([heldPermissions(world.lee, world.scope), heldPermissions(world.nora, world.scope)]);
    const ok = lee.includes("permissions.manage") && !lee.includes("billing.manage") && escalate.status === 403 && !nora.includes("billing.manage");
    evidence.recordAssertionEvidence("Someone who manages permissions can only hand out what they hold", `Lee holds Manage permissions: ${lee.includes("permissions.manage")}, billing.manage: ${lee.includes("billing.manage")}; Lee allows billing.manage in Member permissions → ${describeCall(escalate)}; Nora holds billing.manage: ${nora.includes("billing.manage")}`, ok);
    expect(lee).toContain("permissions.manage");
    expect(escalate.status).toBe(403);
    expect(escalate.body).toMatchObject({ error: "permission_not_held", keys: ["billing.manage"] });
    expect(nora).not.toContain("billing.manage");
  });

  await step("boundary: Admin permissions start with View permissions but without Manage permissions, which stays with the owner", async () => {
    const admins = await findPermissionSet(world.owner, world.scope, { kind: "admin_default" });
    const allowed = await allowedPermissionKeys(world.owner, world.scope, admins);
    expect(allowed).toContain("permissions.view");
    expect(allowed).not.toContain("permissions.manage");
  });

  await step("boundary: once Engineering's role may invite and manage teams, Lee still cannot invite someone into a team that grants what he lacks", async () => {
    const engineering = await findPermissionSet(world.owner, world.scope, { teamId: world.teams.engineering });
    expect((await changePermissions(world.owner, world.scope, engineering, [{ key: "invitations.manage", status: "allow" }, { key: "teams.manage", status: "allow" }])).status).toBe(200);
    expect((await createTeamRole(world.owner, world.scope, world.teams.sales, ["billing.manage"])).status).toBe(201);
    const email = `team-roles-blocked+${Date.now().toString(36)}@example.test`;
    const invite = await inviteToTeam(world.lee, world.scope, email, world.teams.sales);
    expect(invite.status, describeCall(invite)).toBe(403);
    expect(invite.body).toMatchObject({ message: "You can't add people to this team because it grants permissions you don't have." });
    expect(await pendingInvitationEmails(world.owner, world.scope)).not.toContain(email);
  });
});

salesPluginTest("a member outside Sales neither sees Sales' private plugin nor can revoke its grant", async ({ world, user, step }) => {
  const plugin = world.salesPlugin;
  if (!plugin) throw new Error("The Sales playbook was not arranged");
  await step("Nora, in no team, does not see the Sales playbook in her library, and the API refuses her revoke", async () => {
    const nora = user.on(world.noraWeb);
    await nora.navigate(world.url("/dashboard/library"));
    await nora.see({ text: "My Library" }, { timeoutMs: 90_000 });
    await nora.notSee({ text: "Sales playbook" });
    const denied = await revokePluginGrant(world.nora, world.scope, plugin.id, plugin.grantId);
    expect(denied.status, describeCall(denied)).toBe(403);
    expect(await teamPluginGrants(world.owner, world.scope, world.teams.sales)).toContainEqual({ pluginId: plugin.id, edge: "direct_team" });
  });
});
