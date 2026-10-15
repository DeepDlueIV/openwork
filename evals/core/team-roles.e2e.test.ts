import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { describeCall, heldPermissions, listCustomRoles, pendingMember, readTeam, replaceTeamMembers } from "@openwork/behaviors";
import { ENGINEERING_KEYS, teamRolesWorld } from "../worlds/team-roles.ts";

// Den Web Team roles (teamRoles): every team has one role, Member, Admin or
// Custom, shown on the team page with one Change role action, and Members has
// a Roles tab where an owner creates a role. Each journey starts from the
// dashboard. Nothing new is stored: Admin is the existing Admin team flag and
// Custom is the team's one permission set. What people outside a role cannot
// do is team-roles-boundaries.
const test = spec.world((seed) => teamRolesWorld(seed), {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});
const sharedRolesTest = spec.world((seed) => teamRolesWorld(seed, { sharedRoles: true }), {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an owner gives the Sales team the Admin role from its team page, and only Sales members become admins", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);

  await step("before: Maya, in Sales, can't invite people; neither can Nora, in no team", async () => {
    const [maya, nora] = await Promise.all([heldPermissions(world.maya, world.scope), heldPermissions(world.nora, world.scope)]);
    const ok = !maya.includes("invitations.manage") && !nora.includes("invitations.manage");
    evidence.recordAssertionEvidence("Neither member holds Invite people", `Maya holds ${maya.length} permissions; Nora holds ${nora.length}`, ok);
    expect(ok).toBe(true);
  });

  await step("from the dashboard, the owner opens Members › Teams › Sales and sees its role is Member", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Teams/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ role: "link", label: "Sales" }, { timeoutMs: 30_000 });
    await owner.notSee({ text: /Grant organisation Admin to all members of/ });
    await owner.click({ role: "link", label: "Sales" });
    await owner.see({ testId: "team-role-name" }, { text: "Member", timeoutMs: 60_000 });
    await owner.notSee({ text: /Grant organisation Admin to all members of/ });
    await owner.see({ text: "Nothing beyond what everyone can do" });
    await owner.see({ testId: "team-role-everyone" }, { text: /Use skills, plugins and connections shared with them/ });
    await owner.screenshot();
  });

  await step("the owner clicks Change role and picks Admin, right on the team page", async () => {
    await owner.click({ testId: "team-role-change" });
    await owner.see({ testId: "team-role-choice" }, { timeoutMs: 15_000 });
    await owner.click({ testId: "team-role-option-admin" });
    await owner.see({ role: "button", label: "Change to Admin" });
    expect((await probe.on(world.ownerWeb).dom('[role="dialog"]')).elements).toHaveLength(0);
    await owner.screenshot();
  });

  await step("after: Sales is Admin, and the page lists what Sales can now do", async () => {
    await owner.click({ testId: "team-role-save" });
    await owner.see({ testId: "team-role-name" }, { text: "Admin", timeoutMs: 30_000 });
    await owner.see({ testId: "den-toast" }, { text: /Sales is now Admin/ });
    await owner.see({ testId: "team-role-also" }, { text: /Invite people/ });
    const team = await readTeam(world.owner, world.scope, world.teams.sales);
    const flagged = team.team?.grantsOrganizationAdmin === true;
    evidence.recordAssertionEvidence("Admin is the existing Admin team flag", `GET /v1/teams/:sales → grantsOrganizationAdmin ${String(flagged)}`, flagged);
    expect(flagged).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: Maya gains Invite people through Sales; Nora, outside it, does not", async () => {
    const [maya, nora] = await Promise.all([heldPermissions(world.maya, world.scope), heldPermissions(world.nora, world.scope)]);
    const ok = maya.includes("invitations.manage") && !nora.includes("invitations.manage");
    evidence.recordAssertionEvidence("Only Sales members gain the Admin permissions", `Maya holds Invite people: ${maya.includes("invitations.manage")}; Nora: ${nora.includes("invitations.manage")}`, ok);
    expect(ok).toBe(true);
  });

  await step("boundary: Maya, an admin only through Sales, cannot add Nora to Sales, so Nora gains nothing", async () => {
    const add = await replaceTeamMembers(world.maya, world.scope, world.teams.sales, [world.ids.maya, world.ids.nora]);
    const nora = await heldPermissions(world.nora, world.scope);
    const refused = add.status === 403 && !nora.includes("invitations.manage");
    evidence.recordAssertionEvidence("Growing an Admin team needs the owner, not an admin through that team", `Maya PATCH /v1/teams/:sales adding Nora → ${describeCall(add)}; Nora holds Invite people: ${nora.includes("invitations.manage")}`, refused);
    expect(add.status).toBe(403);
    expect(add.body).toMatchObject({ error: "forbidden" });
    expect(nora).not.toContain("invitations.manage");
  });
});

test("an owner creates a Skill publishers role from Members › Roles, and only the people in it can share with everyone", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.ownerWeb);

  await step("from the dashboard, the owner opens Members › Roles and sees built-in and custom roles", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Roles/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.see({ testId: "role-row-member" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "role-row-admin" });
    await owner.see({ testId: "role-row-owner" });
    await owner.see({ testId: "role-row-custom" }, { text: /Engineering/, timeoutMs: 30_000 });
    await owner.screenshot();
  });

  await step("the owner names the role, adds Nora, and turns on Share with everyone", async () => {
    await owner.click({ testId: "roles-create" });
    await owner.see({ testId: "role-new-name" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "role-new-name" }, "Skill publishers");
    await owner.click({ role: "button", label: "Add person" });
    await owner.see({ testId: "access-add-person-popover" }, { timeoutMs: 15_000 });
    await owner.click({ role: "option", label: /Nora Newcomer/ });
    await owner.click({ role: "button", label: "Add Nora Newcomer" });
    await owner.see({ testId: "role-new-person" }, { text: /Nora Newcomer/ });
    await owner.click({ role: "switch", label: /^Share with everyone$/ });
    await owner.screenshot();
  });

  await step("after: the role is created and opens as its team page with role Custom", async () => {
    await owner.click({ testId: "role-new-create" });
    await owner.see({ testId: "team-role-name" }, { text: "Custom", timeoutMs: 60_000 });
    await owner.see({ testId: "team-role-also" }, { text: /Share with everyone/ });
    await owner.screenshot();
  });

  await step("boundary: Nora can now share with everyone; Maya, outside the role, cannot", async () => {
    const [nora, maya] = await Promise.all([heldPermissions(world.nora, world.scope), heldPermissions(world.maya, world.scope)]);
    const ok = nora.includes("sharing.share_org_wide") && !maya.includes("sharing.share_org_wide");
    evidence.recordAssertionEvidence("Only people in the new role gain it", `Nora holds Share with everyone: ${nora.includes("sharing.share_org_wide")}; Maya: ${maya.includes("sharing.share_org_wide")}`, ok);
    expect(ok).toBe(true);
  });
});

test("an owner invites someone straight into the Engineering custom role, and they show with it wherever people are listed", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const email = `team-roles-invitee+${Date.now().toString(36)}@example.test`;

  await step("from the dashboard, the owner opens Members › Add member and sees custom roles in the Role picker", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Add member" });
    await owner.type({ testId: "invite-email" }, email);
    await owner.click({ role: "button", label: "Role" });
    await owner.see({ role: "option", label: /^Engineering/ }, { timeoutMs: 15_000 });
    await owner.see({ role: "option", label: /^Admin/ });
    await owner.screenshot();
  });

  await step("after: the invite goes out with Engineering, and the pending person is already in its team", async () => {
    await owner.click({ role: "option", label: /^Engineering/ });
    await owner.click({ role: "button", label: "Send invite" });
    await owner.see({ text: email }, { timeoutMs: 30_000 });
    const pending = await pendingMember(world.owner, world.scope, email);
    const team = await readTeam(world.owner, world.scope, world.teams.engineering);
    const memberIds = Array.isArray(team.team?.memberIds) ? team.team.memberIds : [];
    const ok = Boolean(pending && memberIds.includes(pending.id) && pending.role === "member");
    evidence.recordAssertionEvidence("A custom role invites a Member into that role's team", `pending member role ${String(pending?.role)}; in Engineering: ${ok}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: the Teams list names each team's role, Member for Sales and Custom for Engineering", async () => {
    await owner.click({ role: "tab", label: /^Teams/ });
    // Sales is listed first; Engineering's Custom is the only "Custom" on the tab.
    await owner.see({ testId: "team-row-role" }, { text: "Member", timeoutMs: 30_000 });
    await owner.see({ text: "Custom" });
    await owner.screenshot();
  });
});

sharedRolesTest("an owner gives Engineering's role to Sales too, then takes it from Engineering after a confirm, and only Sales keeps it", async ({ world, user, step }) => {
  const owner = user.on(world.ownerWeb);
  const [role] = await listCustomRoles(world.owner, world.scope);
  if (!role) throw new Error("The world's Engineering role is missing");

  await step("from Members › Roles, the owner adds Sales to Engineering's role, and Maya in Sales gains every Engineering permission", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.click({ testId: "role-row-custom" });
    await owner.see({ testId: "role-teams" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Add team" });
    await owner.click({ role: "option", label: /^Sales/ });
    await owner.click({ role: "button", label: "Add Sales" });
    await owner.see({ role: "button", label: /^Remove .* from Sales$/ }, { timeoutMs: 30_000 });
    const [maya, nora] = await Promise.all([heldPermissions(world.maya, world.scope), heldPermissions(world.nora, world.scope)]);
    expect(ENGINEERING_KEYS.filter((key) => !maya.includes(key))).toEqual([]);
    expect(nora).not.toContain("sharing.share_org_wide");
  });

  await step("Remove on Engineering asks first, then Lee in Engineering loses the role, the role survives, and Maya in Sales keeps it", async () => {
    await owner.click({ role: "button", label: /^Remove .* from Engineering$/ });
    await owner.see({ testId: "role-team-remove-dialog" }, { text: /Sales keeps the role/, timeoutMs: 15_000 });
    await owner.click({ testId: "role-team-remove-confirm" });
    await owner.see({ testId: "den-toast" }, { text: /Removed .* from Engineering/, timeoutMs: 30_000 });
    const after = (await listCustomRoles(world.owner, world.scope)).find((entry) => entry.id === role.id);
    expect(after?.teamIds).toEqual([world.teams.sales]);
    const [lee, maya] = await Promise.all([heldPermissions(world.lee, world.scope), heldPermissions(world.maya, world.scope)]);
    expect(lee).not.toContain("sharing.share_org_wide");
    expect(maya).toContain("sharing.share_org_wide");
    await owner.screenshot();
  });
});
