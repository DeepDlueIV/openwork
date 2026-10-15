import { denFetch } from "./den.ts";
import type { DenFetchResult, DenSession } from "./den.ts";

/**
 * The HTTP calls a real client makes when Den signs in to an MCP server as an
 * OAuth client: den-web saving and starting a connection, the browser following
 * the provider's authorize redirect, and the provider redirecting back to Den.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearer(session: DenSession, organizationId?: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, ...(organizationId ? { "x-openwork-org-id": organizationId } : {}) };
}

export type McpConnectionInput = {
  name: string;
  url: string;
  authType: "oauth" | "none" | "apikey";
  credentialMode: "shared" | "per_member";
  access: { orgWide: boolean };
};

/** Saves a connection the way den-web's add flow does and returns its id. */
export async function saveMcpConnection(session: DenSession, input: McpConnectionInput): Promise<string> {
  const created = await denFetch(session, "/v1/mcp-connections", { method: "POST", headers: bearer(session), body: JSON.stringify(input) });
  if (created.response.status !== 200 || !isRecord(created.body) || typeof created.body.id !== "string") {
    throw new Error(`Saving ${input.name} failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  }
  return created.body.id;
}

/** What den-web receives when someone clicks Sign in on a saved connection. */
export async function startMcpConnectionSignIn(session: DenSession, connectionId: string): Promise<{ status: number; authorizeUrl: string | null; text: string }> {
  const started = await denFetch(session, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`, { headers: bearer(session) });
  const authorizeUrl = isRecord(started.body) && typeof started.body.authorizeUrl === "string" ? started.body.authorizeUrl : null;
  return { status: started.response.status, authorizeUrl, text: started.text };
}

/** The browser visiting the provider's authorize page, which redirects back to Den's callback. */
export async function followProviderAuthorize(authorizeUrl: string): Promise<URL> {
  const redirect = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const location = redirect.headers.get("location");
  if (redirect.status !== 302 || !location) throw new Error(`The provider did not redirect back: HTTP ${redirect.status}`);
  return new URL(location, authorizeUrl);
}

/** The browser landing on Den's OAuth callback, as the provider sent it there. */
export async function visitMcpOAuthCallback(callback: URL): Promise<{ status: number; text: string }> {
  const completed = await fetch(callback, { signal: AbortSignal.timeout(30_000) });
  return { status: completed.status, text: await completed.text() };
}

/** The connection as Den lists it to the person managing it, or null when it is not listed. */
export async function readManageableMcpConnection(session: DenSession, connectionId: string): Promise<Record<string, unknown> | null> {
  const listed = await denFetch(session, "/v1/mcp-connections?scope=manageable", { headers: bearer(session) });
  const rows = isRecord(listed.body) && Array.isArray(listed.body.connections) ? listed.body.connections.filter(isRecord) : [];
  return rows.find((row) => row.id === connectionId) ?? null;
}

/** A provisioning client replacing a connection by its stable key (PUT /v1/mcp-connections/by-key/:key). */
export async function putMcpConnectionByKey(session: DenSession, organizationId: string, key: string, input: McpConnectionInput): Promise<DenFetchResult> {
  return denFetch(session, `/v1/mcp-connections/by-key/${encodeURIComponent(key)}`, {
    method: "PUT", headers: bearer(session, organizationId), body: JSON.stringify(input),
  });
}
