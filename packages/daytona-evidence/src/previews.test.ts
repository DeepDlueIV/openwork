import assert from "node:assert/strict";
import { test } from "node:test";
import { DaytonaApi, type Sandbox, type Snapshot } from "./api.ts";
import { DAYTONA_BASE_SNAPSHOT } from "./builder.ts";
import { cleanupDaytonaEvidence } from "./cleanup.ts";
import { DAYTONA_PREVIEW_WORLDS, PREVIEW_KIND, buildDaytonaPreview, daytonaPreviewProgress, hasDaytonaPreview, launchDaytonaPreview, previewDescriptor, previewOrigin } from "./previews.ts";

const sha = "a".repeat(40);
const reportId = "b".repeat(32);
const origin = "https://8080-signedcredential.daytonaproxy01.net";

/** Every provider operation goes through the real REST/toolbox serializer. */
async function witness() {
  const descriptor = await previewDescriptor(sha, "app-web");
  const snapshots = new Map<string, Snapshot>([[DAYTONA_BASE_SNAPSHOT, { id: "base", name: DAYTONA_BASE_SNAPSHOT, state: "active" }]]);
  const sandboxes = new Map<string, Sandbox>();
  const files = new Map<string, string>();
  const commands: string[] = [];
  const requests: { path: string; method: string; body: unknown }[] = [];
  const deleted: string[] = [];
  let mismatch = false;
  let failCommand = "";
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer host-only-key");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/sandbox" && method === "POST") {
      assert.ok(typeof body === "object" && body !== null && "name" in body && "labels" in body && "snapshot" in body && "public" in body);
      assert.equal(body.public, false);
      assert.equal(JSON.stringify(body).includes("host-only-key"), false);
      const id = `sandbox-${sandboxes.size + 1}`;
      assert.ok(typeof body.name === "string");
      assert.ok(typeof body.snapshot === "string");
      const labels: Record<string, string> = {};
      assert.ok(typeof body.labels === "object" && body.labels !== null);
      for (const [key, value] of Object.entries(body.labels)) { assert.equal(typeof value, "string"); labels[key] = value; }
      const sandbox: Sandbox = { id, name: body.name, snapshot: body.snapshot, public: false, state: "started", labels, createdAt: new Date().toISOString() };
      sandboxes.set(id, sandbox);
      files.set(`${id}/opt/openwork-preview/source-sha`, sha);
      files.set(`${id}/opt/openwork-preview/review-controller`, descriptor.controllerHash);
      return reply(sandbox);
    }
    if (path === "/sandbox" && method === "GET") return reply([...sandboxes.values()]);
    if (path === "/snapshots") return reply([...snapshots.values()]);
    if (path.startsWith("/snapshots/")) return reply(snapshots.get(decodeURIComponent(path.slice("/snapshots/".length))) ?? {}, snapshots.has(decodeURIComponent(path.slice("/snapshots/".length))) ? 200 : 404);
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "sandbox" && parts[1]) {
      const idOrName = parts[1];
      const sandbox = sandboxes.get(idOrName) ?? [...sandboxes.values()].find((entry) => entry.name === idOrName);
      if (!sandbox) return reply({}, 404);
      if (parts[2] === "ports") return reply({ url: origin });
      if (parts[2] === "stop") { sandbox.state = "stopped"; return reply({}); }
      if (parts[2] === "snapshot") {
        assert.ok(typeof body === "object" && body !== null && "name" in body && typeof body.name === "string");
        snapshots.set(body.name, { id: body.name, name: body.name, state: "active" });
        return reply({});
      }
      if (method === "DELETE") { deleted.push(sandbox.id); sandboxes.delete(sandbox.id); return reply({}); }
      return reply(sandbox);
    }
    if (parts[0] === "toolbox" && parts[1]) {
      const id = parts[1];
      if (path.endsWith("/files/download")) {
        const value = files.get(`${id}${url.searchParams.get("path")}`);
        return new Response(value ?? "", { status: value === undefined ? 404 : 200 });
      }
      if (path.endsWith("/files/upload")) {
        assert.ok(init?.body instanceof FormData);
        const file = init.body.get("file");
        assert.ok(file instanceof Blob);
        files.set(`${id}${url.searchParams.get("path")}`, await file.text());
        return reply({});
      }
      if (path.endsWith("/process/execute")) {
        assert.ok(typeof body === "object" && body !== null && "command" in body && typeof body.command === "string");
        commands.push(body.command);
        if (failCommand && body.command.includes(failCommand)) return reply({ exitCode: 1, result: "private failure host-only-key" });
        return reply({ exitCode: 0, result: body.command.includes("git rev-parse HEAD") ? (mismatch ? "c".repeat(40) : sha) : body.command.includes("echo building") ? "ready" : "" });
      }
    }
    throw new Error(`Unexpected fake route ${method} ${path}`);
  };
  const probe: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/__openwork_launch") return new Response(null, { status: 303, headers: { "set-cookie": `__Host-openwork-preview=${url.searchParams.get("token")}; Secure; HttpOnly` } });
    assert.match(new Headers(init?.headers).get("cookie") ?? "", /^__Host-openwork-preview=/);
    return url.pathname === "/" ? new Response('<script src="/@vite/client"></script>') : Response.json({ healthy: true });
  };
  return { api: new DaytonaApi({ apiKey: "host-only-key", apiUrl: "https://provider.test/api", region: "us-west-3" }, request), descriptor, snapshots, sandboxes, files, commands, requests, deleted, probe,
    mismatch: () => { mismatch = true; }, fail: (command: string) => { failCommand = command; } };
}

function ready(fixture: Awaited<ReturnType<typeof witness>>) {
  fixture.snapshots.set(fixture.descriptor.name, { id: "snapshot", name: fixture.descriptor.name, state: "active" });
}

test("preview identities include the exact commit; unsupported worlds and mutable refs fail closed", async () => {
  assert.deepEqual(DAYTONA_PREVIEW_WORLDS, ["app-web"]);
  const first = await previewDescriptor(sha, "app-web");
  assert.notEqual(first.name, (await previewDescriptor("c".repeat(40), "app-web")).name);
  assert.equal(first.name, (await previewDescriptor(sha, "app-web")).name);
  await assert.rejects(previewDescriptor("dev", "app-web"), /full pushed/);
  for (const world of ["desktop", "acme-web", "workbot"]) {
    if (world === "desktop" || world === "acme-web" || world === "workbot") await assert.rejects(previewDescriptor(sha, world), /web only/);
  }
  for (const url of ["https://8080-12345678-1234-1234-1234-123456789abc.daytonaproxy01.net", `${origin}/?token=secret`, "https://attacker.test/", `http://${new URL(origin).host}`]) assert.throws(() => previewOrigin(url));
});

test("build reuses private base/layer machinery and saves a hot exact-source world", async () => {
  const fixture = await witness();
  await buildDaytonaPreview(sha, "app-web", fixture.api, { sourceFetch: async () => Response.json({ tree: [], truncated: false }) });
  assert.equal(await hasDaytonaPreview(sha, "app-web", fixture.api), true);
  const script = [...fixture.files.entries()].find(([path]) => path.endsWith("/review-world.sh"))?.[1] ?? "";
  const appScript = [...fixture.files.entries()].find(([path]) => path.endsWith("/review-app.sh"))?.[1] ?? "";
  assert.ok(appScript.includes(`git fetch --depth=1 origin ${sha}`));
  assert.ok(appScript.includes(`test "$(git rev-parse HEAD)" = "${sha}"`));
  assert.ok(script.includes("setpriv --reuid=openwork-preview --regid=openwork-preview --init-groups --no-new-privs --bounding-set=-all"));
  assert.ok(script.includes("/bin/bash /opt/openwork-preview/review-app.sh"));
  assert.equal(script.includes("pnpm install"), false);
  const unit = [...fixture.files.entries()].find(([path]) => path.endsWith("/openwork-review-runtime.service"))?.[1] ?? "";
  assert.ok(unit.includes("User=openwork-preview\nGroup=openwork-preview\nNoNewPrivileges=yes\nCapabilityBoundingSet="));
  assert.ok(unit.includes("ProtectSystem=strict\nPrivateTmp=yes\nReadWritePaths=/workspace /opt/openwork-preview/state /home/openwork-preview"));
  assert.equal(unit.includes("ReadWritePaths=/opt/openwork-preview\n"), false);
  assert.ok(fixture.descriptor.scripts.runtime.includes('"/opt/openwork-preview/state/services.json"'));
  assert.ok(fixture.descriptor.scripts.health.includes('"/opt/openwork-preview/state/outputs.json"'));
  assert.ok(script.includes("node /opt/openwork-preview/health.mjs"));
  assert.ok(appScript.includes("pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile"));
  assert.equal(script.includes("host-only-key"), false);
  const saves = fixture.requests.filter((entry) => entry.path.endsWith("/snapshot"));
  assert.deepEqual(saves.map((entry) => entry.body), [
    { name: fixture.descriptor.toolsName, includeMemory: false }, { name: fixture.descriptor.name, includeMemory: true },
  ]);
  assert.equal(fixture.sandboxes.size, 0);
  const before = fixture.requests.filter((entry) => entry.method === "POST" && entry.path === "/sandbox").length;
  await buildDaytonaPreview(sha, "app-web", fixture.api);
  assert.equal(fixture.requests.filter((entry) => entry.method === "POST" && entry.path === "/sandbox").length, before);
});

test("a failed world build releases its owned builder and never publishes a ready snapshot", async () => {
  const fixture = await witness();
  fixture.fail("systemd-run --collect --unit=openwork-review-world");
  await assert.rejects(buildDaytonaPreview(sha, "app-web", fixture.api, { sourceFetch: async () => Response.json({ tree: [], truncated: false }) }), /guest command failed/);
  assert.equal(await hasDaytonaPreview(sha, "app-web", fixture.api), false);
  assert.equal(fixture.sandboxes.size, 0);
  assert.equal(fixture.deleted.length, 2);
});

test("each launch gets a private fresh VM, exact-source witness, deadline and signed cookie handshake", async () => {
  const fixture = await witness(); ready(fixture);
  const launch = () => launchDaytonaPreview({ gitSha: sha, reportId, world: "app-web" }, fixture.api, fixture.probe);
  const first = await launch();
  const second = await launch();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.url, second.url);
  assert.equal(first.gitSha, sha);
  assert.equal(first.world, "app-web");
  assert.ok(Date.parse(first.expiresAt) <= Date.now() + 7200_000);
  assert.ok(Date.parse(first.expiresAt) > Date.now() + 7190_000);
  const sandbox = fixture.sandboxes.get(first.id);
  assert.equal(sandbox?.labels.reportId, reportId);
  assert.equal(sandbox?.labels.expiresAt, first.expiresAt);
  assert.equal(sandbox?.labels.kind, PREVIEW_KIND);
  assert.ok(fixture.commands.some((command) => /systemd-run --unit=openwork-review-expiry --on-active=\d+s \/usr\/sbin\/poweroff/.test(command)));
  const access = JSON.parse(fixture.files.get(`${first.id}/opt/openwork-preview/access.json`) ?? "{}");
  assert.deepEqual(access.allowedOrigins, [origin]);
  assert.equal(new URL(first.url).searchParams.get("token"), access.token);
  assert.ok(fixture.commands.some((command) => command === "chmod 600 '/opt/openwork-preview/access.json'"));
  assert.equal(fixture.deleted.length, 0);
});

for (const mode of ["source", "deadline", "health", "external"]) test(`a ${mode} failure deletes only the newly owned preview and exposes no credential`, async () => {
  const fixture = await witness(); ready(fixture);
  if (mode === "source") fixture.mismatch();
  if (mode === "deadline") fixture.fail("openwork-review-expiry");
  if (mode === "health") fixture.fail("health.mjs");
  await assert.rejects(launchDaytonaPreview({ gitSha: sha, reportId, world: "app-web" }, fixture.api, mode === "external" ? async () => new Response("not ready", { status: 502 }) : fixture.probe), (error: Error) => !error.message.includes("host-only-key") && /could not be reached/.test(error.message));
  assert.deepEqual(fixture.deleted, ["sandbox-1"]);
  assert.equal(fixture.sandboxes.size, 0);
});

test("progress reads provider-owned durable layer state, not process memory", async () => {
  const fixture = await witness();
  assert.deepEqual(await daytonaPreviewProgress(sha, "app-web", fixture.api), { building: false, steps: [] });
  await buildDaytonaPreview(sha, "app-web", fixture.api, { sourceFetch: async () => Response.json({ tree: [], truncated: false }) });
  const created = fixture.requests.find((entry) => entry.path === "/sandbox" && entry.method === "POST")?.body;
  assert.ok(typeof created === "object" && created !== null && "name" in created && typeof created.name === "string");
  fixture.sandboxes.set("builder", { id: "builder", name: created.name, state: "started", labels: { kind: "openwork-daytona-builder-v1" } });
  assert.equal((await daytonaPreviewProgress(sha, "app-web", fixture.api)).building, true);
});

test("independent cleanup deletes an expired active preview, never a still-valid one", async () => {
  const fixture = await witness(); ready(fixture);
  const first = await launchDaytonaPreview({ gitSha: sha, reportId, world: "app-web" }, fixture.api, fixture.probe);
  const second = await launchDaytonaPreview({ gitSha: sha, reportId, world: "app-web" }, fixture.api, fixture.probe);
  const sandbox = fixture.sandboxes.get(first.id);
  assert.ok(sandbox);
  sandbox.labels.expiresAt = new Date(Date.now() - 1).toISOString();
  const result = await cleanupDaytonaEvidence(fixture.api);
  assert.deepEqual(result.deletedSandboxes, [sandbox.name]);
  assert.equal(fixture.sandboxes.has(second.id), true);
});
