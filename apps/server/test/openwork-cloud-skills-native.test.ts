import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { sha256Digest } from "../src/opencode-plugins/openwork-cloud-skills-v2.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const body = "---\nname: fixture-review\n---\n\nPRIVATE_SKILL_BODY_CANARY: review the fixture.";
const id = "openwork-cloud-fixture-review";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(20);
  }
  assert.fail("Expected native skill state did not arrive");
}

// API proof against the shipping engine, isolated from user configuration and
// credentials. Prompt hooks, permission evaluation, the production host bridge
// and attachment materialization are not mocked. No desktop window is opened.
test("native Cloud attachments are ready, authorized, and never a cold ordinary-chat barrier", { timeout: 60_000 }, async t => {
  try { await access(binary); } catch { t.skip("needs: pinned OpenCode binary; set OPENWORK_TEST_OPENCODE2"); return; }
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout, /\bv2\.0\.26\b/);
  const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMPDIR ?? tmpdir(), "openwork-native-skills-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const plugin = join(root, "plugin");
  await Promise.all([mkdir(project), mkdir(home), mkdir(plugin)]);
  let catalogReads = 0;
  let bodyReads = 0;
  let authorizations = 0;
  let native = true;
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  const catalogHeld = deferred();
  const bodyHeld = deferred();
  const bridge = await createV2ContextBridge(async path => {
    if (path === "/experimental/connect/skills") {
      catalogReads++; await catalogHeld.promise;
      return { ...(native ? { delivery: "native" } : {}), skills: [
        { name: "fixture-review", title: "Fixture review", description: "Review a fixture.", capability: "skill:fixture-review",
          url: "skill://fixture-review/SKILL.md", modelDiscovery: true, digest: sha256Digest(body) },
        { name: "unavailable-review", title: "Unavailable review", description: "Review another fixture.", capability: "skill:unavailable-review",
          url: "skill://unavailable-review/SKILL.md", modelDiscovery: true, digest: sha256Digest("not-returned") },
      ] };
    }
    assert.equal(path, "/experimental/connect/skills/read");
    bodyReads++; await bodyHeld.promise; return { content: body };
  }, async (sessionID, ids) => {
    authorizations++;
    const result = await engine!.fetchJson(`/api/session/${sessionID}/permission`, {
      method: "POST", body: { action: "skill", resources: ids, save: ids },
    });
    assert.equal(result.status, 200);
    return result.json;
  });
  const entry = join(root, "entry.ts");
  await writeFile(entry, `
    import { registerCloudSkillDiscovery } from ${JSON.stringify(join(repo, "apps/server/src/opencode-plugins/openwork-cloud-skills-v2.ts"))};
    export default { id: "openwork.native-skills-proof", setup: registerCloudSkillDiscovery };
  `);
  await writeFile(join(plugin, "package.json"), JSON.stringify({ type: "module" }));
  const build = spawnSync("bun", ["build", entry, "--target=node", "--format=esm", `--outfile=${join(plugin, "server.js")}`], { encoding: "utf8", cwd: repo });
  assert.equal(build.status, 0, build.stderr);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: plugin, options: { url: bridge.url, token: bridge.token } }] }));
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"), env: {
      HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true",
    } });
    const makeSession = async (effect: "deny" | "ask" | "allow") => {
      const created = await engine!.fetchJson("/api/session", { method: "POST", body: { title: "Native skill permission fixture", location: { directory: project },
        permissions: [{ action: "skill", resource: "*", effect }] } });
      assert.equal(created.status, 200);
      assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string");
      return created.json.data.id;
    };
    const coldID = await makeSession("allow");
    await until(() => catalogReads > 0);
    const ordinary = await engine.fetchJson(`/api/session/${coldID}/prompt`, { method: "POST", body: { text: "Hello" }, timeoutMs: 2_000 });
    assert.equal(ordinary.status, 200, "ordinary admission succeeds while catalog metadata is still held");
    assert.equal(bodyReads, 0, "witness: no body could have loaded yet");
    let admitted = false;
    const selected = engine.fetchJson(`/api/session/${coldID}/prompt`, {
      method: "POST", body: { text: "Review this", skills: [{ id }] }, timeoutMs: 10_000,
    }).then(result => { admitted = true; return result; });
    await delay(50);
    assert.equal(admitted, false, "explicit cold attachment waits for its catalog");
    catalogHeld.resolve();
    await until(() => bodyReads > 0);
    assert.equal(admitted, false, "published metadata is not ready instructions");
    const whileHydrating = await engine.fetchJson(`/api/session/${await makeSession("allow")}/prompt`, {
      method: "POST", body: { text: "Hello again" }, timeoutMs: 2_000,
    });
    assert.equal(whileHydrating.status, 200, "ordinary admission does not wait for full hydration");
    bodyHeld.resolve();
    const ready = await selected;
    assert.equal(ready.status, 200);
    assert.ok(JSON.stringify(ready.json).includes("PRIVATE_SKILL_BODY_CANARY"), "ready admission contains verified instructions, not discovery metadata");
    t.diagnostic("cold metadata held: ordinary admitted; selected waited for metadata and its verified body");

    for (const effect of ["deny", "ask", "allow"] as const) {
      const sessionID = await makeSession(effect);
      const evaluated = await engine.fetchJson(`/api/session/${sessionID}/permission`, { method: "POST", body: { action: "skill", resources: [id], save: [id] } });
      assert.ok(record(evaluated.json) && record(evaluated.json.data));
      assert.equal(evaluated.json.data.effect, effect, "witness: real engine permission operation decides this attachment");
      const prompted = await engine.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: "Run fixture-review now" } });
      t.diagnostic(`permission=${effect}; admission=${prompted.status}; instructionsLoaded=${JSON.stringify(prompted.json).includes("PRIVATE_SKILL_BODY_CANARY")}`);
      if (effect === "allow") {
        assert.equal(prompted.status, 200);
        assert.ok(JSON.stringify(prompted.json).includes("PRIVATE_SKILL_BODY_CANARY"));
      } else {
        assert.notEqual(prompted.status, 200, "blocked or unapproved named skill must not be admitted");
        assert.ok(!JSON.stringify(prompted.json).includes("PRIVATE_SKILL_BODY_CANARY"));
        const messages = await engine.fetchJson(`/api/session/${sessionID}/message`);
        assert.ok(!JSON.stringify(messages.json).includes("PRIVATE_SKILL_BODY_CANARY"), "denied instructions never enter history");
        if (effect === "ask") {
          const pending = await engine.fetchJson(`/api/session/${sessionID}/permission`);
          assert.ok(record(pending.json) && Array.isArray(pending.json.data));
          const request = pending.json.data.filter(record).at(-1);
          assert.ok(request && typeof request.id === "string");
          const reply = await engine.fetchJson(`/api/session/${sessionID}/permission/${request.id}/reply`, {
            method: "POST", body: { decision: "always" },
          });
          assert.equal(reply.status, 204);
          const approved = await engine.fetchJson(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: "Run fixture-review now" } });
          assert.equal(approved.status, 200, "saved approval uses the existing engine flow on resend");
          assert.ok(JSON.stringify(approved.json).includes("PRIVATE_SKILL_BODY_CANARY"));
        }
      }
    }
    const incomplete = await engine.fetchJson(`/api/session/${await makeSession("allow")}/prompt`, {
      method: "POST", body: { text: "Review this", skills: [{ id: "openwork-cloud-unavailable-review" }] },
    });
    assert.notEqual(incomplete.status, 200, "a digest-mismatched body cannot be admitted as a loaded explicit skill");
    assert.ok(!JSON.stringify(incomplete.json).includes("PRIVATE_SKILL_BODY_CANARY"));

    const bridgeCall = async (input: unknown, token = bridge.token) => fetch(bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "openwork_skill_authorize", input }),
    });
    const before = authorizations;
    assert.equal((await bridgeCall({ sessionID: coldID, ids: [id] }, "wrong-token")).status, 401);
    assert.equal((await bridgeCall({ sessionID: coldID, ids: ["local-skill"] })).status, 400);
    assert.equal((await bridgeCall({ sessionID: "../admin", ids: [id] })).status, 400);
    native = false;
    assert.equal((await bridgeCall({ sessionID: coldID, ids: [id] })).status, 403, "kill/off prevents native authorization immediately");
    assert.equal(authorizations, before, "invalid and off-rollout calls never reach engine permission evaluation");
    assert.ok(!(engine.stdout + engine.stderr).includes("PRIVATE_SKILL_BODY_CANARY"), "skill bodies never enter native logs");
  } finally {
    catalogHeld.resolve(); bodyHeld.resolve();
    await engine?.close(); await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
