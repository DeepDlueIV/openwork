import { randomUUID } from "node:crypto";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { engineParity } from "./engine-parity.ts";
import { parityRecord } from "./engine-gateway-parity.ts";

/** Real capability search and execution in Den; external connector is an owned witness. */
export async function engineConnectorsParity(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const base = setup.use(await engineParity(seed, context));
  const proof = `Fresh report ${randomUUID()}`;
  const den = await seed.den({ web: false, org: { name: "Connector parity" }, mocks: {
    report: seed.mock({ allowUnauthenticatedMcp: true, tools: [
      { name: "current_amber_report", description: "Read the current amber report", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: proof }] } },
      { name: "unavailable_violet_status", description: "Read the unavailable violet status", inputSchema: { type: "object", properties: {} }, result: { isError: true, content: [{ type: "text", text: "Report service unavailable" }] } },
    ] }),
  } });
  await seed.orgConnection(den.admin, { name: "Amber Reports", url: den.mocks.report.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = parityRecord(parityRecord(org.body).organization).id;
  if (typeof orgId !== "string") throw new Error("Missing connector organization");
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const token = parityRecord(issued.body).token;
  if (!issued.response.ok || typeof token !== "string") throw new Error("Missing connector MCP token");
  const workspace = /\/workspace\/([^/]+)\/session/.exec(await base.route())?.[1];
  if (!workspace) throw new Error("Missing connector workspace");
  const connected = await base.request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "parity-fixture",
  });
  if (connected.status !== 200) throw new Error(`Connect reconciliation failed: ${connected.status}`);
  const resources = setup.move();
  return {
    ...base, den, proof,
    async connectHealth(repair = false) {
      return repair
        ? base.request(`/workspace/${workspace}/mcp/openwork-cloud/engine-refresh`, "POST", { provider: "opencode", model: "big-pickle" })
        : base.request(`/workspace/${workspace}/mcp/openwork-cloud/health?provider=opencode&model=big-pickle`);
    },
    async prepareReport(prompt: string, failed = false) {
      const search = { query: failed ? "unavailable_violet_status" : "current_amber_report", type: "mcp", limit: 1 };
      const steps: MockAgentToolStep[] = base.engine === "v2" ? [{ tool: "execute", arguments: { code: `
        const found = await tools["openwork-cloud"].search_capabilities(${JSON.stringify(search)});
        const result = typeof found === "string" ? JSON.parse(found) : found;
        const catalog = result.matches ? result : JSON.parse(result.content[0].text);
        return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: {} });
      ` } }] : [
        { tool: "search_capabilities", arguments: search },
        { tool: "execute_capability", arguments: { body: {} }, argumentsFrom: "capability-search" },
      ];
      await base.prepareTurn(prompt, "The report was not returned", steps, "last-tool-text");
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}

/**
 * A per-member Notion connection the member has not connected yet. The model
 * finds it and tries to use it: v1 as two direct calls, v2 inside one Code Mode
 * `execute`. Den answers with the real `needs_connection` status either way.
 */
export async function engineConnectorNeedsSignIn(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const den = await seed.den({ org: { name: "Connector sign-in" }, mocks: {
    notion: seed.mock({ tools: [
      { name: "search_pages", description: "Search Notion pages", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: "Roadmap" }] } },
    ] }),
  } });
  // The person is signed in to OpenWork Cloud, so the card's Connect starts Notion's own sign-in.
  const base = setup.use(await engineParity(seed, context, { env: {
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } }));
  await seed.signIn(base.app, den.admin, "Notion member");
  await seed.orgConnection(den.admin, { name: "Notion", url: den.mocks.notion.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } });
  const org = await seed.api(den.admin, "/v1/org");
  const orgId = parityRecord(parityRecord(org.body).organization).id;
  if (typeof orgId !== "string") throw new Error("Missing connector organization");
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const token = parityRecord(issued.body).token;
  if (!issued.response.ok || typeof token !== "string") throw new Error("Missing connector MCP token");
  const workspace = /\/workspace\/([^/]+)\/session/.exec(await base.route())?.[1];
  if (!workspace) throw new Error("Missing connector workspace");
  const connected = await base.request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "sign-in-fixture",
  });
  if (connected.status !== 200) throw new Error(`Connect reconciliation failed: ${connected.status}`);
  const resources = setup.move();
  return {
    ...base, den,
    async prepareNeedsSignIn(prompt: string, reply: string) {
      const search = { query: "Notion search pages", type: "mcp", limit: 1 };
      const steps: MockAgentToolStep[] = base.engine === "v2" ? [{ tool: "execute", arguments: { code: `
        const found = await tools["openwork-cloud"].search_capabilities(${JSON.stringify(search)});
        const result = typeof found === "string" ? JSON.parse(found) : found;
        const catalog = result.matches ? result : JSON.parse(result.content[0].text);
        try {
          return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: {} });
        } catch (error) {
          return String(error);
        }
      ` } }] : [
        { tool: "search_capabilities", arguments: search },
        { tool: "execute_capability", arguments: { body: {} }, argumentsFrom: "capability-search" },
      ];
      await base.prepareTurn(prompt, reply, steps);
    },
    async notionSignedIn() {
      const listed = parityRecord((await seed.api(den.admin, "/v1/mcp-connections?scope=usable")).body).connections;
      return Array.isArray(listed) && listed.some((entry) => parityRecord(entry).name === "Notion" && parityRecord(entry).connectedForMe === true);
    },
    /** Notion's sign-in opens in its own tab; bring the chat back in front. */
    async returnToOpenWork() {
      await base.app.client.send("Page.bringToFront");
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
