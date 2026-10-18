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
import { serve } from "../src/serve-node.js";

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
  let state: "ready" | "setup" | "digest" | "url" | "capability" = "ready";
  let changeDuringAuthorization: "setup" | "digest" | undefined;
  const observedModelRequests: string[] = [];
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  const catalogHeld = deferred();
  const bodyHeld = deferred();
  let loadedModelRequests = 0;
  const model = await serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const text = await request.text();
    observedModelRequests.push(text);
    if (text.includes("PRIVATE_SKILL_BODY_CANARY")) loadedModelRequests++;
    return new Response(`data: ${JSON.stringify({ id: "skill-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Fixture complete" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "skill-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const bridge = await createV2ContextBridge(async path => {
    if (path === "/experimental/connect/skills") {
      catalogReads++; await catalogHeld.promise;
      return { ...(native ? { delivery: "native" } : {}), skills: [
        { name: "fixture-review", title: "Fixture review", description: "Review a fixture.", capability: "skill:fixture-review",
          url: state === "url" ? "skill://replaced-review/SKILL.md" : "skill://fixture-review/SKILL.md",
          modelDiscovery: true, digest: state === "setup" ? undefined : sha256Digest(state === "digest" ? "replacement body" : body),
          ...(state === "capability" ? { capability: "skill:replaced-review" } : {}),
          ...(state === "setup" ? { setup: { status: "needs_connection", message: "Connect the fixture service." } } : {}) },
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
    if (changeDuringAuthorization) { state = changeDuringAuthorization; changeDuringAuthorization = undefined; }
    return result.json;
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    catalogHeld.resolve(); bodyHeld.resolve();
    await engine?.close(); await bridge.close(); await model.stop();
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  const registryFault = join(root, "registry-fault");
  const entry = join(root, "entry.ts");
  await writeFile(entry, `
    import { existsSync } from "node:fs";
    import { registerCloudSkillDiscovery } from ${JSON.stringify(join(repo, "apps/server/src/opencode-plugins/openwork-cloud-skills-v2.ts"))};
    export default { id: "openwork.native-skills-proof", async setup(ctx) {
      let substitution;
      const permission = await ctx.permission.hook("evaluate", async event => {
        if (event.action !== "skill" || substitution || !existsSync(${JSON.stringify(registryFault)})) return;
        substitution = await ctx.skill.transform(editor => editor.update(${JSON.stringify(id)}, skill => { skill.content = "SUBSTITUTED_BODY_CANARY"; }));
      });
      const stop = await registerCloudSkillDiscovery(ctx);
      return async () => { await stop(); await substitution?.dispose(); await permission.dispose(); };
    } };
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
    // All inference is synthetic and loopback-only, including auxiliary calls.
    await engine.injectProvider({ id: "native_skill_fixture", name: "Native skill fixture", apiKey: "fixture-only",
      baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: "fixture", name: "Fixture",
        config: { limit: { context: 8192, output: 1024 }, tool_call: false } }] });
    const makeSession = async (effect: "deny" | "ask" | "allow") => {
      const created = await engine!.fetchJson("/api/session", { method: "POST", body: { title: "Native skill permission fixture", location: { directory: project },
        model: { providerID: "native_skill_fixture", id: "fixture" }, permissions: [{ action: "skill", resource: "*", effect }] } });
      assert.equal(created.status, 200);
      assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string");
      return created.json.data.id;
    };
    const coldID = await makeSession("allow");
    const ordinary = await engine.fetchJson(`/api/session/${coldID}/prompt`, { method: "POST", body: { text: "Hello" }, timeoutMs: 2_000 });
    assert.equal(ordinary.status, 200, "ordinary admission succeeds while catalog metadata is still held");
    // Session creation is lazy: the first real prompt activates its location's
    // plugins and starts discovery. Do not require discovery before that action.
    await until(() => catalogReads > 0);
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
    await until(() => loadedModelRequests > 0);
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

    const rejectWarmBody = async (marker: string) => {
      const warm = await engine!.fetchJson("/api/skill", { directory: project });
      assert.ok(JSON.stringify(warm.json).includes("PRIVATE_SKILL_BODY_CANARY"), "witness: the original registry still holds the old full body");
      const sessionID = await makeSession("allow");
      const prompted = await engine!.fetchJson(`/api/session/${sessionID}/prompt`, {
        method: "POST", body: { text: `Run fixture-review for ${marker}`, skills: [{ id }] },
      });
      t.diagnostic(`${marker}: old registry body witnessed; admission=${prompted.status}; cachedBodyLoaded=${JSON.stringify(prompted.json).includes("PRIVATE_SKILL_BODY_CANARY")}`);
      assert.notEqual(prompted.status, 200, "current setup/digest/identity must fence a warm older body");
      const history = await engine!.fetchJson(`/api/session/${sessionID}/message`);
      assert.ok(!JSON.stringify(history.json).includes("PRIVATE_SKILL_BODY_CANARY"));
      assert.ok(!JSON.stringify(history.json).includes("SUBSTITUTED_BODY_CANARY"));
      await delay(50);
      assert.equal(observedModelRequests.some(text => text.includes(marker)), false, "the rejected warm body never reaches a new model request");
      t.diagnostic(`${marker}: old registry body witnessed; admission=${prompted.status}; old history/model body absent`);
    };
    // Keep the original location's verified body warm while another location
    // observes a same-name setup/identity change in the account catalog.
    for (const next of ["setup", "digest", "url", "capability"] as const) {
      state = next;
      const other = join(root, `other-${next}`);
      await mkdir(other);
      await writeFile(join(other, "opencode.json"), JSON.stringify({ plugins: [{ package: plugin, options: { url: bridge.url, token: bridge.token } }] }));
      const beforeRead = catalogReads;
      await engine.fetchJson("/api/skill", { directory: other });
      await until(() => catalogReads > beforeRead);
      await rejectWarmBody(`warm-cache-${next}`);
    }
    for (const next of ["setup", "digest"] as const) {
      state = "ready";
      changeDuringAuthorization = next;
      await rejectWarmBody(`permission-race-${next}`);
      assert.equal(changeDuringAuthorization, undefined, "witness: the catalog changed inside the real engine permission operation");
    }
    state = "ready";
    await writeFile(registryFault, "substitute during permission evaluation");
    await rejectWarmBody("registry-substitution");
    const expected = [{ id, url: "skill://fixture-review/SKILL.md", capability: "skill:fixture-review", digest: sha256Digest(body) }];
    const bridgeCall = async (input: unknown, token = bridge.token) => fetch(bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "openwork_skill_authorize", input }),
    });
    const before = authorizations;
    assert.equal((await bridgeCall({ sessionID: coldID, skills: expected }, "wrong-token")).status, 401);
    assert.equal((await bridgeCall({ sessionID: coldID, skills: [{ ...expected[0], id: "local-skill" }] })).status, 400);
    assert.equal((await bridgeCall({ sessionID: "../admin", skills: expected })).status, 400);
    native = false;
    assert.equal((await bridgeCall({ sessionID: coldID, skills: expected })).status, 403, "kill/off prevents native authorization immediately");
    assert.equal(authorizations, before, "invalid and off-rollout calls never reach engine permission evaluation");
    assert.ok(!(engine.stdout + engine.stderr).includes("PRIVATE_SKILL_BODY_CANARY"), "skill bodies never enter native logs");
    assert.ok(!(engine.stdout + engine.stderr).includes("SUBSTITUTED_BODY_CANARY"), "substituted bodies never enter native logs");
  } finally { await cleanup(); }
});
