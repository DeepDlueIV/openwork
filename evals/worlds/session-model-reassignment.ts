import { browserScript } from "@openwork/cdp";
import { type Seed } from "@openwork/env";
import { mkdir, realpath, readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { configureProvider } from "./chat.ts";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview.ts";
import { openworkReadTransport } from "../../apps/server/src/opencode-plugins/openwork-read-transport.ts";
import { createV2ReadAdapter, readV2SessionActivity } from "../../apps/server/src/opencode-v2-read-adapter.ts";

/** Real browser, OpenWork server and pinned engine; only inference is synthetic. */
export function sessionModelReassignmentV1(seed: Seed) { return buildSessionModelReassignment(seed, "v1"); }
export function sessionModelReassignment(seed: Seed) { return buildSessionModelReassignment(seed, "v2"); }
async function buildSessionModelReassignment(seed: Seed, engine: "v1" | "v2") {
  const root = seed.tmpPath("model-reassignment");
  const otherRoot = seed.tmpPath("model-reassignment-other");
  await mkdir(root, { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  const path = await realpath(root);
  const otherPath = await realpath(otherRoot);
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: "hold model reassignment", finalReply: "Finished", steps: [{
      tool: "shell", arguments: { command: "python3 -c 'import threading; threading.Event().wait()'", description: "Wait for input", timeout: 120_000 },
    }],
  }, { promptMarker: "Verify recovered model", finalReply: "Recovered model answered", steps: [] }] });
  const app = await seed.appWeb({ name: "model-reassignment", engine, workspacePath: path, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing model witness");
  const workspace = await seed.workspace(app, path).catch(async (error: unknown) => {
    // Diagnostic only: capture the isolated app's error boundary details.
    const details = await seed.evalIn(app, async () => {
      [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Technical details"))?.click();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return document.body.textContent;
    }, { awaitPromise: true });
    throw new Error(`${String(error)}; error boundary: ${details}`);
  });
  await configureProvider(seed, app, workspace.workspaceId, "rebind", "model-a", {
    permission: { "*": "allow" }, provider: { rebind: {
      npm: "@ai-sdk/openai-compatible", name: "Recovery witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-rebind-key" },
      models: { "model-a": { name: "Model A" }, "model-b": { name: "Model B" } },
    } },
  }, engine);
  // Arrangement calls the native create API so A is a real persisted binding,
  // without a prompt. No live app, history database or real provider is used.
  const fixtures = await seed.evalIn(app, browserScript(async (workspaceId, directory, engine) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port")
      + "/workspace/" + workspaceId + (engine === "v2" ? "/opencode2/api" : "/opencode");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" };
    const create = async (title: string) => {
      const response = await fetch(base + "/session", { method: "POST", headers, body: JSON.stringify({
        title, ...(engine === "v2" ? { location: { directory }, model: { providerID: "rebind", id: "model-a" } } : { directory }),
      }) });
      const payload = await response.json();
      const body = engine === "v2" ? payload.data : payload;
      if (!response.ok || typeof body.id !== "string") throw new Error("Native fixture creation failed: " + JSON.stringify(body));
      return body.id;
    };
    return { target: await create("Recover this conversation"), untouched: await create("Leave this conversation alone"), busy: await create("Working conversation") };
  }, [workspace.workspaceId, path, engine]), { awaitPromise: true });
  // Existing workspace.create selects list.selectedId (which can remain the
  // old workspace). Arrange the second registry entry and explicit route here;
  // the subject of this journey is the headless model action, not onboarding.
  const runtimes = resolve(import.meta.dirname, "../../tmp/worlds/runtime");
  let hostToken: string | undefined;
  for (const entry of await readdir(runtimes)) {
    const manifest = await readFile(join(runtimes, entry, "runtime.json"), "utf8").then(JSON.parse).catch(() => null);
    if (manifest?.openworkUrl === app.openworkUrl) hostToken = manifest.hostToken;
  }
  if (!hostToken) throw new Error("Missing test-owned runtime host credential");
  let archived: string | undefined;
  if (engine === "v2") {
    // v2 has no archive mutation. Build a genuinely archived v1 conversation
    // and import it through OpenWork's supported history upgrade instead.
    archived = await seed.evalIn(app, browserScript(async workspaceId => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/workspace/" + workspaceId + "/opencode/session";
      const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" };
      const created = await fetch(base, { method: "POST", headers, body: JSON.stringify({ title: "Archived conversation" }) });
      const session = await created.json();
      if (!created.ok || typeof session.id !== "string") throw new Error("Archived fixture creation failed");
      const archive = await fetch(base + "/" + session.id, { method: "PATCH", headers, body: JSON.stringify({ time: { archived: Date.now() } }) });
      if (!archive.ok) throw new Error("Archived fixture mutation failed");
      return session.id;
    }, [workspace.workspaceId]), { awaitPromise: true, timeoutMs: 60_000 });
    const migration = await fetch(app.openworkUrl + "/experimental/engine-v2-preview/migrate", {
      method: "POST", headers: { "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }), signal: AbortSignal.timeout(15_000),
    });
    if (!migration.ok) throw new Error(`Archived fixture migration failed: ${migration.status}`);
    await seed.evalIn(app, browserScript(async (sessionId, workspaceId) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const mounted = base + "/workspace/" + workspaceId;
      const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") };
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const response = await fetch(mounted + "/opencode2/api/session/" + sessionId, { headers });
        if (response.ok) { const body = await response.json(); if (body.data?.time?.archived > 0) return; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const status = await fetch(base + "/experimental/engine-v2-preview/status", { headers }).then(response => response.json());
      const session = await fetch(mounted + "/opencode2/api/session/" + sessionId, { headers }).then(response => response.json());
      throw new Error("Archived conversation was not imported: " + JSON.stringify({ migration: status.migration, session }));
    }, [archived, workspace.workspaceId]), { awaitPromise: true, timeoutMs: 100_000 });
  }
  const response = await fetch(app.openworkUrl + "/workspaces/local", {
    method: "POST", headers: { "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: otherPath, name: "Other workspace", preset: "starter" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Second workspace setup failed: ${response.status}`);
  const other = await seed.evalIn(app, browserScript(async directory => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" };
    const response = await fetch(base + "/workspaces", { headers });
    const body = await response.json();
    const workspace = body.workspaces?.find((entry: { path: string }) => entry.path === directory);
    if (!response.ok || !workspace) throw new Error("Second workspace setup failed: " + JSON.stringify(body));
    localStorage.setItem("openwork.react.activeWorkspace", workspace.id);
    return { workspaceId: workspace.id, route: "/workspace/" + workspace.id + "/session" };
  }, [otherPath]), { awaitPromise: true });
  const activated = await fetch(app.openworkUrl + "/workspaces/" + other.workspaceId + "/activate", {
    method: "POST", headers: { "x-openwork-host-token": hostToken }, signal: AbortSignal.timeout(15_000),
  });
  if (!activated.ok) throw new Error(`Second workspace activation failed: ${activated.status}`);
  await seed.evalIn(app, browserScript(route => { location.href = route; }, [other.route]));
  const connection = await seed.evalIn(app, () => ({
    base: "http://127.0.0.1:" + localStorage.getItem("openwork.server.port"),
    token: localStorage.getItem("openwork.server.token"),
  }));
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(connection.base + path, {
      headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Fixture read failed: ${response.status} ${path}`);
    return response.json();
  };
  const plugin = await OpenWorkExtensionsPreview();
  // Invoke the shipping session.read affordance with the same confined host
  // transport used by v2, against this world's real engine (no inference).
  const read = async (sessionId: string) => JSON.parse(await openworkReadTransport.run({
    engine, get: engine === "v2" ? createV2ReadAdapter(get) : get,
    ...(engine === "v2" ? { activity: (workspaceId: string, sessionId: string) => readV2SessionActivity(get, workspaceId, sessionId) } : {}),
    post: async () => { throw new Error("Read fixture must not mutate"); },
  }, () => plugin.tool.openwork_query.execute({ id: "session.read", args: { sessionId, workspaceId: workspace.workspaceId } })));
  return { app, workspace, other, engine, fixtures, archived, read,
    base: `/workspace/${workspace.workspaceId}/${engine === "v2" ? "opencode2/api" : "opencode"}`,
    requests: () => witness.agentRequests(),
  };
}
