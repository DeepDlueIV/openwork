import { expect } from "vitest";
import { spec, screenshot } from "@openwork/testkit";
import { isRecord, manualOAuth } from "../worlds/mcp-manual-oauth.ts";

const test = spec.world(manualOAuth, { timeout: 600_000, needs: { commands: ["bun", "pnpm"], placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

test("an admin explicitly saves published sign-in addresses before a public client can connect", async ({ world, user, probe, step, evidence }) => {
  const baseline = process.env.EXP_MCPMANUAL_BASELINE === "1";
  await step("strict discovery refuses inconsistent metadata before any authorization", async () => {
    await user.reload();
    await user.see({ text: "exp-mcpmanual-provider" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Sign in" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 40_000, label: "isolated sign-in error tab", until: value => Boolean(value) });
    if (!tab) throw new Error("Sign-in tab missing");
    try {
      const person = user.on(tab);
      await person.resizeViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
      await person.see({ text: /Couldn't start the exp-mcpmanual-provider sign-in/ }, { timeoutMs: 40_000 });
      await person.reload();
      await person.see({ text: /Couldn't start the exp-mcpmanual-provider sign-in/ }, { timeoutMs: 40_000 });
      await person.see({ text: baseline ? /MCP lifecycle failed during initialization/ : /This server's sign-in information is inconsistent/ });
      expect(await world.healthy(tab)).toBe(true);
      await person.screenshot();
      await person.click({ text: "Technical details" });
      await person.see({ text: baseline ? /^MCP_MCP_INITIALIZE$/ : /^MCP_OAUTH_ISSUER_MISMATCH$/ });
      expect(world.requests.some(request => request.path === "/.well-known/oauth-authorization-server/mcp/team")).toBe(true);
      expect(world.requests.some(request => request.path === "/authorize" || request.authorized)).toBe(false);
      expect(world.exchanges()).toBe(0);
      evidence.recordAssertionEvidence(baseline ? "Fetched dev reproduces the old generic issuer failure" : "Issuer mismatch is actionable and still fails closed", "The path-suffixed metadata document is fetched, its root issuer is rejected, and no authorization or token exchange occurs.", true);
    } finally { await user.on(tab).navigate("about:blank"); tab.client.close(); }
  });
  if (baseline) return;
  await step("published addresses remain read-only until the admin confirms and saves", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${world.connectionId}`);
    await user.see({ role: "button", label: "Settings" }, { timeoutMs: 60_000 });
    await user.reload();
    await user.see({ role: "button", label: "Settings" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Settings" });
    await user.click({ text: "Advanced sign-in settings" });
    await user.click({ role: "button", label: "Use addresses published by this server" });
    await user.see({ testId: "manual-oauth-prefill" }, { timeoutMs: 40_000 });
    await user.see({ text: /not verified by OpenWork/ });
    expect(await world.connection()).not.toHaveProperty("manualOAuthEndpoints", expect.anything());
    expect(world.exchanges()).toBe(0);
    await user.wheelAt({ x: 1100, y: 800, deltaY: 900 });
    expect(await world.advancedHealthy()).toBe(true);
    await screenshot(world.web, { caption: "Advanced sign-in settings — published addresses await confirmation" });
    expect(await world.advancedHealthy()).toBe(true);
    await user.click({ role: "button", label: "Confirm addresses in form" });
    await user.see({ testId: "manual-oauth-authorization-endpoint" }, { value: `${world.origin}/authorize` });
    await user.see({ testId: "manual-oauth-token-endpoint" }, { value: `${world.origin}/token` });
    expect(await world.connection()).toMatchObject({ manualOAuthEndpoints: null, connectedForMe: false });
    await user.click({ role: "button", label: "Save changes" });
    await user.click({ role: "button", label: "Save and sign everyone out" });
    await probe.eventually(() => world.connection(), { within: 40_000, label: "saved exact manual endpoint pair", until: row => isRecord(row) && isRecord(row.manualOAuthEndpoints) });
    expect(await world.connection()).toMatchObject({ manualOAuthEndpoints: { authorizationEndpoint: `${world.origin}/authorize`, tokenEndpoint: `${world.origin}/token` }, oauthClientId: "exp-mcpmanual-client", connectedForMe: false });
    const memberListing = await probe.api(world.den.members.member, "/v1/mcp-connections?scope=usable");
    expect(memberListing.text).not.toContain("manualOAuthEndpoints");
    expect(world.exchanges()).toBe(0);
    await user.reload();
    await user.see({ role: "button", label: "Settings" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Settings" });
    await user.see({ testId: "manual-oauth-authorization-endpoint" }, { value: `${world.origin}/authorize` });
    await user.wheelAt({ x: 1100, y: 800, deltaY: 900 });
    await screenshot(world.web, { caption: "Advanced sign-in settings — saved exact endpoint pair" });
    evidence.recordAssertionEvidence("Prefill never auto-applies", "Preview and form confirmation made no configuration/token change. Only Save persists the exact pair; usable desktop-facing listings omit it.", true);
  });
  const discoveryCount = () => world.requests.filter(request => request.path.includes(".well-known")).length;
  const before = discoveryCount();
  await step("public-client browser approval completes with S256 and no discovery", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/your-connections`);
    await user.see({ text: "exp-mcpmanual-provider" }, { timeoutMs: 60_000 });
    await user.reload();
    await user.see({ text: "exp-mcpmanual-provider" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Sign in" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 40_000, label: "static authorization page", until: value => Boolean(value) });
    if (!tab) throw new Error("Authorization tab missing");
    try {
      const person = user.on(tab);
      await person.see({ role: "heading", label: "Approve OpenWork sign-in" }, { timeoutMs: 40_000 });
      await person.reload();
      await person.see({ role: "heading", label: "Approve OpenWork sign-in" });
      expect(discoveryCount()).toBe(before);
      await person.screenshot();
      await person.click({ role: "button", label: "Approve access" });
      await probe.eventually(() => world.exchanges(), { within: 40_000, label: "one PKCE-bound public-client exchange", until: count => count === 1 });
    } finally { tab.client.close(); }
    await user.reload();
    await user.see({ text: /^Ready$/ }, { timeoutMs: 60_000 });
    expect(await world.connection()).toMatchObject({ connectedForMe: true, needsReconnect: false, readiness: { status: "ready" } });
    expect(await world.healthy(world.web)).toBe(true);
    await user.screenshot();
    const tools = await world.api(`/v1/mcp-connections/${world.connectionId}/tools`);
    expect(tools.response.status, tools.text).toBe(200);
    expect(tools.body).toMatchObject({ tools: [{ name: "exp_mcpmanual_ping" }] });
    expect(discoveryCount()).toBe(before);
    expect(world.requests.some(request => request.rpc === "tools/list" && request.authorized)).toBe(true);
    expect(world.requests.some(request => request.path === "/login")).toBe(false);
    expect(world.requests.filter(request => request.path === "/token")).toEqual([expect.objectContaining({ resource: `${world.origin}/mcp/team`, secretSent: false })]);
    evidence.recordAssertionEvidence("Ready is backed by real authenticated tools/list", "The actual browser approved a one-use code. The AS enforced S256, client ID, redirect and MCP resource; no client secret or metadata requests; the member's saved grant and real MCP tool catalog are ready.", true);
  });
  await step("changing an exact endpoint invalidates all member grants and pending transactions", async () => {
    const startMember = async () => {
      const result = await probe.api(world.den.members.member, `/v1/mcp-connections/${world.connectionId}/connect/start`);
      expect(result.response.status, result.text).toBe(200);
      if (!isRecord(result.body) || typeof result.body.authorizeUrl !== "string") throw new Error("Member authorization URL missing");
      return result.body.authorizeUrl;
    };
    const first = await startMember();
    const pending = await startMember();
    const approve = async (authorization: string) => {
      const url = new URL(authorization); url.pathname = "/approve";
      const response = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000) });
      expect(response.status).toBe(302);
      const callback = response.headers.get("location");
      if (!callback) throw new Error("Callback missing");
      return callback;
    };
    const completed = await fetch(await approve(first), { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(completed.status).toBe(200);
    const staleCallback = await approve(pending);
    expect(world.exchanges()).toBe(2);
    const memberBefore = await probe.api(world.den.members.member, "/v1/mcp-connections?scope=usable");
    expect(memberBefore.text).toContain('"connectedForMe":true');
    const row = await world.connection();
    if (!isRecord(row)) throw new Error("Connection missing");
    const updated = await world.api(`/v1/mcp-connections/${world.connectionId}`, { method: "PUT", body: JSON.stringify({ expectedUpdatedAt: row.updatedAt, name: row.name, url: row.url, authType: row.authType, credentialMode: row.credentialMode, access: row.access, manualOAuthEndpoints: { authorizationEndpoint: `${world.origin}/authorize?revision=2`, tokenEndpoint: `${world.origin}/token` } }) });
    expect(updated.response.status, updated.text).toBe(200);
    expect(updated.body).toMatchObject({ reconnectionRequired: true, connectedForMe: false });
    const rejected = await fetch(staleCallback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(rejected.status).toBe(400);
    expect(world.exchanges()).toBe(2);
    const member = await probe.api(world.den.members.member, "/v1/mcp-connections?scope=usable");
    expect(member.text).toContain('"connectedForMe":false');
    expect(member.text).not.toContain("client_secret");
    expect(member.text).not.toContain("manualOAuthEndpoints");
    evidence.recordAssertionEvidence("Changing either endpoint signs members out", "An authorization URL query change clears both members' saved grants and readiness. A pending callback for the old tuple is rejected before exchange. Member listings contain no secret or manual endpoint fields.", true);
  });
  await step("the admin API rejects unsafe pairs and declarative upsert preserves explicit settings", async () => {
    const body = { name: "exp-mcpmanual-declarative", url: `${world.origin}/mcp/team`, authType: "oauth", credentialMode: "per_member", oauthClient: { clientId: "exp-mcpmanual-client" }, access: { orgWide: true } };
    const endpoints = { authorizationEndpoint: `${world.origin}/authorize`, tokenEndpoint: `${world.origin}/token` };
    for (const manualOAuthEndpoints of [{ authorizationEndpoint: endpoints.authorizationEndpoint }, { tokenEndpoint: endpoints.tokenEndpoint }, { ...endpoints, tokenEndpoint: "http://identity.example/token" }, { ...endpoints, tokenEndpoint: "https://user:secret@identity.example/token" }, { ...endpoints, tokenEndpoint: "https://identity.example/token#fragment" }]) {
      const rejected = await world.api("/v1/mcp-connections", { method: "POST", body: JSON.stringify({ ...body, manualOAuthEndpoints }) });
      expect(rejected.response.status, rejected.text).toBe(400);
    }
    const path = "/v1/mcp-connections/by-key/exp-mcpmanual-declarative";
    const created = await world.api(path, { method: "PUT", body: JSON.stringify({ ...body, manualOAuthEndpoints: endpoints }) });
    expect(created.response.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ manualOAuthEndpoints: endpoints });
    const changed = { ...endpoints, tokenEndpoint: `${world.origin}/token?revision=2` };
    const updated = await world.api(path, { method: "PUT", body: JSON.stringify({ ...body, manualOAuthEndpoints: changed }) });
    expect(updated.response.status, updated.text).toBe(200);
    expect(updated.body).toMatchObject({ manualOAuthEndpoints: changed, reconnectionRequired: true });
    const cleared = await world.api(path, { method: "PUT", body: JSON.stringify({ ...body, manualOAuthEndpoints: null }) });
    expect(cleared.response.status, cleared.text).toBe(200);
    expect(cleared.body).toMatchObject({ manualOAuthEndpoints: null });
    expect(discoveryCount()).toBe(before);
    evidence.recordAssertionEvidence("Manual configuration is validated and declaratively round-trips", "Half-set, non-HTTPS, userinfo and fragment pairs return 400. By-key create/update/clear preserve exact settings without contacting metadata or token endpoints.", true);
  });
});
