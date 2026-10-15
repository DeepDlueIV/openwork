// Steps shared by the Library, Manage and Audit core journeys: what an admin,
// member or owner does in Den Web, and the public Den and MCP calls a real
// client makes to observe the result. No internal state is read here.
import type { Probe, User } from "@openwork/testkit";
import { auditEventsResponseSchema, auditOperationsResponseSchema, type AuditEventEnvelope, type AuditOperationSummary } from "@openwork/types/den/audit";
import { callMcpTool, type McpToolResult } from "./api-keys.ts";
import { denFetch, type DenFetchResult, type DenRef, type DenSession } from "./den.ts";
import { followProviderAuthorize, readManageableMcpConnection, startMcpConnectionSignIn, visitMcpOAuthCallback } from "./mcp-oauth.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  const list = isRecord(value) ? value[key] : null;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

function call(session: DenSession, path: string, init: { method?: string; body?: unknown; organizationId?: string } = {}): Promise<DenFetchResult> {
  return denFetch(session, path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${session.token}`, ...(init.organizationId ? { "x-openwork-org-id": init.organizationId } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

// ── Library and Manage ──────────────────────────────────────────────────────

/** Den Web's plugin form: name, description and one skill. Leaves the form unsubmitted. */
export async function fillPluginWithSkill(
  user: User,
  plugin: { name: string; description: string },
  skill: { name: string; whenToUse: string; steps: string },
): Promise<void> {
  await user.type({ placeholder: "Sales call prep" }, plugin.name);
  await user.type({ placeholder: "What it helps people do" }, plugin.description);
  await user.click({ role: "button", label: /^Skill$/ });
  await user.type({ role: "textbox", label: "Skill name" }, skill.name);
  await user.type({ role: "textbox", label: "When to use it" }, skill.whenToUse);
  await user.type({ role: "textbox", label: "Skill steps" }, skill.steps);
}

/** On a Who can use it page: Add team, pick each team, and add it. */
export async function addTeamsToAccess(user: User, teams: string[]): Promise<void> {
  for (const team of teams) {
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: new RegExp(team) });
    await user.click({ role: "button", label: `Add ${team}` });
  }
}

/** On a connector's setup page: Sign in with it once to try it, until all four checks pass. */
export async function tryConnectorSignIn(user: User, name: string, closeSignInTab: () => Promise<void>): Promise<void> {
  await user.see({ role: "button", label: `Sign in with ${name}` }, { timeoutMs: 60_000 });
  await user.click({ role: "button", label: `Sign in with ${name}` });
  await user.see({ role: "heading", label: `${name} passed all 4 checks` }, { timeoutMs: 120_000 });
  await closeSignInTab();
}

/** On a connector's setup page: give it to these teams, add it, and wait for "<name> is ready". */
export async function addConnectorForTeams(user: User, name: string, teams: string[]): Promise<void> {
  await addTeamsToAccess(user, teams);
  await user.click({ role: "button", label: `Add ${name}` });
  await user.see({ testId: "den-toast" }, { text: new RegExp(`${name} is ready`), timeoutMs: 60_000 });
}

/** The id of the active plugin with this name in the caller's plugin directory. */
export async function pluginIdNamed(session: DenSession, name: string): Promise<string> {
  const directory = await call(session, "/v1/plugins?status=active&limit=50");
  const id = rows(directory.body, "items").find((item) => item.name === name)?.id;
  if (typeof id !== "string") throw new Error(`The ${name} plugin is missing: HTTP ${directory.response.status}`);
  return id;
}

/** A connection as Den lists it to this person (manageable or usable), or undefined. */
export async function mcpConnectionNamed(session: DenSession, scope: "manageable" | "usable", name: string): Promise<Record<string, unknown> | undefined> {
  const listed = await call(session, `/v1/mcp-connections?scope=${scope}`);
  return rows(listed.body, "connections").find((entry) => entry.name === name);
}

/** Every connection Den lists to this person with this name (to prove nothing was copied). */
export async function mcpConnectionsNamed(session: DenSession, scope: "manageable" | "usable", name: string): Promise<Record<string, unknown>[]> {
  const listed = await call(session, `/v1/mcp-connections?scope=${scope}`);
  return rows(listed.body, "connections").filter((entry) => entry.name === name);
}

/** Check again on a connector, as den-web sends it. Returns the HTTP status. */
export async function requestMcpConnectionCheck(session: DenSession, connectionId: string): Promise<number> {
  const result = await call(session, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/check`, { method: "POST" });
  return result.response.status;
}

export interface PluginSkillAsAgent {
  /** The plugin's skill capabilities this person's agent lists. */
  listed: string[];
  /** search_capabilities mentioned the capability. */
  found: boolean;
  run: McpToolResult;
  get: McpToolResult;
}

/** What a person's MCP client sees of a plugin's skill: listing, search, execute and get. */
export async function pluginSkillAsAgent(den: DenRef, token: string, pluginId: string, capability: string, query: string): Promise<PluginSkillAsAgent> {
  const listed = await pluginSkillCapabilities(den, token, pluginId);
  const search = await callMcpTool(den, token, "search_capabilities", { query, limit: 20 });
  const run = await callMcpTool(den, token, "execute_capability", { name: capability });
  const get = await callMcpTool(den, token, "get_skill", { name: capability });
  return { listed, found: capability !== "" && search.text.includes(capability), run, get };
}

/** The skill capabilities of one plugin this person's MCP client lists. */
export async function pluginSkillCapabilities(den: DenRef, token: string, pluginId: string): Promise<string[]> {
  const listed = await callMcpTool(den, token, "list_skills", {});
  return rows(listed.structured, "skills")
    .map((skill) => skill.capability)
    .filter((name): name is string => typeof name === "string" && name.startsWith(`plugin:${pluginId}:`));
}

export interface McpReplyOutcome {
  status: number;
  /** Token requests the provider received because of this reply. */
  tokenRequests: number;
  connected: boolean;
}

/**
 * Signs an admin in to an OAuth MCP server three ways: with the provider's
 * reply carrying another issuer, with a forged state, and genuinely (then
 * replays that genuine reply). Returns what Den answered and what it asked the
 * provider for each time.
 */
export async function tamperedMcpSignInReplies(
  admin: DenSession,
  connectionId: string,
  issuer: { url: string; requests(): Promise<Array<{ path: string }>> },
): Promise<{ wrongIssuer: McpReplyOutcome; forgedState: McpReplyOutcome; genuine: McpReplyOutcome; replay: McpReplyOutcome; issuerNamed: boolean }> {
  const tokenRequests = async () => (await issuer.requests()).filter((entry) => entry.path === "/token").length;
  let issuerNamed = true;
  const signIn = async () => {
    const started = await startMcpConnectionSignIn(admin, connectionId);
    if (!started.authorizeUrl) throw new Error(`Den returned no authorization URL: HTTP ${started.status} ${started.text.slice(0, 200)}`);
    const callback = await followProviderAuthorize(started.authorizeUrl);
    issuerNamed &&= callback.searchParams.get("iss") === issuer.url;
    return callback;
  };
  const visit = async (callback: URL): Promise<McpReplyOutcome> => {
    const before = await tokenRequests();
    const reply = await visitMcpOAuthCallback(callback);
    const connected = (await readManageableMcpConnection(admin, connectionId))?.connected === true;
    return { status: reply.status, tokenRequests: (await tokenRequests()) - before, connected };
  };
  const wrong = await signIn();
  wrong.searchParams.set("iss", "https://other-issuer.example.test");
  const wrongIssuer = await visit(wrong);
  const forged = await signIn();
  forged.searchParams.set("state", "forged-state");
  const forgedState = await visit(forged);
  const real = await signIn();
  const genuine = await visit(real);
  const replay = await visit(real);
  return { wrongIssuer, forgedState, genuine, replay, issuerNamed };
}

// ── Audit ───────────────────────────────────────────────────────────────────

export const auditOperationsPath = "/v1/audit/operations?limit=50";

/** The owner's audit history for this query string (appended to the first page). */
export async function auditOperations(session: DenSession, query = ""): Promise<{ status: number; operations: AuditOperationSummary[]; nextCursor: string | null; text: string }> {
  const result = await call(session, `${auditOperationsPath}${query}`);
  if (result.response.status !== 200) return { status: result.response.status, operations: [], nextCursor: null, text: result.text };
  const parsed = auditOperationsResponseSchema.parse(result.body);
  return { status: 200, operations: parsed.operations, nextCursor: parsed.nextCursor ?? null, text: result.text };
}

/** Every event inside one operation, oldest id first. */
export async function auditOperationEvents(session: DenSession, operationId: string): Promise<{ status: number; events: AuditEventEnvelope[]; text: string }> {
  const result = await call(session, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
  if (result.response.status !== 200) return { status: result.response.status, events: [], text: result.text };
  const events = auditEventsResponseSchema.parse(result.body).events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { status: 200, events, text: result.text };
}

/** The one operation holding this event type, with its events. Throws unless exactly one exists. */
export async function onlyAuditOperationWith(session: DenSession, action: string): Promise<{ operation: AuditOperationSummary; events: AuditEventEnvelope[]; text: string }> {
  const history = await auditOperations(session, `&action=${encodeURIComponent(action)}`);
  const [operation, ...others] = history.operations;
  if (!operation || others.length) throw new Error(`Expected one operation with ${action}, found ${history.operations.length} (HTTP ${history.status})`);
  const { events, text } = await auditOperationEvents(session, operation.id);
  return { operation, events, text };
}

/** Den Web's Permissions page: give a team its own permission set. */
export function createTeamPermissionSet(session: DenSession, teamId: string, allow: string[]): Promise<DenFetchResult> {
  return call(session, "/v1/permissions/sets", { method: "POST", body: { teamId, permissions: allow.map((key) => ({ key, status: "allow" })) } });
}

/** Den Web's Teams page: create a team. */
export function createTeamNamed(session: DenSession, name: string): Promise<DenFetchResult> {
  return call(session, "/v1/teams", { method: "POST", body: { name } });
}

/** The platform admin console marking an organization's DPA as signed. */
export function markOrganizationDpaSigned(platformAdmin: DenSession, organizationId: string, reason: string): Promise<DenFetchResult> {
  return call(platformAdmin, `/v1/admin/organizations/${encodeURIComponent(organizationId)}/dpa`, { method: "PATCH", body: { dpaSigned: true, reason } });
}

/** Analytics › Plugins & connectors reading usage of one kind. Returns the HTTP status. */
export async function readLibraryUsageStatus(session: DenSession, kind: "plugins" | "skills" | "connectors"): Promise<number> {
  return (await call(session, `/v1/library-usage/${kind}`)).response.status;
}

/** The audit page in Den Web, driven the way an owner uses its filters. */
export function auditPage(owner: User, page: Probe) {
  const settled = () => page.eventually(() => page.dom('div[aria-busy="false"]:has(> [data-testid="audit-empty"]), div[aria-busy="false"]:has([aria-controls^="audit-operation-"])'), {
    within: 30_000, label: "Applied audit history has finished loading", until: (value) => value.elements.length > 0,
  });
  const openEventTypes = async () => {
    // The filter mounts before its catalog loads; never click it while disabled.
    await page.eventually(() => page.dom('button[aria-label="Event type"]:not(:disabled)'), {
      within: 30_000, label: "Event catalog is ready", until: (value) => value.elements.length === 1,
    });
    await owner.click({ role: "button", label: "Event type" });
  };
  return {
    settled,
    openEventTypes,
    /** Pick an event type (optionally searching first) and apply the filters. */
    async filter(eventType: string, search?: string) {
      await openEventTypes();
      if (search) await owner.type({ label: "Search event types" }, search, { verify: true });
      await owner.click({ text: eventType });
      await owner.click({ role: "button", label: "Apply filters" });
      await settled();
    },
    async apply() {
      await owner.click({ role: "button", label: "Apply filters" });
      await settled();
    },
    async clear() {
      await owner.click({ role: "button", label: "Clear filters" });
      await owner.see({ label: "Search IDs" }, { value: "" });
      await owner.see({ role: "button", label: "Event type" }, { text: "All event types" });
    },
    /** Rows listed for this operation (0 or 1). */
    async rowCount(operationId: string) {
      return (await page.dom(`[aria-controls="audit-operation-${operationId}"]`)).elements.length;
    },
    /** The compact row's one-line summary: "<actor> <action>…". */
    async summary(operationId: string) {
      const row = await page.eventually(() => page.dom(`[aria-controls="audit-operation-${operationId}"]`), {
        within: 30_000, label: "the operation is listed", until: (value) => value.elements.length === 1,
      });
      return row.elements[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    },
    /** An expanded operation's event headlines (title · result · actor) and change rows (field | before | after). */
    async expanded(operationId: string, count: number) {
      const selector = `[id="audit-operation-${operationId}"] [data-testid="audit-event"]`;
      const events = await page.eventually(() => page.dom(selector), { within: 30_000, label: "every event is listed", until: (value) => value.elements.length === count });
      const heads = (await page.dom(`${selector} > div:nth-child(-n+2) > *`)).elements.map((element) => element.text);
      const cells = (await page.dom(`${selector} > div table tbody td:first-child > span, ${selector} > div table tbody td > span > span:last-child`)).elements.map((cell) => cell.text);
      return {
        events: events.elements.map((event, index) => ({ headline: heads.slice(index * 4, index * 4 + 3).join(" · "), text: event.text })),
        changes: Array.from({ length: Math.floor(cells.length / 3) }, (_, index) => cells.slice(index * 3, index * 3 + 3).join(" | ")),
      };
    },
    /** Type a 2000-01-<day> 01:00 AM local date into a native date control with the keyboard. */
    async enterPastDate(label: string, day: string) {
      for (const [segment, value] of ["1", day, "2000", "1", "0", "a"].entries()) {
        await owner.click({ label });
        for (let index = 0; index < 8; index += 1) await owner.press("ArrowLeft");
        for (let index = 0; index < segment; index += 1) await owner.press("ArrowRight");
        for (const key of value) await owner.press(key);
      }
      await owner.press("Tab");
      await owner.see({ label }, { value: `2000-01-${day.padStart(2, "0")}T01:00` });
    },
  };
}
