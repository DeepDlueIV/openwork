import { createHash, randomBytes } from "node:crypto";
import { denFetch, type DenRef, type DenSession } from "./den.ts";

/**
 * Behaviors for the MCP gateway, consent, agent sign-up, CLI sign-in, remote
 * session, tenant isolation and private-key core journeys. Each one is what a
 * real client does over Den's public HTTP API, so a core spec can assert on
 * what that client observed.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

export interface RateLimitedDen {
  apiUrl: string;
  webUrl: string;
  email: string;
  password: string;
  orgName: string;
  /** The proxy Den trusts; requests arrive as if forwarded by it. */
  trustedProxy: string;
}

export interface McpTokenIssuanceAudit {
  /** The unauthenticated challenge pointed at the agent's protected-resource metadata. */
  discoveredResource: string;
  /** Authorization requests with a missing, unknown or repeated resource. */
  authorizeRejections: Array<{ status: number; redirected: boolean; error: string }>;
  /** Code exchanges with a missing, unknown or repeated resource. */
  tokenRejections: Array<{ status: number; cacheControl: string | null; error: string; issuedToken: boolean }>;
  /** The same code exchanged with the discovered resource. */
  issuedJwt: boolean;
  /** Public auth throttling once one client address exhausted it. */
  throttled: boolean;
  spoofedClientStatus: number;
  otherClientStatus: number;
  /** 25 MCP initialize calls with the issued token after throttling. */
  mcpStatuses: number[];
  mcpChallenged: boolean;
  malformedTokenStatus: number;
  malformedTokenChallenge: string;
}

/**
 * A synthetic public OAuth client discovers the agent resource, is refused a
 * code or token for any other resource, gets one for the right resource, and
 * keeps using it after the public auth endpoints throttle its address.
 */
export async function auditMcpTokenIssuance(den: RateLimitedDen): Promise<McpTokenIssuanceAudit> {
  const origin = den.webUrl;
  const client = "198.51.100.10";
  const request = (path: string, init: RequestInit = {}, forwardedFor = `${client}, ${den.trustedProxy}`) =>
    fetch(`${den.apiUrl}${path}`, {
      ...init, redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { origin, "x-forwarded-for": forwardedFor, ...init.headers },
    });

  const login = await request("/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: den.email, password: den.password }),
  });
  if (login.status !== 200) throw new Error(`Sign-in failed: HTTP ${login.status}`);
  const cookies = new Map<string, string>();
  const keep = (response: Response) => {
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";")[0];
      cookies.set(pair.slice(0, pair.indexOf("=")), pair);
    }
  };
  keep(login);
  const cookie = () => [...cookies.values()].join("; ");
  const listed: unknown = await (await request("/api/auth/organization/list", { headers: { cookie: cookie() } })).json();
  const organization = Array.isArray(listed) ? listed.find((entry) => isRecord(entry) && entry.name === den.orgName) : undefined;
  const selected = await request("/api/auth/organization/set-active", {
    method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify({ organizationId: stringField(organization, "id") }),
  });
  if (selected.status !== 200) throw new Error(`Selecting the organization failed: HTTP ${selected.status}`);
  keep(selected);

  const redirectUri = "http://127.0.0.1:19876/callback";
  const scope = "mcp:read mcp:write offline_access";
  const registration = await request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Rate limit regression", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope }),
  });
  if (registration.status !== 201) throw new Error(`Registration failed: HTTP ${registration.status}`);
  const clientId = stringField(await registration.json(), "client_id");

  const challenge = await request("/mcp/agent");
  await challenge.arrayBuffer();
  const metadataUrl = challenge.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
  if (challenge.status !== 401 || !metadataUrl) throw new Error(`No protected-resource challenge: HTTP ${challenge.status}`);
  const resource = stringField(await (await request(new URL(metadataUrl).pathname)).json(), "resource");

  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope, resource, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
  const wrongResources = [[], ["https://unrelated.example/mcp"], [resource, resource]];
  const authorizeRejections: McpTokenIssuanceAudit["authorizeRejections"] = [];
  for (const resources of wrongResources) {
    const query = new URLSearchParams(authorize);
    query.delete("resource");
    for (const value of resources) query.append("resource", value);
    const rejected = await request(`/api/auth/oauth2/authorize?${query}`, { headers: { cookie: cookie() } });
    const body: unknown = await rejected.json().catch(() => null);
    authorizeRejections.push({ status: rejected.status, redirected: rejected.headers.has("location"), error: isRecord(body) && typeof body.error === "string" ? body.error : "" });
  }
  const authorization = await request(`/api/auth/oauth2/authorize?${authorize}`, { headers: { cookie: cookie() } });
  const consentLocation = authorization.headers.get("location");
  if (authorization.status !== 302 || !consentLocation) throw new Error(`Authorize did not redirect: HTTP ${authorization.status}`);
  const consent = await request("/api/auth/oauth2/consent", {
    method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify({ accept: true, scope, oauth_query: new URL(consentLocation, origin).search.slice(1) }),
  });
  if (consent.status !== 200) throw new Error(`Consent failed: HTTP ${consent.status}`);
  const code = new URL(stringField(await consent.json(), "url")).searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");

  const tokenRejections: McpTokenIssuanceAudit["tokenRejections"] = [];
  const tokenBody = (resources: string[]) => {
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
    for (const value of resources) body.append("resource", value);
    return body;
  };
  for (const resources of wrongResources) {
    const rejected = await request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody(resources) });
    const body: unknown = await rejected.json().catch(() => null);
    tokenRejections.push({
      status: rejected.status, cacheControl: rejected.headers.get("cache-control"),
      error: isRecord(body) && typeof body.error === "string" ? body.error : "",
      issuedToken: isRecord(body) && ("access_token" in body || "refresh_token" in body),
    });
  }
  const exchange = await request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenBody([resource]) });
  const exchanged: unknown = await exchange.json().catch(() => null);
  const token = isRecord(exchanged) && typeof exchanged.access_token === "string" ? exchanged.access_token : "";

  let throttled = false;
  for (let attempt = 0; attempt < 25 && !throttled; attempt++) {
    const response = await request("/api/auth/jwks");
    await response.arrayBuffer();
    throttled = response.status === 429;
  }
  const spoofed = await request("/api/auth/jwks", {}, `203.0.113.44, ${client}, ${den.trustedProxy}`);
  await spoofed.arrayBuffer();
  const other = await request("/api/auth/jwks", {}, `198.51.100.11, ${den.trustedProxy}`);
  await other.arrayBuffer();

  const mcpStatuses: number[] = [];
  let mcpChallenged = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await request("/mcp/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "regression-test", version: "1" } } }),
    });
    const text = await response.text();
    mcpStatuses.push(response.status === 200 && text.includes("serverInfo") ? 200 : response.status);
    mcpChallenged ||= response.headers.has("www-authenticate");
  }
  const malformed = await request("/mcp/agent", { headers: { authorization: "Bearer invalid.jwt.token" } });
  await malformed.arrayBuffer();

  return {
    discoveredResource: resource, authorizeRejections, tokenRejections,
    issuedJwt: exchange.status === 200 && token.split(".").length === 3,
    throttled, spoofedClientStatus: spoofed.status, otherClientStatus: other.status,
    mcpStatuses, mcpChallenged,
    malformedTokenStatus: malformed.status, malformedTokenChallenge: malformed.headers.get("www-authenticate") ?? "",
  };
}

export interface McpToolCall { status: number; json: unknown }

/** One MCP tools/call on Den's agent gateway with a bearer token, as any MCP client makes it. */
export async function callAgentGatewayTool(apiUrl: string, token: string, name: string, args: Record<string, unknown>): Promise<McpToolCall> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  if (!response.ok) return { status: response.status, json: null };
  const data = raw.split("\n").find((line) => line.startsWith("data:"));
  const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
  const result = isRecord(frame) ? frame.result : null;
  if (isRecord(result) && result.structuredContent !== undefined) return { status: response.status, json: result.structuredContent };
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const text = content.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "").join("");
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, json: text }; }
}

export interface ClaimableWorkspace { bootstrapId: string; assertion: string }

/** An agent with no account provisions a workspace someone can claim later, and keeps its assertion. */
export async function bootstrapClaimableWorkspace(den: DenRef, workspaceName: string): Promise<ClaimableWorkspace> {
  const created = await denFetch(den, "/v1/bootstrap/workspace", { method: "POST", body: JSON.stringify({ workspaceName, claimRoles: ["owner"] }) });
  if (created.response.status !== 200 || !isRecord(created.body)) throw new Error(`Workspace bootstrap failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  return { bootstrapId: stringField(created.body.setup, "id"), assertion: stringField(created.body.identity, "assertion") };
}

/** RFC 7523 JWT-bearer exchange of the agent's assertion at Den's token endpoint. */
export async function exchangeAgentAssertion(den: DenRef, assertion: string): Promise<{ status: number; accessToken: string; scope: string; error: string }> {
  const result = await denFetch(den, "/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const field = (key: string) => isRecord(result.body) && typeof result.body[key] === "string" ? result.body[key] : "";
  return { status: result.response.status, accessToken: field("access_token"), scope: field("scope"), error: field("error") };
}

/** The agent asks for the code and link it hands the person who will claim the workspace. */
export async function requestWorkspaceClaimCode(den: DenRef, workspace: ClaimableWorkspace): Promise<{ userCode: string; verificationUrl: string }> {
  const result = await denFetch(den, `/v1/bootstrap/workspace/${workspace.bootstrapId}/claim`, { method: "POST", headers: { authorization: `Bearer ${workspace.assertion}` } });
  return { userCode: stringField(result.body, "user_code"), verificationUrl: stringField(result.body, "verification_uri_complete") };
}

/** The agent polls whether its workspace has been claimed. */
export async function readWorkspaceClaim(den: DenRef, workspace: ClaimableWorkspace): Promise<{ status: number; state: string; reconciled: boolean }> {
  const result = await denFetch(den, `/v1/bootstrap/workspace/${workspace.bootstrapId}/claim`, { headers: { authorization: `Bearer ${workspace.assertion}` } });
  const body = isRecord(result.body) ? result.body : {};
  return { status: result.response.status, state: typeof body.state === "string" ? body.state : "", reconciled: body.reconciled === true };
}

function bearerFor(session: DenSession, organizationId?: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, ...(organizationId ? { "x-openwork-org-id": organizationId } : {}) };
}

/** The id of the organization `name` that a signed-in person belongs to. */
export async function findMyOrganizationId(session: DenSession, name: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: bearerFor(session) });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs : [];
  const found = orgs.find((org) => isRecord(org) && org.name === name);
  if (!result.response.ok || !isRecord(found) || typeof found.id !== "string") throw new Error(`Finding ${name} failed: HTTP ${result.response.status}`);
  return found.id;
}

export type AppTelemetryEvent = {
  type: "session.active" | "task.started";
  timestamp: string;
  source: "app";
  sessionId: string;
  dimensions: Array<{ type: string; value: string; label: string }>;
};

/** One app telemetry event carrying the model a session used and how it was chosen. */
export function modelTelemetryEvent(sessionId: string, type: AppTelemetryEvent["type"], model: string, selection: "default" | "manual"): AppTelemetryEvent {
  return {
    type, timestamp: new Date().toISOString(), source: "app", sessionId,
    dimensions: [{ type: "model", value: model, label: model }, { type: "model_selection", value: selection, label: selection }],
  };
}

/** The desktop app reports telemetry events for an organization; returns the HTTP status. */
export async function sendAppTelemetry(session: DenSession, organizationId: string, events: AppTelemetryEvent[]): Promise<number> {
  const result = await denFetch(session, "/v1/telemetry/ingest", { method: "POST", headers: bearerFor(session, organizationId), body: JSON.stringify({ events }) });
  return result.response.status;
}

/** What den-web's analytics page reads for an organization: the status and its model section. */
export async function readOrganizationModelAnalytics(session: DenSession, organizationId: string): Promise<{ status: number; models: Record<string, unknown> | null }> {
  const result = await denFetch(session, "/v1/telemetry/analytics", { headers: bearerFor(session, organizationId) });
  const models = isRecord(result.body) && isRecord(result.body.models) ? result.body.models : null;
  return { status: result.response.status, models };
}

/** Den asked to send a signed-in person back to `returnUrl` (a self-hosted web origin) after sign-in. */
export async function requestSignInHandoff(session: DenSession, returnUrl: string): Promise<{ status: number; returnUrl: string | null; error: string | null }> {
  const result = await denFetch(session, "/v1/auth/desktop-handoff", { method: "POST", headers: bearerFor(session), body: JSON.stringify({ returnUrl }) });
  const body = isRecord(result.body) ? result.body : {};
  return {
    status: result.response.status,
    returnUrl: typeof body.returnUrl === "string" ? body.returnUrl : null,
    error: typeof body.error === "string" ? body.error : null,
  };
}

/** An owner approves (or removes) a self-hosted web origin for their organization; approving needs a recent sign-in. */
export async function setApprovedWebOrigin(session: DenSession, organizationId: string, origin: string, approved: boolean): Promise<number> {
  if (approved) {
    const result = await denFetch(session, "/v1/org/web-origins", { method: "POST", headers: bearerFor(session, organizationId), body: JSON.stringify({ origin }) });
    return result.response.status;
  }
  const listed = await denFetch(session, "/v1/org/web-origins", { headers: bearerFor(session, organizationId) });
  const entries = isRecord(listed.body) && Array.isArray(listed.body.origins) ? listed.body.origins : [];
  const entry = entries.find((item) => isRecord(item) && item.origin === origin);
  if (!isRecord(entry) || typeof entry.id !== "string") return 404;
  const removed = await denFetch(session, `/v1/org/web-origins/${encodeURIComponent(entry.id)}`, { method: "DELETE", headers: bearerFor(session, organizationId) });
  return removed.response.status;
}
