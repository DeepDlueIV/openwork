import { expect } from "vitest";
import { denFetch, needs, server, test } from "@openwork/testkit";
import { redirectDiscoveryMock } from "../worlds/mcp-redirect-discovery.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

for (const mode of ["valid", "issuer-mismatch", "missing"] as const) {
  test(`a member can safely attempt sign-in behind a login redirect with ${mode} metadata`, { timeout: 300_000 }, async ({ place, evidence }) => {
    needs({ commands: ["bun"], placement: "local" });
    const mock = await redirectDiscoveryMock();
    try {
      await using den = await server({
        place, web: false, env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
        org: { name: `exp-mcpredirect-${Date.now()}`, members: { tester: { name: "Synthetic Member" } } },
      });
      const headers = { authorization: `Bearer ${den.admin.token}` };
      const created = await denFetch(den.admin, "/v1/mcp-connections", { method: "POST", headers, body: JSON.stringify({
        name: "exp-mcpredirect-provider", url: mock.mcpUrl, authType: "oauth", credentialMode: "per_member",
        oauthClient: { clientId: "exp-mcpredirect-client", clientSecret: "exp-mcpredirect-synthetic-secret" }, access: { orgWide: true },
      }) });
      expect(created.response.status, created.text).toBe(200);
      if (!isRecord(created.body) || typeof created.body.id !== "string") throw new Error("Connection id missing");
      const connectionId = created.body.id;
      mock.setMode(mode);
      {
        evidence.recordAssertionEvidence("A synthetic provider redirects unauthenticated MCP requests", "Configured MCP endpoint returns HTTP 302 with an HTML login target; no real provider is contacted.", true);
      }
      const started = await denFetch(den.members.tester, `/v1/mcp-connections/${connectionId}/connect/start`, { headers: { authorization: `Bearer ${den.members.tester.token}` } });
      {
        const discovered = mock.requests.some((entry) => entry.path === "/.well-known/oauth-protected-resource/mcp/team");
        evidence.recordAssertionEvidence("Metadata discovery replaces the HTML routing failure", `HTTP ${started.response.status}; HTML routing error: ${started.text.includes("MCP_HTTP_HTML_RESPONSE")}; requests: ${mock.requests.map((entry) => `${entry.method} ${entry.path}`).join(" → ")}.`, discovered);
        expect(discovered).toBe(true);
        expect(mock.requests.some((entry) => entry.path === "/login")).toBe(false);
        expect(mock.requests.some((entry) => entry.authorized)).toBe(false);
        evidence.recordAssertionEvidence("The redirect is never followed and no credential reaches it", "MCP POST 302 → path-suffixed metadata GET; zero login-page requests and zero authenticated provider requests.", true);
      }
      {
        if (mode === "valid") {
          expect(started.response.status, started.text).toBe(200);
          expect(started.body).toMatchObject({ status: "needs_auth" });
          if (!isRecord(started.body) || typeof started.body.authorizeUrl !== "string") throw new Error("Authorization URL missing");
          const authorize = new URL(started.body.authorizeUrl);
          expect(authorize.origin + authorize.pathname).toBe(`${mock.origin}/authorize`);
          expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        } else {
          expect(started.response.status, started.text).toBe(424);
          expect(started.text).not.toContain("MCP_HTTP_HTML_RESPONSE");
          expect(started.text).toContain(mode === "missing" ? "MCP_OAUTH_SIGN_IN_METADATA_MISSING" : "MCP_MCP_INITIALIZE");
          if (mode === "missing") expect(started.text).toContain("ask the server administrator");
          else expect(mock.requests.some((entry) => entry.path === "/.well-known/oauth-authorization-server/mcp/team")).toBe(true);
          expect(isRecord(started.body) && "authorizeUrl" in started.body).toBe(false);
        }
        expect(mock.requests.some((entry) => entry.path === "/token" || entry.path === "/authorize")).toBe(false);
        evidence.recordAssertionEvidence("OAuth requires valid resource and issuer metadata", `${mode}: connect/start HTTP ${started.response.status}; no token exchange or browser login request. An inconsistent issuer still requires the planned manual sign-in configuration.`, true);
      }
    } finally { await mock.stop(); }
  });
}
