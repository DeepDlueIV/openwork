import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import type { ServerConfig } from "../src/types.js";

async function profile(run: (config: ServerConfig, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "openwork-auto-upgrade-"));
  const overrides = {
    HOME: dir, USERPROFILE: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"), OPENWORK_RUNTIME_DB: join(dir, "runtime.sqlite"), OPENCODE_DB: join(dir, "v1.db"),
    OPENWORK_OPENCODE2_BIN: join(dir, "unavailable-opencode2"), OPENWORK_ENGINE_V2_PREVIEW: "",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    engineAutoUpgrade: true,
  };
  try { await run(config, dir); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("boot never blocks: unreadable v1 history stays on v1 with a durable error and backoff", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const errors: string[] = [];
    const engine = createEngineV2Preview({ config, deferStart: true, autoUpgradeError: error => errors.push(error) });
    try {
      engine.start();
      // The migration is asynchronous, and the v1 route remains selected.
      assert.equal(engine.status().chatRouting, false);
      for (let check = 0; check < 100 && readEngineV2PreviewState(config).autoUpgradeRetry === undefined; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(errors.length, 1);
      assert.equal(engine.status().migration.state, "error");
      assert.equal(engine.status().chatRouting, false);
      const persisted = readEngineV2PreviewState(config);
      assert.equal(persisted.autoUpgradeRetry?.attempts, 1);
      assert.ok((persisted.autoUpgradeRetry?.retryAt ?? 0) > Date.now());
      assert.equal(persisted.historyCopyResult?.state, "error");
      assert.equal(engine.status().automaticRetryAt, persisted.autoUpgradeRetry?.retryAt);
      assert.throws(() => engine.migrateHistory(), { status: 409, code: "engine_upgrade_host_managed" });
      engine.start();
      engine.setForcePolicy({ upgrade: true });
      engine.setForcePolicy({ upgrade: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(errors.length, 1, "status reads and policy refreshes cannot retry in the same boot");
      assert.equal(engine.status().automaticRetryAt, persisted.autoUpgradeRetry?.retryAt);
    } finally { await engine.stop(); }
  });
});

test("an automatic upgrade waiting for idle cannot be duplicated by an interactive migration", async () => {
  await profile(async config => {
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => false });
    try {
      assert.equal(engine.status().migration.state, "idle");
      assert.throws(() => engine.migrateHistory(), { status: 409, code: "engine_upgrade_host_managed" });
      assert.equal(engine.status().chatRouting, false);
    } finally { await engine.stop(); }
  });
});

test("interactive migration errors still allow an explicit retry without automatic ownership", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    writeFileSync(join(dir, "v1.db"), "isolated source");
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      assert.equal(engine.migrateHistory().migration.state, "running");
      for (let check = 0; check < 100 && engine.status().migration.state === "running"; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(engine.status().migration.state, "error");
      assert.equal(engine.status().automaticRetryAt, undefined);
      assert.equal(engine.migrateHistory().migration.state, "running", "manual recovery remains explicit and usable");
    } finally { await engine.stop(); }
  });
});

test("a later boot honors persisted backoff without attempting history access", async () => {
  await profile(async (config, dir) => {
    writeFileSync(join(dir, "v1.db"), "not a SQLite database");
    const state = { enabled: false, chatRouting: false,
      autoUpgradeRetry: { attempts: 2, retryAt: Date.now() + 60_000 },
      historyCopyResult: { state: "error", error: "previous failure", imported: 0, skipped: 0, total: 0 } };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    const engine = createEngineV2Preview({ config, autoUpgradeError: () => assert.fail("must not retry before backoff") });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.error, "previous failure");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("turning rollout off does not resume an interrupted automatic copy or delete v2 data", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    const state = { enabled: true, chatRouting: false, automaticHistoryCopy: true, v1HistoryCopyStartedAt: 1 };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    mkdirSync(join(dir, "opencode-v2", "state"), { recursive: true });
    writeFileSync(join(dir, "opencode-v2", "state", "opencode.db"), "checkpoint");
    const engine = createEngineV2Preview({ config });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.state, "idle");
      assert.equal(engine.status().running, false);
      assert.equal(readFileSync(join(dir, "opencode-v2", "state", "opencode.db"), "utf8"), "checkpoint");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("flag off preserves a forced v2 selection across boot and repeated policy writes", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    const state = { enabled: true, chatRouting: true, engineOrigin: "forced", engineForced: true };
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify(state));
    const engine = createEngineV2Preview({ config, deferStart: true });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true, "v2-only history must remain on the selected engine");
      assert.equal(engine.status().engineOrigin, "forced");
      assert.equal(engine.status().engineForced, true);
      engine.setForcePolicy({ upgrade: false });
      assert.equal(engine.status().chatRouting, true);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "engine-v2-preview.json"), "utf8")), state);
    } finally { await engine.stop(); }
  });
});

test("revert leaves a manually selected v2 engine untouched", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: false, chatRouting: true,
      engineOrigin: "manual", engineForced: false }));
    const engine = createEngineV2Preview({ config });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "manual");
      assert.equal(engine.status().engineForced, false);
    } finally { await engine.stop(); }
  });
});

test("flag off never attempts an upgrade for a v1 profile", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    config.engineForcePolicy = true;
    writeFileSync(join(dir, "v1.db"), "unreadable history must not be opened with policy off");
    let probed = false;
    const engine = createEngineV2Preview({ config, autoUpgradeIdle: async () => { probed = true; return true; } });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(probed, false);
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().migration.state, "idle");
      assert.equal(readEngineV2PreviewState(config).autoUpgradeRetry, undefined);
    } finally { await engine.stop(); }
  });
});

test("rollout off preserves a saved v2 engine choice", async () => {
  await profile(async (config, dir) => {
    config.engineAutoUpgrade = false;
    writeFileSync(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true }));
    const engine = createEngineV2Preview({ config, deferStart: true });
    assert.equal(engine.status().chatRouting, true);
    await engine.stop();
    assert.equal(readEngineV2PreviewState(config).chatRouting, true);
  });
});
