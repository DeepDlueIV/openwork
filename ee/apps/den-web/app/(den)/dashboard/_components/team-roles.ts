import { PERMISSION_KEYS, isPermissionKey, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";

/**
 * Team roles: the one-role-per-team view of what already exists in Den.
 *
 *   Member  the team adds nothing (no Admin flag, no team permission set)
 *   Admin   the team is an Admin team (team.grantsOrganizationAdmin)
 *   Custom  the team's one permission set (POST /v1/permissions/sets)
 *
 * Nothing here is stored as a "role"; changing one is the same team and
 * permission set calls the older screens make.
 */
export type TeamRole = "member" | "admin" | "custom";

export type TeamRoleState = {
  /** The team is an Admin team. */
  admin: boolean;
  /** The team's active permission set, if any. */
  customSetId: string | null;
};

/** The role a team shows. An Admin team that also has a set shows as Admin, with the set's extras listed. */
export function teamRole(state: TeamRoleState): TeamRole {
  if (state.admin) return "admin";
  return state.customSetId ? "custom" : "member";
}

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  member: "Member",
  admin: "Admin",
  custom: "Custom",
};

/** What the built-in Admin role is for, in one line. */
export const ADMIN_ROLE_SUMMARY = "Invite people, manage teams, and run connections and models";

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  member: "Nothing beyond what everyone can do",
  admin: `${ADMIN_ROLE_SUMMARY}, like every admin`,
  custom: "Choose exactly what people in this team can do",
};

/**
 * What every member can do whatever their role. These are not permissions
 * (nothing turns them off); they describe how Den already behaves: grants on
 * plugins, skills and connections, creator access to what people make, and
 * provider access assignments.
 */
export const EVERYONE_CAN: readonly string[] = [
  "Use skills, plugins and connections shared with them",
  "Make their own skills and plugins",
  "Share what they made with people and teams",
  "Use the models and providers given to them",
];

export type RoleStart = "member" | "admin" | "everything";

export const ROLE_START_LABELS: Record<RoleStart, string> = {
  member: "Member",
  admin: "Admin",
  everything: "Everything the owner can do",
};

/** The permissions a new role starts with, limited to what the person creating it holds. */
export function roleStartKeys(start: RoleStart, held: ReadonlySet<string>): PermissionKey[] {
  const keys = start === "everything" ? [...PERMISSION_KEYS] : permissionDefaultKeys(start);
  return keys.filter((key) => held.has(key));
}

export type TeamRoleStep =
  | { kind: "set-admin"; value: boolean }
  | { kind: "create-custom"; keys: PermissionKey[] }
  | { kind: "remove-custom"; setId: string };

/**
 * The calls that move a team from its current role to `next`, in an order
 * that never leaves the team with less access mid-way than at either end:
 * a new custom set is created before the Admin flag comes off, and the Admin
 * flag goes on before a custom set is removed.
 */
export function teamRoleSteps(current: TeamRoleState, next: TeamRole, adminKeys: readonly PermissionKey[]): TeamRoleStep[] {
  const steps: TeamRoleStep[] = [];
  if (next === "admin") {
    if (!current.admin) steps.push({ kind: "set-admin", value: true });
    if (current.customSetId) steps.push({ kind: "remove-custom", setId: current.customSetId });
    return steps;
  }
  if (next === "custom") {
    if (!current.customSetId) steps.push({ kind: "create-custom", keys: current.admin ? [...adminKeys] : [] });
    if (current.admin) steps.push({ kind: "set-admin", value: false });
    return steps;
  }
  if (current.admin) steps.push({ kind: "set-admin", value: false });
  if (current.customSetId) steps.push({ kind: "remove-custom", setId: current.customSetId });
  return steps;
}

export type TeamRoleAbilities = {
  /** teams.manage_admin: make a team an Admin team, or turn that off. */
  canManageAdminTeams: boolean;
  /** permissions.manage: create, change and remove team permission sets. */
  canManagePermissions: boolean;
  /** The Permissions feature is on for the organization (team sets exist only then). */
  permissionsFeature: boolean;
};

/** Why the person can't move the team to `next`, or null when they can. */
export function teamRoleLockReason(current: TeamRoleState, next: TeamRole, abilities: TeamRoleAbilities): string | null {
  const steps = teamRoleSteps(current, next, []);
  for (const step of steps) {
    if (step.kind === "set-admin" && !abilities.canManageAdminTeams) {
      return "Needs the “Manage Admin teams” permission. Ask the organization owner.";
    }
    if (step.kind !== "set-admin") {
      if (!abilities.permissionsFeature) return "Custom roles need Permissions, an Enterprise feature.";
      if (!abilities.canManagePermissions) return "Needs the “Manage permissions” permission. Ask the organization owner.";
    }
  }
  return null;
}

/** Keys from a permission set detail that are currently allowed, in catalog order. */
export function allowedKeys(permissions: readonly { key: string; status: "allow" | "deny" }[]): PermissionKey[] {
  const allowed = new Set(permissions.filter((entry) => entry.status === "allow").map((entry) => entry.key));
  return PERMISSION_KEYS.filter((key) => allowed.has(key) && isPermissionKey(key));
}
