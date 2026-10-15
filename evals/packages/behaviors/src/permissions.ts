import { denFetch, type DenSession } from "./den.ts";

/**
 * The Den API calls Den Web's Members and Permissions pages make, as the
 * signed-in person. Each returns what that person's client would see.
 */

export type PermissionChange = { key: string; status: "allow" | "deny" };
export type PermissionCall = { status: number; body: unknown };
type OrgScope = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function orgCall(session: DenSession, scope: OrgScope, path: string, method: string, body?: unknown): Promise<PermissionCall> {
  const result = await denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, ...scope },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: result.response.status, body: result.body };
}

/** The id of a team's permission set (its custom role), or of Member or Admin permissions, as the Permissions page lists them. */
export async function findPermissionSet(
  session: DenSession,
  scope: OrgScope,
  target: { teamId: string } | { kind: "member_default" | "admin_default" },
): Promise<string> {
  const listed = await orgCall(session, scope, "/v1/permissions/sets", "GET");
  const sets = isRecord(listed.body) && Array.isArray(listed.body.sets) ? listed.body.sets.filter(isRecord) : [];
  const match = sets.find((set) => "teamId" in target
    ? Array.isArray(set.teams) && set.teams.some((team) => isRecord(team) && team.id === target.teamId)
    : set.kind === target.kind);
  if (typeof match?.id !== "string") throw new Error(`No permission set for ${JSON.stringify(target)}: HTTP ${listed.status} ${JSON.stringify(listed.body).slice(0, 300)}`);
  return match.id;
}

/** Turns permissions on or off in one set, as saving the Permissions editor does. */
export function changePermissions(session: DenSession, scope: OrgScope, setId: string, changes: PermissionChange[]): Promise<PermissionCall> {
  return orgCall(session, scope, `/v1/permissions/sets/${encodeURIComponent(setId)}/permissions`, "PUT", { changes });
}

/** Changes a member's role, as Members › Change role does. */
export function assignMemberRole(session: DenSession, scope: OrgScope, memberId: string, role: "member" | "admin"): Promise<PermissionCall> {
  return orgCall(session, scope, `/v1/members/${encodeURIComponent(memberId)}/role`, "POST", { role });
}

/** Replaces a team's members, as saving the team editor does. */
export function replaceTeamMembers(session: DenSession, scope: OrgScope, teamId: string, memberIds: string[]): Promise<PermissionCall> {
  return orgCall(session, scope, `/v1/teams/${encodeURIComponent(teamId)}`, "PATCH", { memberIds });
}
