import { denFetch, type DenFetchResult, type DenSession } from "./den.ts";

/** `value` without trailing slashes, in linear time. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/**
 * The HTTP calls a person's browser or MCP client makes around personal API
 * keys and capability access. Every call uses the caller's own session or MCP
 * token, never a privileged shortcut.
 */
export interface ScopeOptions {
  /** Sent as x-openwork-org-id when the organization is not the active one. */
  organizationId?: string;
}

export interface McpToolResult {
  status: number;
  /** The tool result reported an error. */
  isError: boolean;
  /** The JSON-RPC envelope carried an error instead of a result. */
  rpcError: unknown;
  /** The first text content of the result. */
  text: string;
  /** That text parsed as JSON, or the text itself. */
  body: unknown;
  structured: unknown;
  /** Everything the client received. */
  raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headersFor(session: DenSession, options: ScopeOptions): Record<string, string> {
  return {
    authorization: `Bearer ${session.token}`,
    ...(options.organizationId ? { "x-openwork-org-id": options.organizationId } : {}),
  };
}

function sessionCall(session: DenSession, path: string, method: string, body: unknown, options: ScopeOptions): Promise<DenFetchResult> {
  return denFetch(session, path, { method, headers: headersFor(session, options), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** An MCP token for this person, as OpenWork's clients mint one. */
export async function mintMcpToken(session: DenSession, options: ScopeOptions = {}): Promise<string> {
  const result = await sessionCall(session, "/v1/mcp/token", "POST", { scopes: ["mcp:read", "mcp:write"] }, options);
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token) throw new Error(`Minting an MCP token for ${session.email} failed: HTTP ${result.response.status}`);
  return token;
}

/** One tools/call on OpenWork's MCP gateway, exactly as an MCP client sends it. */
export async function callMcpTool(den: { apiUrl: string }, token: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const response = await fetch(`${withoutTrailingSlashes(den.apiUrl)}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  const line = raw.split("\n").find((entry) => entry.startsWith("data:"));
  let envelope: unknown = null;
  try { envelope = JSON.parse(line ? line.slice(5) : raw); } catch { envelope = null; }
  const result = isRecord(envelope) && isRecord(envelope.result) ? envelope.result : null;
  const content = result && Array.isArray(result.content) ? result.content : [];
  const first = content.find((part) => isRecord(part) && part.type === "text");
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return {
    status: response.status,
    isError: result?.isError === true,
    rpcError: isRecord(envelope) ? envelope.error ?? null : null,
    text,
    body,
    structured: result?.structuredContent ?? null,
    raw,
  };
}

/** The organization membership id of the person with this email. */
export async function memberIdByEmail(session: DenSession, email: string, options: ScopeOptions = {}): Promise<string> {
  const result = await sessionCall(session, "/v1/org", "GET", undefined, options);
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) throw new Error(`Could not find ${email} in the organization: HTTP ${result.response.status}`);
  return id;
}

/** An admin adds a connection where each person enters their own API key. */
export async function createPersonalKeyConnection(
  admin: DenSession,
  input: { name: string; url: string; access: { orgWide: boolean; memberIds?: string[]; teamIds?: string[] } },
  options: ScopeOptions = {},
): Promise<string> {
  const result = await sessionCall(admin, "/v1/mcp-connections", "POST", { name: input.name, url: input.url, authType: "apikey", credentialMode: "per_member", access: input.access }, options);
  const id = isRecord(result.body) && typeof result.body.id === "string" ? result.body.id : "";
  if (!result.response.ok || !id) throw new Error(`Creating ${input.name} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  return id;
}

/** A person saves their own key from Your connections. */
export function saveMyConnectionKey(member: DenSession, connectionId: string, apiKey: string, options: ScopeOptions = {}): Promise<DenFetchResult> {
  return sessionCall(member, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/my-credential`, "PUT", { apiKey }, options);
}

/** A person tries to read their saved key back. */
export function readMyConnectionKey(member: DenSession, connectionId: string, options: ScopeOptions = {}): Promise<DenFetchResult> {
  return sessionCall(member, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/my-credential`, "GET", undefined, options);
}

/** The connection as this person's Your connections list shows it. */
export async function myConnectionRow(member: DenSession, connectionId: string, options: ScopeOptions = {}): Promise<Record<string, unknown> | null> {
  const result = await sessionCall(member, "/v1/mcp-connections", "GET", undefined, options);
  const rows = isRecord(result.body) && Array.isArray(result.body.connections) ? result.body.connections.filter(isRecord) : [];
  return rows.find((row) => row.id === connectionId) ?? null;
}

/** An admin creates a team with these members. */
export async function createTeamWith(admin: DenSession, name: string, memberIds: string[], options: ScopeOptions = {}): Promise<string> {
  const result = await sessionCall(admin, "/v1/teams", "POST", { name, memberIds }, options);
  const team = isRecord(result.body) && isRecord(result.body.team) ? result.body.team : null;
  const id = team && typeof team.id === "string" ? team.id : "";
  if (!result.response.ok || !id) throw new Error(`Creating team ${name} failed: HTTP ${result.response.status}`);
  return id;
}

/** An admin sets who is on a team. */
export function setTeamMembers(admin: DenSession, teamId: string, memberIds: string[], options: ScopeOptions = {}): Promise<DenFetchResult> {
  return sessionCall(admin, `/v1/teams/${encodeURIComponent(teamId)}`, "PATCH", { memberIds }, options);
}
