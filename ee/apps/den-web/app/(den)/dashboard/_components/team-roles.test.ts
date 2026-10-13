import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_KEYS, permissionDefaultKeys } from "@openwork/types/den/permissions";
import { allowedKeys, roleStartKeys, teamRole, teamRoleLockReason, teamRoleSteps } from "./team-roles";

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

test("allowed keys keep catalog order and drop retired keys", () => {
  assert.deepEqual(allowedKeys([{ key: "teams.view", status: "allow" }, { key: "organization.update", status: "allow" }, { key: "retired.key", status: "allow" }, { key: "sso.view", status: "deny" }]), ["organization.update", "teams.view"]);
});
