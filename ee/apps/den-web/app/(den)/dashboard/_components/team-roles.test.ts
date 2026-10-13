import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_KEYS, permissionDefaultKeys } from "@openwork/types/den/permissions";
import {
  allowedKeys,
  customRoleChoice,
  parseRoleChoice,
  permissionSourceRoleLabel,
  roleKindLabel,
  roleName,
  roleStartKeys,
  teamRole,
  teamRoleLabels,
  teamRoleLockReason,
  teamRoleSteps,
} from "./team-roles";

const member = { admin: false, customSetId: null };
const admin = { admin: true, customSetId: null };
const custom = { admin: false, customSetId: "pms_team" };
const all = { canManageAdminTeams: true, canManagePermissions: true, permissionsFeature: true };

test("a team's role comes from the Admin flag and its permission set, Admin first", () => {
  assert.equal(teamRole(member), "member");
  assert.equal(teamRole(admin), "admin");
  assert.equal(teamRole(custom), "custom");
  assert.equal(teamRole({ admin: true, customSetId: "pms_team" }), "admin");
});

test("changing a team's role never leaves it with less access part way", () => {
  assert.deepEqual(teamRoleSteps(member, "admin", []), [{ kind: "set-admin", value: true }]);
  assert.deepEqual(teamRoleSteps(custom, "admin", []), [{ kind: "set-admin", value: true }, { kind: "remove-custom", setId: "pms_team" }]);
  assert.deepEqual(teamRoleSteps(admin, "custom", ["teams.view"]), [{ kind: "create-custom", keys: ["teams.view"] }, { kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(member, "custom", ["teams.view"]), [{ kind: "create-custom", keys: [] }]);
  assert.deepEqual(teamRoleSteps(admin, "member", []), [{ kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(custom, "member", []), [{ kind: "remove-custom", setId: "pms_team" }]);
  assert.deepEqual(teamRoleSteps(admin, "admin", []), []);
});

test("a role change is locked with the permission it needs", () => {
  assert.equal(teamRoleLockReason(member, "admin", all), null);
  assert.match(teamRoleLockReason(member, "admin", { ...all, canManageAdminTeams: false }) ?? "", /Manage Admin teams/);
  assert.match(teamRoleLockReason(admin, "member", { ...all, canManageAdminTeams: false }) ?? "", /Manage Admin teams/);
  assert.match(teamRoleLockReason(member, "custom", { ...all, permissionsFeature: false }) ?? "", /Enterprise/);
  assert.match(teamRoleLockReason(custom, "member", { ...all, canManagePermissions: false }) ?? "", /Manage permissions/);
  assert.equal(teamRoleLockReason(custom, "custom", { canManageAdminTeams: false, canManagePermissions: false, permissionsFeature: false }), null);
});

test("a new role starts from Member, Admin or everything, limited to what the creator holds", () => {
  const owner = new Set<string>(PERMISSION_KEYS);
  assert.deepEqual(roleStartKeys("everything", owner), [...PERMISSION_KEYS]);
  assert.deepEqual(roleStartKeys("admin", owner), permissionDefaultKeys("admin"));
  assert.deepEqual(roleStartKeys("member", owner), permissionDefaultKeys("member"));
  assert.deepEqual(roleStartKeys("everything", new Set(["teams.view"])), ["teams.view"]);
});

test("every screen names roles the same way, never by Den's stored set names", () => {
  assert.equal(roleName({ kind: "member_default", name: "Member permissions", team: null }), "Member");
  assert.equal(roleName({ kind: "admin_default", name: "Admin permissions", team: null }), "Admin");
  assert.equal(roleName({ kind: "team", name: "Engineering Permissions", team: { id: "tem_1", name: "Engineering" } }), "Engineering");
  assert.equal(roleKindLabel({ kind: "team" }), "Custom role");
  assert.equal(roleKindLabel({ kind: "admin_default" }), "Built-in role");
  assert.equal(permissionSourceRoleLabel({ kind: "admin_default", label: "Admin permissions (via Sales team)", via: "team", teamName: "Sales" }), "Admin via Sales");
  assert.equal(permissionSourceRoleLabel({ kind: "team", label: "Engineering Permissions (via Engineering team)", teamName: "Engineering" }), "Engineering");
  assert.equal(permissionSourceRoleLabel({ kind: "code_default", label: "Member permissions (default)", set: "member" }), "Member");
});

test("a person's team roles read Admin first, then custom roles by team", () => {
  const teams = [
    { id: "tem_eng", name: "Engineering", memberIds: ["om_1"], grantsOrganizationAdmin: false },
    { id: "tem_sales", name: "Sales", memberIds: ["om_1"], grantsOrganizationAdmin: true },
    { id: "tem_plain", name: "Book club", memberIds: ["om_1"], grantsOrganizationAdmin: false },
  ];
  const customTeamIds = new Set(["tem_eng"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "member", teams, customTeamIds }), ["Admin via Sales", "Engineering"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "admin", teams, customTeamIds }), ["Engineering"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "owner", teams, customTeamIds }), []);
  assert.deepEqual(teamRoleLabels({ memberId: "om_2", ownRole: "member", teams, customTeamIds }), []);
});

test("a custom role in a role picker invites a Member into that team", () => {
  assert.deepEqual(parseRoleChoice(customRoleChoice("tem_eng")), { role: "member", teamId: "tem_eng" });
  assert.deepEqual(parseRoleChoice("admin"), { role: "admin", teamId: null });
  assert.deepEqual(parseRoleChoice("member"), { role: "member", teamId: null });
});

test("allowed keys keep catalog order and drop retired keys", () => {
  assert.deepEqual(allowedKeys([{ key: "teams.view", status: "allow" }, { key: "organization.update", status: "allow" }, { key: "retired.key", status: "allow" }, { key: "sso.view", status: "deny" }]), ["organization.update", "teams.view"]);
});
