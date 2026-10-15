// Steps shared by the accounts-and-access core journeys (sign-up, invitations,
// SSO, SCIM, team roles, agent policy): the public Den, SCIM and SAML calls a
// real client (Den Web, an identity provider) makes, as that client. No
// internal state is read here.
import type { Probe, User } from "@openwork/testkit";
import { denFetch, type DenFetchResult, type DenRef, type DenSession } from "./den.ts";
import type { OrgCaller } from "./identity.ts";
import type { PermissionCall } from "./permissions.ts";

type OrgScope = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, key: string): Record<string, unknown>[] {
  const entries = isRecord(value) ? value[key] : null;
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function field(value: unknown, key: string): string | null {
  const entry = isRecord(value) ? value[key] : null;
  return typeof entry === "string" ? entry : null;
}

async function orgCall(session: DenSession, scope: OrgScope, path: string, method = "GET", body?: unknown): Promise<PermissionCall> {
  const result = await denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, ...scope },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: result.response.status, body: result.body };
}

// ── Team roles and permissions (Den Web's Members, Teams, Roles pages) ──────

/** The permission keys a member holds, as Den Web reads them for that member. */
export async function heldPermissions(session: DenSession, scope: OrgScope): Promise<string[]> {
  const context = await orgCall(session, scope, "/v1/org");
  const current = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
  return Array.isArray(current?.permissions) ? current.permissions.filter((key): key is string => typeof key === "string") : [];
}

/** A member's stored organization role, as the viewer's member list shows it. */
export async function memberRole(viewer: DenSession, scope: OrgScope, memberId: string): Promise<string> {
  const roster = await orgCall(viewer, scope, "/v1/org");
  return String(list(roster.body, "members").find((member) => member.id === memberId)?.role);
}

/** A member's pending row in the viewer's member list, by email. */
export async function pendingMember(viewer: DenSession, scope: OrgScope, email: string): Promise<{ id: string; role: string } | null> {
  const roster = await orgCall(viewer, scope, "/v1/org");
  const member = list(roster.body, "members").find((entry) => isRecord(entry.user) && entry.user.email === email);
  return typeof member?.id === "string" ? { id: member.id, role: String(member.role) } : null;
}

/** Pending invitation emails in the viewer's member list. */
export async function pendingInvitationEmails(viewer: DenSession, scope: OrgScope): Promise<string[]> {
  const roster = await orgCall(viewer, scope, "/v1/org");
  return list(roster.body, "invitations").filter((invitation) => invitation.status === "pending").map((invitation) => String(invitation.email));
}

/** "403 forbidden: “message”", for evidence. */
export function describeCall(call: PermissionCall): string {
  return `${call.status} ${isRecord(call.body) ? `${String(call.body.error)}: “${String(call.body.message)}”` : ""}`;
}

/** A team page's data: GET /v1/teams/:id as the session. */
export async function readTeam(session: DenSession, scope: OrgScope, teamId: string): Promise<{ status: number; team: Record<string, unknown> | null; body: unknown }> {
  const result = await orgCall(session, scope, `/v1/teams/${encodeURIComponent(teamId)}`);
  return { status: result.status, team: isRecord(result.body) && isRecord(result.body.team) ? result.body.team : null, body: result.body };
}

/** Members › Roles: each custom role with the teams that have it. */
export async function listCustomRoles(session: DenSession, scope: OrgScope): Promise<{ id: string; name: string; teamIds: string[] }[]> {
  const result = await orgCall(session, scope, "/v1/permissions/sets");
  return list(result.body, "sets").filter((set) => set.kind === "team").map((set) => ({
    id: String(set.id),
    name: String(set.name),
    teamIds: Array.isArray(set.teams) ? set.teams.filter(isRecord).map((team) => String(team.id)) : [],
  }));
}

/** Settings › Permissions opening its list, as the session. */
export function readPermissionSets(session: DenSession, scope: OrgScope): Promise<PermissionCall> {
  return orgCall(session, scope, "/v1/permissions/sets");
}

/** The keys one permission set allows, as its editor shows them. */
export async function allowedPermissionKeys(session: DenSession, scope: OrgScope, setId: string): Promise<string[]> {
  const detail = await orgCall(session, scope, `/v1/permissions/sets/${encodeURIComponent(setId)}`);
  const set = isRecord(detail.body) && isRecord(detail.body.set) ? detail.body.set : null;
  return list(set, "permissions").filter((entry) => entry.status === "allow").map((entry) => String(entry.key)).sort();
}

/** Gives a team a custom role allowing keys, as Change role › Custom does. */
export function createTeamRole(session: DenSession, scope: OrgScope, teamId: string, keys: string[]): Promise<PermissionCall> {
  return orgCall(session, scope, "/v1/permissions/sets", "POST", { teamId, permissions: keys.map((key) => ({ key, status: "allow" })) });
}

/** Members › Add member with a team chosen, as the session. */
export function inviteToTeam(session: DenSession, scope: OrgScope, email: string, teamId: string): Promise<PermissionCall> {
  return orgCall(session, scope, "/v1/invitations", "POST", { email, role: "member", teamId });
}

/** Revokes one plugin grant, as a team's Access tab Revoke does. */
export function revokePluginGrant(session: DenSession, scope: OrgScope, pluginId: string, grantId: string): Promise<PermissionCall> {
  return orgCall(session, scope, `/v1/plugins/${encodeURIComponent(pluginId)}/access/${encodeURIComponent(grantId)}`, "DELETE");
}

/** The plugin grants a team's Access tab lists: plugin id and how it is granted. */
export async function teamPluginGrants(session: DenSession, scope: OrgScope, teamId: string): Promise<{ pluginId: string; edge: string }[]> {
  const result = await orgCall(session, scope, `/v1/teams/${encodeURIComponent(teamId)}/plugin-access`);
  return list(result.body, "items").map((item) => ({ pluginId: String(isRecord(item.plugin) ? item.plugin.id : ""), edge: String(item.edge) }));
}

// ── Fresh authentication: routine plugin work an old session may still do ───

/** Renames a shared plugin, shares it with everyone, and adds an MCP config to it, as Den Web's plugin pages do. */
export async function routinePluginChanges(admin: DenSession, organizationId: string, pluginId: string): Promise<{ label: string; status: number; text: string }[]> {
  const headers = { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": organizationId };
  const send = (path: string, method: string, body: unknown) => denFetch(admin, path, { method, headers, body: JSON.stringify(body) });
  const results: [string, DenFetchResult][] = [
    ["rename", await send(`/v1/plugins/${pluginId}`, "PATCH", { name: "Shared editing updated" })],
    ["grant", await send(`/v1/plugins/${pluginId}/access`, "POST", { orgWide: true, role: "editor" })],
    ["mcp", await send("/v1/config-objects", "POST", {
      type: "mcp", sourceMode: "cloud", pluginIds: [pluginId],
      input: { rawSourceText: '{"mcpServers":{"fixture":{"url":"https://example.test/mcp"}}}' },
    })],
  ];
  return results.map(([label, result]) => ({ label, status: result.response.status, text: result.text }));
}

// ── SCIM: what an Okta-shaped identity provider sends, and what Den shows ───

export const SCIM_BASE_PATH = "/api/auth/scim/v2";
const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type ScimResult = { status: number; body: unknown; text: string };

/** An Okta-shaped user resource. */
export function oktaUser(email: string, externalId: string, givenName: string, familyName: string) {
  return {
    schemas: [SCIM_USER_SCHEMA], userName: email, name: { givenName, familyName },
    emails: [{ primary: true, value: email, type: "work" }], externalId, active: true, displayName: `${givenName} ${familyName}`,
  };
}

/** The SCIM calls an identity provider makes with one bearer. */
export function scimClient(apiUrl: string, bearer: string) {
  const send = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<ScimResult> => {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}${SCIM_BASE_PATH}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/scim+json, application/json", "content-type": "application/scim+json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = text.trim() ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, text };
  };
  return {
    list: () => send("/Users"),
    findByUserName: (userName: string) => send(`/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`),
    create: (user: unknown) => send("/Users", { method: "POST", body: user }),
    get: (id: string) => send(`/Users/${encodeURIComponent(id)}`),
    replace: (id: string, user: unknown) => send(`/Users/${encodeURIComponent(id)}`, { method: "PUT", body: user }),
    deactivate: (id: string) => send(`/Users/${encodeURIComponent(id)}`, { method: "PATCH", body: { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", value: { active: false } }] } }),
  };
}

/** A SCIM list's totalResults. */
export function scimTotal(result: ScimResult): number | null {
  return isRecord(result.body) && typeof result.body.totalResults === "number" ? result.body.totalResults : null;
}

/** A SCIM user's formatted name. */
export function scimFormattedName(result: ScimResult): string | null {
  return isRecord(result.body) ? field(result.body.name, "formatted") : null;
}

function callerHeaders(caller: OrgCaller): Record<string, string> {
  return { authorization: `Bearer ${caller.session.token}`, cookie: caller.cookie, "x-openwork-org-id": caller.orgId };
}

/** The organization's id by name, from the caller's workspace switcher. */
export async function organizationIdNamed(den: DenRef, session: DenSession, name: string): Promise<string> {
  const result = await denFetch(den, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` } });
  const id = field(list(result.body, "orgs").find((entry) => entry.name === name), "id");
  if (!result.response.ok || !id) throw new Error(`Organization lookup failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  return id;
}

/** Den Web's SSO settings: the connection's status, domain verification and ACS URL. */
export async function readSsoConnection(den: DenRef, caller: OrgCaller): Promise<{ status: string | null; domainVerified: boolean; acsUrl: string | null }> {
  const result = await denFetch(den, "/v1/sso", { headers: callerHeaders(caller) });
  const connection = isRecord(result.body) && isRecord(result.body.connection) ? result.body.connection : null;
  return { status: field(connection, "status"), domainVerified: connection?.domainVerified === true, acsUrl: field(connection, "acsUrl") };
}

/** SCIM settings' "Generate token". */
export async function issueScimToken(den: DenRef, caller: OrgCaller): Promise<{ status: number; scimToken: string | null; baseUrl: string | null }> {
  const result = await denFetch(den, "/v1/scim/token", { method: "POST", headers: callerHeaders(caller) });
  return { status: result.response.status, scimToken: field(result.body, "scimToken"), baseUrl: field(result.body, "baseUrl") };
}

/** Whether an email/password sign-in succeeds, as the sign-in form submits it. */
export async function passwordSignInSucceeds(den: DenRef, email: string, password: string): Promise<boolean> {
  return (await denFetch(den, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) })).response.ok;
}

/** The caller's member list for one email: joined, and its invitation's status and user. */
export async function membershipState(den: DenRef, caller: OrgCaller, email: string): Promise<{ joined: boolean; invitationStatus: string | null; pendingUserId: unknown }> {
  const result = await denFetch(den, "/v1/org", { headers: callerHeaders(caller) });
  const members = list(result.body, "members").filter((member) => isRecord(member.user) && member.user.email === email);
  return {
    joined: result.response.ok && members.some((member) => typeof member.userId === "string"),
    invitationStatus: field(list(result.body, "invitations").find((invitation) => invitation.email === email), "status"),
    pendingUserId: members[0]?.userId,
  };
}

/** An owner invites email, then the person signs up from the invitation and accepts it, as the join page does. */
export async function inviteSignUpAndAccept(den: DenRef, caller: OrgCaller, person: { email: string; name: string; password: string }): Promise<{ signUpStatus: number; accept: PermissionCall | null }> {
  const invite = await denFetch(den, "/v1/invitations", { method: "POST", headers: callerHeaders(caller), body: JSON.stringify({ email: person.email, role: "member" }) });
  const inviteToken = field(invite.body, "inviteToken");
  if (!invite.response.ok || !inviteToken) throw new Error(`Invitation failed: HTTP ${invite.response.status} ${invite.text.slice(0, 300)}`);
  const signUp = await denFetch(den, `/api/auth/sign-up/email?invite=${encodeURIComponent(inviteToken)}`, { method: "POST", body: JSON.stringify(person) });
  const sessionToken = field(signUp.body, "token");
  if (!sessionToken) return { signUpStatus: signUp.response.status, accept: null };
  const accepted = await denFetch(den, "/v1/orgs/invitations/accept", { method: "POST", headers: { authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ id: inviteToken }) });
  return { signUpStatus: signUp.response.status, accept: { status: accepted.response.status, body: accepted.body } };
}

/** The signed-in person's own account email, as Den Web's account menu reads it. */
export async function signedInEmail(den: DenRef, session: DenSession): Promise<{ status: number; email: string | null }> {
  const result = await denFetch(den, "/v1/me", { headers: { authorization: `Bearer ${session.token}` } });
  return { status: result.response.status, email: isRecord(result.body) ? field(result.body.user, "email") : null };
}

// ── Agent policy (a team's Agents tab) ──────────────────────────────────────

export type AgentRule = { action: string; resource: string; effect: string; source: string };

export const agentRule = (action: string, resource: string, effect: string, source: string): AgentRule => ({ action, resource, effect, source });

/** "shell * → ask (Sales); …", for evidence. */
export function describeAgentRules(rules: Record<string, unknown>[] | null): string {
  if (rules === null) return "no agent permissions";
  return rules.map((entry) => `${String(entry.action)} ${String(entry.resource)} → ${String(entry.effect)} (${String(entry.source)})`).join("; ") || "none";
}

/** Waits until the Agents tab's save bar closes, which happens only once the save has landed. */
export async function agentPermissionsSaveLanded(probe: Probe): Promise<void> {
  await probe.eventually(() => probe.dom('[data-testid="agent-permissions-save-bar"]'), {
    within: 30_000,
    label: "the save lands and the save bar closes",
    until: (bar) => bar.elements.length === 0,
  });
}

/** The "Try a request" result line on the Agents tab. */
export async function agentPermissionTryResult(probe: Probe): Promise<string> {
  return (await probe.dom('[data-testid="agent-permission-try-result"]')).elements.map((element) => element.text).join(" ").trim();
}

/** Save changes on the Agents tab, waiting for the save to land and its confirmation. */
export async function saveAgentPermissions(person: User, probe: Probe): Promise<void> {
  await person.click({ role: "button", label: "Save changes" });
  // The save bar closes once the save lands; an earlier "saved" toast may still be showing.
  await agentPermissionsSaveLanded(probe);
  await person.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
}

/** From Everyone's Agents tab, Back to Teams and into one team's Agents tab. */
export async function openTeamAgentsTab(person: User, team: string): Promise<void> {
  await person.click({ role: "link", label: "Back" });
  await person.click({ role: "link", label: team });
  await person.click({ role: "tab", label: "Agents" });
}

/** One Agents-tab row: its text, how many switches and picklists it has, and whether it has pattern lists. */
export async function agentPermissionRowShape(probe: Probe, key: string): Promise<{ text: string; switches: number; picklists: number; lists: number }> {
  const [text, switches, picklists, lists] = await Promise.all([
    probe.dom(`[data-testid="agent-permission-${key}"]`),
    probe.dom(`[data-testid="agent-permission-${key}"] [role="switch"]`),
    probe.dom(`[data-testid="agent-permission-${key}"] [aria-labelledby]`),
    probe.dom(`[data-testid="agent-permission-${key}-lists"]`),
  ]);
  return { text: text.elements.map((element) => element.text).join(" "), switches: switches.elements.length, picklists: picklists.elements.length, lists: lists.elements.length };
}
