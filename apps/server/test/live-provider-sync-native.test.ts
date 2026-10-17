import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SseParser } from "../../../packages/opencode-plugin/src/inventory-events.ts";

// This is deliberately a binary integration test, not a mock of the provider fold.
// OPENWORK_TEST_OPENCODE2 may point at the same pinned binary on Linux/CI.
const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerID = "ipr_native_sync";
const disabledID = "ipr_native_disabled";
const capability = "native-test-loopback-capability";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let latest: T | undefined;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch (cause) { error = cause; }
    await delay(50);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(latest)}; error=${String(error)}`);
}

function gateway(id: string, models: { id: string; name: string }[], name = "Native provider") {
  return {
    id, providerId: "openai-compatible", name, credentialStatus: "ready",
    providerConfig: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/no-inference" } },
    models: models.map(model => ({
      ...model, config: { id: model.id, limit: { context: 8192, output: 1024 }, tool_call: true },
      upstreamModelId: null, modelGroupName: null, credentialSetName: null,
    })),
  };
}

test("pinned V2 replays desktop inventory and real model filters through native provider/model events", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch {
    t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary}); set OPENWORK_TEST_OPENCODE2`);
    return;
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /\bv2\.0\.26\b/, "native API premise is pinned to the shipping engine");

  const temp = process.env.OPENCODE_TEST_TMPDIR ?? join(tmpdir(), "opencode");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "openwork-native-provider-"));
  const cleanups: (() => Promise<void>)[] = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const project = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(project), mkdir(home)]);
  const directory = await realpath(project);
  let session: { apiBaseUrl: string; token: string; orgId: string } | null = null;
  let providers = [gateway(providerID, [
    { id: "gwm_keep", name: "Original" }, { id: "gwm_remove", name: "Removed later" },
    { id: "gwm_blacklisted", name: "Blacklisted" }, { id: "gwm_unlisted", name: "Not whitelisted" },
  ])];
  let inventoryStatus = 200;
  let inventoryReads = 0;
  let inferenceRequests = 0;
  const subscriptions = new Set<ServerResponse>();
  const mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/session") {
      assert.equal(req.headers.authorization, `Bearer ${capability}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(session));
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${session?.token}`);
    assert.equal(req.headers["x-openwork-org-id"], session?.orgId);
    if (url.pathname.endsWith("/inventory/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      subscriptions.add(res);
      req.on("close", () => subscriptions.delete(res));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.statusCode = inventoryStatus;
    if (inventoryStatus !== 200) { res.end("{}"); return; }
    if (url.pathname === "/v1/inference-providers") {
      inventoryReads++;
      res.end(JSON.stringify({ inferenceProviders: providers }));
      return;
    }
    const provider = providers.find(item => url.pathname === `/v1/inference-providers/${item.id}/connect`);
    if (provider) {
      res.end(JSON.stringify({ inferenceProvider: { ...provider, apiKey: "ow_gw_native_test_only" } }));
      return;
    }
    inferenceRequests++;
    res.statusCode = 404;
    res.end("{}");
  });
  const mockUrl = await listen(mock);
  cleanups.push(async () => {
    for (const response of subscriptions) response.end();
    mock.closeAllConnections();
    await new Promise<void>(resolveClose => mock.close(() => resolveClose()));
  });
  const changed = () => {
    assert.ok(subscriptions.size, "the real desktop plugin owns a Den SSE subscription");
    for (const response of subscriptions) response.write("event: inventory.changed\ndata: {}\n\n");
  };

  // Source models are NOT in config: bundled ConfigProvider's later model transform
  // can resurrect explicit config models after an external filter removed them.
  // The only synthetic part is one permanently disabled source provider.
  const entry = join(root, "fixture.ts");
  const pluginDirectory = join(root, "plugin");
  await mkdir(pluginDirectory);
  const bundle = join(pluginDirectory, "server.mjs");
  await writeFile(entry, `
import desktop from ${JSON.stringify(join(repo, "packages/opencode-plugin/server.ts"))};
import filters from ${JSON.stringify(join(repo, "apps/server/src/opencode-plugins/openwork-provider-filters-v2.ts"))};
import { toProviderRecord } from ${JSON.stringify(join(repo, "packages/opencode-plugin/src/providers.ts"))};
export default {
  id: "openwork.native-provider-test",
  async setup(ctx) {
    const disabled = toProviderRecord(${JSON.stringify(gateway(disabledID, [{ id: "gwm_disabled", name: "Disabled" }]))}, "ow_gw_disabled_test");
    const registration = await ctx.provider.transform(editor => editor.add({
      ...disabled, info: { ...disabled.info, activation: "disabled" }
    }));
    const disposeFilters = await filters.setup({ ...ctx, options: { providers: {
      ${JSON.stringify(providerID)}: {
        whitelist: ["gwm_keep", "gwm_remove", "gwm_added", "gwm_blacklisted"],
        blacklist: ["gwm_blacklisted"]
      }
    } } });
    const disposeDesktop = await desktop.setup({ ...ctx, options: {
      liveProviderSync: true, desktopSession: ${JSON.stringify(`${mockUrl}/session`)}
    } });
    return async () => {
      await disposeDesktop?.();
      await disposeFilters?.();
      await registration.dispose();
    };
  }
};
`);
  const build = spawnSync("bun", ["build", entry, "--target=node", "--format=esm", `--outfile=${bundle}`], {
    encoding: "utf8", cwd: repo, timeout: 30_000,
  });
  assert.equal(build.status, 0, build.stderr);
  const configPath = join(project, "opencode.json");
  const config = JSON.stringify({ update: "disable", share: "disabled", plugins: [{ package: pluginDirectory }], warming: false });
  await writeFile(configPath, config);

  // Reserve an ephemeral port, then release it immediately before engine startup.
  const reservation = createServer();
  const engineUrl = await listen(reservation);
  await new Promise<void>(resolveClose => reservation.close(() => resolveClose()));
  const port = new URL(engineUrl).port;
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    cwd: directory,
    // Do not inherit cloud credentials, user's OpenCode paths, proxy, or config.
    env: {
      PATH: process.env.PATH,
      HOME: home, OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
      OPENCODE_CONFIG_DIR: join(home, "config", "opencode"),
      OPENCODE_DB: join(home, "native.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true",
      OPENCODE_PASSWORD: "native-engine-test-password",
      OPENWORK_PROVIDER_SESSION_TOKEN: capability,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += String(chunk); });
  child.stderr.on("data", chunk => { logs += String(chunk); });
  cleanups.push(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, "exit"), delay(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });
  const headers = { authorization: `Basic ${Buffer.from("opencode:native-engine-test-password").toString("base64")}` };
  const request = async (path: string): Promise<unknown> => {
    if (child.exitCode !== null) throw new Error(`Engine exited ${child.exitCode}: ${logs}`);
    const response = await fetch(`${engineUrl}${path}`, { headers, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}; ${logs}`);
    return response.json();
  };
  await until(() => request("/api/provider"), () => true, "native engine boot");
  const initialConfig = await request("/api/config");

  const events: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const eventResponse = await fetch(`${engineUrl}/api/event`, { headers, signal: controller.signal });
  assert.equal(eventResponse.status, 200);
  assert.ok(eventResponse.body);
  const reader = eventResponse.body.getReader();
  const parser = new SseParser(({ data }) => {
    const event: unknown = JSON.parse(data);
    if (record(event)) events.push(event);
  });
  const consuming = (async () => {
    const decoder = new TextDecoder();
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
  })();
  // Attach a rejection handler immediately (undici rejects on abort).
  void consuming.catch(() => {});
  cleanups.push(async () => { controller.abort(); await reader.cancel().catch(() => {}); await consuming.catch(() => {}); });
  const models = async () => {
    const value = await request(`/api/model?location[directory]=${encodeURIComponent(directory)}`);
    assert.ok(record(value) && Array.isArray(value.data), JSON.stringify(value));
    return value.data.filter(record).filter(model => model.providerID === providerID || model.providerID === disabledID);
  };
  await until(models, value => value.length === 0, "initial signed-out inventory");
  await until(async () => events, value => value.some(event => event.type === "server.connected"), "native SSE connected");
  session = { apiBaseUrl: mockUrl, token: "native-session-one", orgId: "org_native_one" };
  const initial = await until(models, value => value.some(model => model.id === "gwm_keep"), "desktop sign-in publishes inventory");
  assert.deepEqual(initial.map(model => model.id).sort(), ["gwm_keep", "gwm_remove"]);
  assert.equal(initial.find(model => model.id === "gwm_keep")?.name, "Original");
  await until(async () => subscriptions.size, size => size > 0, "Den subscription");

  const boundary = events.length;
  const beforeReads = inventoryReads;
  providers = [gateway(providerID, [
    { id: "gwm_keep", name: "Updated without config" }, { id: "gwm_added", name: "Added live" },
    { id: "gwm_blacklisted", name: "Still blacklisted" }, { id: "gwm_unlisted", name: "Still not whitelisted" },
  ], "Updated provider")];
  const start = Date.now();
  changed();
  const updated = await until(models, value => value.some(model => model.name === "Updated without config"), "live add/remove/update");
  assert.deepEqual(updated.map(model => model.id).sort(), ["gwm_added", "gwm_keep"]);
  assert.ok(inventoryReads > beforeReads, "an event bypasses inventory freshness shortcuts");
  for (const type of ["provider.updated", "model.updated"]) {
    const event = await until(async () => events.slice(boundary).find(item => item.type === type), Boolean, type);
    assert.ok(event && record(event.location));
    assert.equal(event.location.directory, directory, `${type} carries its native location`);
  }
  assert.equal(events.some(event => event.type === "catalog.updated"), false, "catalog.updated is not a native V2 event");
  t.diagnostic(`native inventory add/remove/update and filter replay: ${Date.now() - start}ms`);
  assert.equal(events.slice(boundary).some(event => event.type === "location.shutdown" || event.type === "config.updated"), false,
    "inventory reload does not rebuild the location or update configuration");

  // A reconnect must reconcile even if no inventory.changed event was delivered.
  providers = [gateway(providerID, [{ id: "gwm_keep", name: "Reconnected" }, { id: "gwm_unlisted", name: "Still filtered" }])];
  for (const response of subscriptions) response.end();
  await until(models, value => value.length === 1 && value[0]?.name === "Reconnected", "Den reconnect reconciles inventory");

  // An authoritative denial clears inventory rather than replaying the cached key.
  inventoryStatus = 401;
  changed();
  await until(models, value => value.length === 0, "authorization revocation removes live providers");
  inventoryStatus = 200;
  session = { apiBaseUrl: mockUrl, token: "native-session-two", orgId: "org_native_two" };
  providers = [gateway(providerID, [{ id: "gwm_added", name: "Second account" }])];
  await until(models, value => value.length === 1 && value[0]?.name === "Second account", "account switch replaces inventory");
  session = null;
  await until(models, value => value.length === 0, "sign-out clears inventory");
  assert.equal(await readFile(configPath, "utf8"), config, "live inventory never materializes providers/models into config");
  assert.deepEqual(await request("/api/config"), initialConfig, "all native config sources remain unchanged");
  assert.equal(inferenceRequests, 0, "no external or synthetic inference request is needed");
  assert.equal(events.some(event => event.type === "catalog.updated"), false);
});
