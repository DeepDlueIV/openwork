import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";
import { startCatalogWitness } from "../packages/labs/src/mock-mcp-catalog.ts";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";
import { seedSyntheticPreactivatedDen } from "../packages/env/src/app-web-bootstrap.ts";

// Operators can distinguish catalog failures and local App-host provisioning in
// the real server's responses. Quick-add catalog specs exercise Den/UI, not this API.
test("catalog reconciliation attributes failures without leaking private auth or retaining revoked direct servers", async ({ evidence }) => {
  needs({ commands: ["bun"] });
  const root = await mkdtemp(join(tmpdir(), "mcp-catalog-diagnostics-"));
  const privateAuthorization = "Bearer catalog-private-test-token";
  const memberAuthorization = "Bearer catalog-member-test-token";
  const clientToken = "catalog-client-test-token";
  const witness = await startCatalogWitness(privateAuthorization);
  const children: ReturnType<typeof bootServer>["child"][] = [];
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const headers = { authorization: `Bearer ${clientToken}`, "content-type": "application/json" };
  const config = { type: "remote", url: `${witness.url}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: memberAuthorization } };
  const index = (servers: unknown[]) => JSON.stringify({ schemaVersion: "openwork.connect/mcp-servers/1", servers });
  async function boot(name: string, devMode: string, syntheticPreactivatedDenOrigin?: string) {
    const home = join(root, name);
    const workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(home, "config", "openwork"), { recursive: true });
    const bootstrapEnv = await seedSyntheticPreactivatedDen(home, syntheticPreactivatedDenOrigin);
    const server = bootServer({
      ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      OPENWORK_RUNTIME_DB: join(home, "runtime.sqlite"), OPENWORK_DEV_MODE: devMode,
      OPENWORK_OPENCODE_BASE_URL: witness.url, OPENWORK_MANAGE_OPENCODE: "0",
      ...bootstrapEnv,
    }, clientToken, workspace, () => {});
    children.push(server.child);
    const base = await server.listening;
    const response = await fetch(`${base}/workspaces`, { headers, signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.items) || !isRecord(payload.items[0]) || typeof payload.items[0].id !== "string") throw new Error("Missing workspace");
    return `${base}/workspace/${payload.items[0].id}/mcp/openwork-cloud/reconcile`;
  }
  async function reconcile(url: string, authorization?: string, enabled = true) {
    const response = await fetch(url, {
      method: "POST", headers, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ config: { ...config, enabled }, ...(authorization === undefined ? {} : { appHostAuthorization: authorization }) }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(privateAuthorization.slice("Bearer ".length));
    expect(text).not.toContain(memberAuthorization.slice("Bearer ".length));
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new Error("Missing reconciliation result");
    return body;
  }
  async function health(endpoint: string) {
    const requestCount = witness.requests.length;
    const registrationCount = witness.registrations.length;
    const disconnectCount = witness.disconnects.length;
    const response = await fetch(endpoint.replace("/reconcile", "/health"), { headers, signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(privateAuthorization.slice("Bearer ".length));
    expect(text).not.toContain(memberAuthorization.slice("Bearer ".length));
    expect(witness.requests).toHaveLength(requestCount);
    expect(witness.registrations).toHaveLength(registrationCount);
    expect(witness.disconnects).toHaveLength(disconnectCount);
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new Error("Missing health result");
    expect(body.tools).toMatchObject({ direct: { checked: false } });
    return body;
  }
  async function expectResolveError(endpoint: string, code: string) {
    const response = await fetch(endpoint.replace("/mcp/openwork-cloud/reconcile", "/mcp-apps/resolve"), {
      method: "POST", headers, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ launch: { connectionId: "catalog-connection", toolName: "show", resourceUri: "ui://fixture/app" } }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = await response.text();
    expect(text).not.toContain(privateAuthorization.slice("Bearer ".length));
    expect(text).not.toContain(memberAuthorization.slice("Bearer ".length));
    expect(JSON.parse(text)).toMatchObject({ code });
  }
  async function appRequest(endpoint: string, route: string, body: unknown) {
    const response = await fetch(endpoint.replace("/mcp/openwork-cloud/reconcile", `/mcp-apps/${route}`), {
      method: "POST", headers, signal: AbortSignal.timeout(20_000), body: JSON.stringify(body),
    });
    const text = await response.text();
    expect(text).not.toContain(privateAuthorization.slice("Bearer ".length));
    expect(text).not.toContain(memberAuthorization.slice("Bearer ".length));
    const result: unknown = JSON.parse(text);
    return { status: response.status, body: result };
  }
  const catalogReads = () => witness.requests.filter((entry) => entry.privateAuth && entry.method === "resources/read").length;
  try {
    const endpoint = await boot("trusted-dev", "1");
    expect((await health(endpoint)).appHostAuthorizationReady).toBeNull();
    const disabled = await reconcile(endpoint, undefined, false);
    expect(disabled.connectCatalogDiagnostic).toBeUndefined();
    expect(disabled.firstFailure).toMatchObject({ code: "cloud_mcp_disabled" });
    expect(disabled.appHostAuthorizationReady).toBeNull();
    const missingAuth = await reconcile(endpoint);
    expect(missingAuth).toMatchObject({ usable: true, phase: "ready", firstFailure: null, appHostAuthorizationReady: false, connectCatalogDiagnostic: "missing_app_host_auth" });
    const missingAuthHealth = await health(endpoint);
    expect(missingAuthHealth).toMatchObject({ usable: true, phase: "ready", firstFailure: null, appHostAuthorizationReady: false });
    if (!isRecord(missingAuthHealth.desired) || typeof missingAuthHealth.desired.revision !== "string") throw new Error("Missing desired revision");
    const desiredRevision = missingAuthHealth.desired.revision;
    expect(missingAuth.desired).toMatchObject({ revision: desiredRevision });
    await expectResolveError(endpoint, "connect_catalog_missing_app_host_auth");
    expect(witness.requests.filter((entry) => entry.privateAuth || entry.method === "resources/read")).toEqual([]);

    witness.catalog(index([]));
    const authorized = await reconcile(endpoint, privateAuthorization);
    expect(authorized).toMatchObject({ usable: true, appHostAuthorizationReady: true, connectCatalogDiagnostic: "empty", desired: { revision: desiredRevision } });
    expect(await health(endpoint)).toMatchObject({ usable: true, phase: "ready", firstFailure: null, appHostAuthorizationReady: true, desired: { revision: desiredRevision } });
    evidence.recordAssertionEvidence("App-host provisioning is independent of ordinary Cloud health", "Ordinary health GET remains usable after global reconciliation without private auth, reports false then true after private authorization, and retains the same desired revision. GET makes no direct probe or catalog requests and leaks neither credential.", true);
    await expectResolveError(endpoint, "server_unavailable");
    expect(witness.requests.some((entry) => entry.method === "resources/read" && entry.privateAuth && entry.appHostCapability)).toBe(true);
    expect(witness.registrations.some((entry) => entry.name.startsWith("openwork-direct-"))).toBe(false);
    const descriptor = { connectionId: "catalog-connection", name: "Catalog fixture", description: null, url: `${witness.url}/mcp/agent/connections/catalog-connection`, exposeDirectly: true };
    witness.catalog(index([descriptor]));
    expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("ready");
    const directName = witness.registrations.find((entry) => entry.name.startsWith("openwork-direct-"))?.name;
    expect(directName).toBeDefined();

    for (const invalid of ["not-json", JSON.stringify({ schemaVersion: "unsupported", servers: [] })]) {
      witness.catalog(invalid);
      expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("invalid_catalog");
      const before = catalogReads();
      await expectResolveError(endpoint, "connect_catalog_invalid_catalog");
      expect(catalogReads() - before).toBe(1);
    }
    expect(witness.disconnects).toContain(directName);
    const projectedCount = witness.registrations.filter((entry) => entry.name.startsWith("openwork-direct-")).length;
    witness.catalog(index([descriptor, { ...descriptor, connectionId: "rejected", url: "https://untrusted.invalid/mcp" }]));
    expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("invalid_proxy_descriptor");
    await expectResolveError(endpoint, "connect_catalog_invalid_proxy_descriptor");
    for (const status of [401, 403, 404, 503]) {
      witness.catalog(index([]), status);
      expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("discovery_unavailable");
      const before = witness.requests.filter((entry) => entry.privateAuth && entry.method === "initialize").length;
      await expectResolveError(endpoint, "connect_catalog_discovery_unavailable");
      expect(witness.requests.filter((entry) => entry.privateAuth && entry.method === "initialize").length - before).toBe(3);
    }
    expect(witness.registrations.filter((entry) => entry.name.startsWith("openwork-direct-"))).toHaveLength(projectedCount);
    expect(witness.registrations.every((entry) => !entry.privateAuth)).toBe(true);
    evidence.recordAssertionEvidence("Catalog failure attribution and fail-closed projection", "Real reconciliation HTTP responses distinguish missing auth, empty, ready, invalid JSON/schema, invalid proxy, and unavailable HTTP 401/403/404/503; revoked direct entry disconnected and no rejected catalog reprojected it. Engine registrations contain no private auth.", true);

    witness.catalog(index([]));
    await reconcile(endpoint);
    witness.catalog(index([descriptor]));
    witness.failNextCatalogReads(1);
    const beforeResolve = catalogReads();
    const resolved = await appRequest(endpoint, "resolve", {
      launch: { connectionId: descriptor.connectionId, toolName: "show", resourceUri: "ui://fixture/app" },
      context: { sessionId: null, readOnly: false },
    });
    expect(resolved.status).toBe(200);
    expect(catalogReads() - beforeResolve).toBe(2);
    expect(witness.appCalls).toEqual([]);
    if (!isRecord(resolved.body) || !isRecord(resolved.body.app) || typeof resolved.body.app.launchId !== "string"
      || typeof resolved.body.app.serverName !== "string") throw new Error("Missing recovered App launch");
    evidence.recordAssertionEvidence("An App opens after one temporary catalog failure", "The first private catalog read returned 503; the same resolve request recovered on its second read and returned the App without running a provider tool.", true);

    // A live App can encounter the same startup race after reconciliation
    // replaces its catalog. Its first data call must recover without a click.
    witness.catalog(index([]));
    await reconcile(endpoint);
    witness.catalog(index([descriptor]));
    witness.failNextCatalogReads(1);
    const beforeCall = catalogReads();
    const loaded = await appRequest(endpoint, "call", {
      launchId: resolved.body.app.launchId, serverName: resolved.body.app.serverName,
      sessionId: null, name: "show", resourceUri: "ui://fixture/app",
    });
    expect(loaded).toMatchObject({ status: 200, body: { content: [{ type: "text", text: "Catalog App data" }] } });
    expect(catalogReads() - beforeCall).toBe(2);
    expect(witness.appCalls).toEqual(["show"]);
    evidence.recordAssertionEvidence("The first read recovers without replaying the App tool", "After the catalog was cleared, the first data call encountered one 503, retried discovery, and returned data with exactly one provider tool call. Invalid catalog responses still stop after one read.", true);

    // Same loopback origin without the explicit development trust exception is
    // unactivated: supplying private auth must not send it to that origin.
    witness.catalog(index([]));
    const untrustedEndpoint = await boot("unactivated", "0");
    const privateRequestsBefore = witness.requests.filter((entry) => entry.privateAuth).length;
    expect(await reconcile(untrustedEndpoint, privateAuthorization)).toMatchObject({ connectCatalogDiagnostic: "untrusted_origin", appHostAuthorizationReady: null });
    expect(await health(untrustedEndpoint)).toMatchObject({ usable: true, firstFailure: null, appHostAuthorizationReady: null });
    await expectResolveError(untrustedEndpoint, "connect_catalog_untrusted_origin");
    expect(witness.requests.filter((entry) => entry.privateAuth)).toHaveLength(privateRequestsBefore);
    evidence.recordAssertionEvidence("Unactivated origin cannot receive private App-host credentials", "An isolated non-development server reports untrusted_origin for the same unactivated origin; private request count does not increase. Reconciliation responses omit both bearer credentials.", true);
    const mismatchedEndpoint = await boot("preactivated-synthetic-mismatch", "0", "https://different-synthetic-den.example");
    const beforeMismatch = witness.requests.filter((entry) => entry.privateAuth).length;
    expect(await reconcile(mismatchedEndpoint, privateAuthorization)).toMatchObject({ connectCatalogDiagnostic: "untrusted_origin", appHostAuthorizationReady: null });
    await expectResolveError(mismatchedEndpoint, "connect_catalog_untrusted_origin");
    expect(witness.requests.filter((entry) => entry.privateAuth)).toHaveLength(beforeMismatch);
    evidence.recordAssertionEvidence("Synthetic preactivation does not trust a different origin", "The unchanged production catalog guard rejected an origin different from the synthetic installation's initial activation; neither reconciliation nor App resolve dispatched a private-auth request.", true);
    evidence.recordAssertionEvidence("App resolve retains catalog failure attribution", "Real resolve HTTP errors distinguish missing private authorization, untrusted origin, invalid catalog/proxy and unavailable discovery from server_unavailable after successful empty discovery; no response exposes bearer credentials.", true);
  } finally {
    for (const child of children) await stopChild(child);
    await witness.stop();
    await rm(root, { recursive: true, force: true });
  }
});
