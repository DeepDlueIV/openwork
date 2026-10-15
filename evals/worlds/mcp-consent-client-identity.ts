import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { close, isRecord, listen } from "./openwork-server-cli.ts";

function clientIdFrom(value: unknown): string {
  const id = isRecord(value) ? value.client_id : undefined;
  if (typeof id !== "string" || !id) throw new Error("Missing client_id");
  return id;
}

export interface McpConsentOptions {
  /**
   * Also register a write and a read-only client whose callbacks exchange the
   * delivered code with PKCE, plus a second workspace to pick, so a spec can
   * check what an accepted grant actually issues. Off by default.
   */
  grants?: boolean;
  /**
   * A client that then asks to return to an address it never registered, so
   * the browser must land on OpenWork's own error page. Off by default.
   */
  misconfigured?: boolean;
  /**
   * A second, API-only Den with production auth rate limits behind a trusted
   * proxy, for checking that throttling never invalidates MCP tokens. Off by default.
   */
  rateLimitedDen?: boolean;
}

const CLAIM_NAMESPACE = "https://consent.example.test";
export const consentGrantCases = [
  { id: "write", name: "Write agent", scope: "mcp:read mcp:write offline_access" },
  { id: "read", name: "Read-only agent", scope: "mcp:read" },
] as const;

type GrantExchange = { status: number; scope: string; tokenScope: string; organizationId: string; jwt: boolean };

/**
 * A signed-in member and named loopback, named hosted, and unnamed MCP clients.
 * A local callback witnesses denial without contacting an external service.
 */
export async function mcpConsentClientIdentity(seed: Seed, options: McpConsentOptions = {}) {
  const den = await seed.den({
    org: { name: "Consent identity org", members: {} },
    ...(options.grants ? { env: { DEN_MCP_CLAIM_NAMESPACE: CLAIM_NAMESPACE } } : {}),
  });
  const scope = "openid profile email mcp:read mcp:write";

  async function register(clientName: string | null, redirectUri: string, clientScope = scope) {
    const registered = await denFetch(den.ref, "/register", {
      method: "POST",
      body: JSON.stringify({
        ...(clientName ? { client_name: clientName } : {}), redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: clientScope,
      }),
    });
    if (registered.response.status !== 201) throw new Error(`Client registration failed: HTTP ${registered.response.status}`);
    return clientIdFrom(registered.body);
  }

  async function authorizeUrl(clientName: string | null, redirectUri: string) {
    const clientId = await register(clientName, redirectUri);
    const state = randomBytes(8).toString("hex");
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope,
      resource: `${den.ref.apiUrl}/mcp/agent`, state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
    });
    return { clientId, redirectUri, state, url: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}`, authorizePath: `/api/auth/oauth2/authorize?${query}` };
  }

  /**
   * The consent page with a live signed query: authorize as the signed-in
   * member and follow Den's redirect onto /mcp/consent instead of the
   * workspace chooser, so the spec can show the consent step on its own.
   */
  async function consentUrl(authorizePath: string): Promise<string> {
    const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
    });
    const cookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
    if (!cookie) throw new Error(`Could not sign in for the consent URL: HTTP ${signedIn.response.status}`);
    const authorized = await seed.api(den.admin, authorizePath, { headers: { cookie }, redirect: "manual" });
    const location = authorized.response.headers.get("location") ?? (isRecord(authorized.body) && typeof authorized.body.url === "string" ? authorized.body.url : "");
    if (!location) throw new Error(`Authorize did not redirect: HTTP ${authorized.response.status}`);
    const signed = new URL(location, den.ref.webUrl);
    return `${den.ref.webUrl}/mcp/consent${signed.search}`;
  }

  const grantClients = new Map<string, { clientId: string; verifier: string; redirectUri: string; resource: string; state: string }>();
  const grantResults = new Map<string, GrantExchange | null>();
  /** The synthetic client exchanges only the code delivered to its own callback, with its state and PKCE verifier. */
  async function exchange(path: string, code: string | null, state: string | null): Promise<GrantExchange | null> {
    const client = grantClients.get(path);
    if (!code || !client || state !== client.state) return null;
    const result = await denFetch(den.ref, "/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId, code,
        code_verifier: client.verifier, redirect_uri: client.redirectUri, resource: client.resource }),
    });
    const token = isRecord(result.body) && typeof result.body.access_token === "string" ? result.body.access_token : "";
    const parts = token.split(".");
    const claims: unknown = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : null;
    const orgClaim = isRecord(claims) ? claims[`${CLAIM_NAMESPACE}/org_id`] : undefined;
    return { status: result.response.status, jwt: parts.length === 3,
      scope: isRecord(result.body) && typeof result.body.scope === "string" ? result.body.scope : "",
      tokenScope: isRecord(claims) && typeof claims.scope === "string" ? claims.scope : "",
      organizationId: typeof orgClaim === "string" ? orgClaim : "" };
  }

  const callbacks: Array<{ hasCode: boolean; error: string | null; state: string | null }> = [];
  const callback = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || (url.pathname !== "/callback" && !grantClients.has(url.pathname))) {
      response.writeHead(404).end();
      return;
    }
    if (url.pathname === "/callback") {
      callbacks.push({ hasCode: url.searchParams.has("code"), error: url.searchParams.get("error"), state: url.searchParams.get("state") });
    } else {
      try {
        grantResults.set(url.pathname, await exchange(url.pathname, url.searchParams.get("code"), url.searchParams.get("state")));
      } catch {
        grantResults.set(url.pathname, { status: 0, scope: "", tokenScope: "", organizationId: "", jwt: false });
      }
    }
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>Consent callback</title><h1>Authorization returned to client</h1>");
  });
  const callbackOrigin = await listen(callback);
  try {
    const loopback = { name: "Terminal agent", redirectHost: new URL(callbackOrigin).host, ...await authorizeUrl("Terminal agent", `${callbackOrigin}/callback`) };
    const hosted = { name: "Hosted assistant", redirectHost: "assistant.example.com", ...await authorizeUrl("Hosted assistant", "https://assistant.example.com/oauth/callback") };
    const unnamed = { redirectHost: "agent.example.net", ...await authorizeUrl(null, "https://agent.example.net/oauth/callback") };

    const grants: Array<{ id: string; name: string; scope: string; url: string }> = [];
    let selectedOrg = { id: "", name: "" };
    if (options.grants) {
      const selectedName = "Consent selected workspace";
      const created = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: selectedName }) });
      const organization = isRecord(created.body) ? created.body.organization : undefined;
      const selectedId = isRecord(organization) ? organization.id : undefined;
      if (!created.response.ok || typeof selectedId !== "string") throw new Error(`Organization setup failed: HTTP ${created.response.status}`);
      selectedOrg = { id: selectedId, name: selectedName };
      for (const entry of consentGrantCases) {
        const path = `/callback/${entry.id}`;
        const redirectUri = `${callbackOrigin}${path}`;
        const clientId = await register(entry.name, redirectUri, entry.scope);
        const verifier = randomBytes(32).toString("base64url");
        const state = randomBytes(16).toString("hex");
        const resource = `${den.ref.apiUrl}/mcp/agent`;
        grantClients.set(path, { clientId, verifier, redirectUri, resource, state });
        const query = new URLSearchParams({
          client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: entry.scope,
          resource, state, prompt: "consent", code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        });
        grants.push({ ...entry, url: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}` });
      }
    }

    let misconfigured: { authorizeUrl: string } | null = null;
    if (options.misconfigured) {
      const registeredRedirect = "http://127.0.0.1:39421/callback";
      const clientId = await register("Misconfigured MCP client", registeredRedirect, "mcp:read");
      const query = new URLSearchParams({
        client_id: clientId, redirect_uri: "http://127.0.0.1:39421/somewhere-else", response_type: "code",
        scope: "mcp:read", resource: `${den.ref.apiUrl}/mcp/agent`, state: randomBytes(8).toString("hex"),
        code_challenge_method: "S256", code_challenge: randomBytes(32).toString("base64url"),
      });
      misconfigured = { authorizeUrl: `${den.ref.apiUrl}/api/auth/oauth2/authorize?${query}` };
    }

    const rateLimitedOrg = "MCP Auth Regression";
    const rateLimited = options.rateLimitedDen
      ? await seed.den({ web: false, org: { name: rateLimitedOrg, members: {} }, env: { OPENWORK_DEV_MODE: "0", DEN_TRUSTED_PROXIES: "192.0.2.10" } })
      : null;

    const web = await seed.web({ den, headless: true, viewport: { width: 1280, height: 1000 } });
    return {
      den, web, loopback, hosted, unnamed, consentUrl, admin: { email: den.admin.email, password: den.admin.password },
      grants, selectedOrg, misconfigured,
      /** The API-only Den with production auth limits; its trusted proxy is 192.0.2.10. */
      rateLimited: rateLimited ? { apiUrl: rateLimited.ref.apiUrl, webUrl: rateLimited.ref.webUrl, email: rateLimited.admin.email, password: rateLimited.admin.password, orgName: rateLimitedOrg, trustedProxy: "192.0.2.10" } : null,
      callbacks: () => callbacks.map(entry => ({ ...entry })),
      /** What a grant client's token exchange returned, or undefined before its callback. */
      grantResult: (id: string) => grantResults.get(`/callback/${id}`),
      async [Symbol.asyncDispose]() { await close(callback); },
    };
  } catch (error) {
    await close(callback);
    throw error;
  }
}
