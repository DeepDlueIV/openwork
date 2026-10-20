import assert from "node:assert/strict"
import { test } from "node:test"
import { createReadinessController, emailReadiness, initialReadiness, organizationReadiness, probeDeploymentServices, readinessServiceOrigin, SERVICE_READINESS_TTL_MS, type ServiceProbeDependencies } from "../src/service-readiness.js"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"

const token = "test-service-token-not-for-production".repeat(2)
const env = { DEN_HEADLESS_RUNNER_URL: "https://runner.example.test", DEN_HEADLESS_RUNNER_TOKEN: token, DEN_WORKBOT_URL: "https://workbot.example.test", DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "callback-not-for-production".repeat(2), GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "https://gateway.example.test" }
const runner = { version: 1, service: "headless-runner", modelConfigured: false, resumeConfigured: true, denOriginMatches: true }
const workbot = { version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: true }
function json(body: unknown, status = 200) { return Response.json(body, { status }) }
function deps(overrides: Partial<ServiceProbeDependencies> = {}): ServiceProbeDependencies {
  return {
    env: {}, denOrigin: "https://den.example.test", database: async () => undefined,
    fetch: async (url, init) => {
      assert.equal(init.method, "GET")
      assert.equal(init.redirect, "manual")
      const request = new URL(url)
      if (request.hostname.startsWith("runner")) {
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`)
        assert.equal(new Headers(init.headers).get("X-OpenWork-Den-Origin"), "https://den.example.test")
        assert.equal(request.pathname, "/v1/health")
        return json(runner)
      }
      if (request.hostname.startsWith("workbot")) { assert.equal(request.pathname, "/internal/readiness"); return json(workbot) }
      assert.ok(["/health", "/ready"].includes(request.pathname))
      return json({ ok: true, service: "gateway", ...(request.pathname === "/ready" ? { checks: { database: "ok" } } : {}) })
    }, ...overrides,
  }
}
async function service(id: string, overrides: Partial<ServiceProbeDependencies>) {
  const result = await probeDeploymentServices(deps(overrides))
  const status = [...result.services].find(([key]) => key === id)?.[1]
  assert.ok(status)
  return status
}

test("initial configuration hints distinguish absent settings from unverified health without outbound work", () => {
  const empty = initialReadiness({})
  assert.equal(empty.services.find((status) => status.id === "database")?.state, "unknown")
  for (const status of empty.services) if (status.id !== "database") assert.equal(status.state, "not_configured")
  const configured = initialReadiness(env)
  for (const id of ["gateway", "headlessRunner", "workbot"]) {
    const status = configured.services.find((entry) => entry.id === id)
    assert.equal(status?.configured, true)
    assert.equal(status?.reason, "not_checked")
    assert.equal(status?.checkedAt, null)
    assert.equal(status?.stale, true)
  }
  assert.ok(configured.services.every((status) => status.state !== "ready"))
  assert.ok(!JSON.stringify(configured).includes(token))
})

test("no optional services configured: only an actual database SELECT dependency succeeds, no fetches", async () => {
  let queries = 0
  const result = await probeDeploymentServices(deps({ database: async () => { queries++ }, fetch: async () => { throw new Error("must not fetch") } }))
  assert.equal(queries, 1)
  assert.equal(result.services.get("database")?.reason, "database_verified")
  for (const [id, status] of result.services) if (id !== "database") assert.equal(status.state, "not_configured", id)
})

test("partial runner, workbot and durable settings are misconfigured and disclose constant setting names only", async () => {
  const source = { DEN_HEADLESS_RUNNER_URL: "https://secret.example.test", DEN_WORKBOT_URL: "https://secret.example.test" }
  const result = await probeDeploymentServices(deps({ env: source, fetch: async () => { throw new Error("not called") } }))
  assert.deepEqual(result.services.get("headlessRunner")?.missingSettings, ["DEN_HEADLESS_RUNNER_TOKEN"])
  assert.deepEqual(result.services.get("workbot")?.missingSettings, ["DEN_HEADLESS_RUNNER_TOKEN"])
  assert.ok(!JSON.stringify([...result.services]).includes("secret.example"))
})

test("service identity and actual Gateway database readiness are required; never model calls", async () => {
  const calls: string[] = []
  const base = deps({ env })
  const result = await probeDeploymentServices({ ...base, fetch: async (url, init) => { calls.push(url); return base.fetch(url, init) } })
  for (const id of ["gateway", "headlessRunner", "workbot"]) assert.equal([...result.services].find(([key]) => key === id)?.[1].reason, "health_verified")
  assert.equal(calls.length, 4)
  assert.equal(result.services.get("slack")?.reason, "organization_setup_required")
  assert.equal(result.services.get("durableTurns")?.reason, "callback_unverified")
  assert.equal((await service("gateway", { env, fetch: async () => json({ ok: true, service: "den-api" }) })).reason, "incompatible_service")
  assert.equal((await service("gateway", { env, fetch: async (url) => url.endsWith("/ready") ? json({ ok: true, service: "gateway", checks: { database: "error" } }) : json({ ok: true, service: "gateway" }) })).state, "unknown")
})

for (const status of [401, 403, 404, 500, 302]) test(`HTTP ${status} is fixed-classified without reflecting an error body`, async () => {
  const result = await service("headlessRunner", { env, fetch: async () => new Response("secret-token https://sensitive.test", { status, headers: { location: "http://169.254.169.254" } }) })
  assert.equal(result.reason, status === 401 || status === 403 ? "authentication_failed" : status === 404 ? "incompatible_service" : status === 500 ? "request_failed" : "unexpected_response")
  assert.ok(!JSON.stringify(result).includes("sensitive"))
})

test("wrong service, invalid JSON and non-JSON bodies are never ready", async () => {
  for (const response of [json({ ...runner, service: "workbot" }), new Response("not-json", { headers: { "content-type": "application/json" } }), new Response(JSON.stringify(runner), { headers: { "content-type": "text/html" } })]) {
    assert.notEqual((await service("headlessRunner", { env: { DEN_HEADLESS_RUNNER_URL: env.DEN_HEADLESS_RUNNER_URL, DEN_HEADLESS_RUNNER_TOKEN: token }, fetch: async () => response })).state, "ready")
  }
})

test("runner/workbot Den origin mismatch and missing runner setup are misconfigured", async () => {
  for (const id of ["headlessRunner", "workbot"]) {
    const base = deps({ env })
    const status = await service(id, { env, fetch: async (url, init) => url.includes(id === "workbot" ? "workbot" : "runner") ? json({ ...(id === "workbot" ? workbot : runner), denOriginMatches: false }) : base.fetch(url, init) })
    assert.equal(status.state, "misconfigured")
  }
  assert.equal((await service("workbot", { env, fetch: async (url) => json(url.includes("runner") ? runner : { ...workbot, runnerConfigured: false }) })).state, "misconfigured")
})

test("timeouts abort, including never-resolving fetches; raw errors are discarded", async () => {
  let aborted = 0
  const result = await service("headlessRunner", { env, timeoutMs: 5, fetch: async (_url, init) => new Promise(() => { init.signal?.addEventListener("abort", () => { aborted++ }) }) })
  assert.equal(result.reason, "timeout")
  assert.ok(aborted > 0)
  const thrown = await service("headlessRunner", { env, fetch: async () => { throw new Error(`Authorization: Bearer ${token} https://secret.test`) } })
  assert.equal(thrown.reason, "request_failed")
  assert.ok(!JSON.stringify(thrown).includes(token))
})

test("large streaming body is cancelled at the byte limit, not buffered unboundedly", async () => {
  let cancelled = false
  const response = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(20_000)) }, cancel() { cancelled = true } }), { headers: { "content-type": "application/json" } })
  const result = await service("headlessRunner", { env, fetch: async () => response() })
  assert.equal(result.reason, "unexpected_response")
  assert.equal(cancelled, true)
})

for (const raw of ["https://user:password@example.test", "https://example.test?secret=x", "https://example.test#x", "https://example.test/path", "https://169.254.169.254", "https://[fe80::1]", "https://[fd00:ec2::254]", "https://[::ffff:169.254.169.254]", "http://public.example.test", "https://metadata.google.internal", "file:///health"]) test(`unsafe origin is rejected: ${raw.replace(/password|secret/g, "fixture")}`, () => assert.throws(() => readinessServiceOrigin(raw)))
for (const raw of ["https://service.example.test", "http://headless-runner:8795", "http://runner.svc.cluster.local:8795", "http://localhost:8795", "http://127.0.0.1:8795", "http://[::1]:8795"]) test(`operator origin accepted: ${raw}`, () => assert.equal(readinessServiceOrigin(raw), new URL(raw).origin))

test("durable turns are optional without callback settings, but partial remote resume setup is misconfigured", async () => {
  const runnerOnly = { DEN_HEADLESS_RUNNER_URL: env.DEN_HEADLESS_RUNNER_URL, DEN_HEADLESS_RUNNER_TOKEN: token }
  assert.equal((await service("durableTurns", { env: runnerOnly, fetch: async () => json({ ...runner, resumeConfigured: false, denOriginMatches: null }) })).state, "not_configured")
  const partial = await service("durableTurns", { env: runnerOnly, fetch: async () => json(runner) })
  assert.equal(partial.state, "misconfigured")
  assert.deepEqual(partial.missingSettings, ["DEN_HEADLESS_RUNNER_CALLBACK_TOKEN"])
})

test("email matches SMTP > Resend > development sink, no transport side effects", () => {
  assert.equal(emailReadiness({}).state, "not_configured")
  assert.equal(emailReadiness({ OPENWORK_DEV_MODE: "1" }).reason, "configuration_only")
  assert.equal(emailReadiness({ RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test", SMTP_HOST: "smtp.internal", SMTP_PORT: "bad" }).state, "misconfigured")
  assert.equal(emailReadiness({ RESEND_API_KEY: "test" }).reason, "missing_configuration")
  assert.equal(emailReadiness({ SMTP_HOST: "smtp.internal", SMTP_USER: "user", EMAIL_FROM: "test@example.test" }).reason, "missing_configuration")
  assert.equal(emailReadiness({ SMTP_USER: "user" }).state, "misconfigured")
  assert.equal(emailReadiness({ RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test" }).reason, "delivery_unverified")
  assert.equal(emailReadiness({ SMTP_HOST: "smtp.internal", EMAIL_FROM: "test@example.test" }).reason, "delivery_unverified")
})

test("singleflight admission, fresh failed status, stale TTL and retained lastSuccessAt; cheap projection cannot probe", async () => {
  let time = Date.parse("2026-10-19T00:00:00Z")
  let admissions = 0
  let probes = 0
  let fail = false
  let finish: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const controller = createReadinessController({ now: () => time, enabled: async () => true, admit: async () => { admissions++; return null }, probe: async () => { probes++; await gate; return probeDeploymentServices(deps({ database: async () => { if (fail) throw new Error("sensitive") } })) } })
  deploymentServiceReadinessSchema.parse(controller.snapshot())
  assert.equal(controller.snapshot().checkedAt, null)
  const requests = Array.from({ length: 8 }, () => controller.refresh())
  await Promise.all(requests)
  assert.equal(controller.snapshot().checking, true)
  assert.equal(admissions, 1)
  assert.equal(probes, 1)
  finish?.()
  await controller.idle()
  const success = controller.snapshot().services[0].lastSuccessAt
  assert.ok(success)
  assert.equal(controller.snapshot().services[0].stale, false)
  time += SERVICE_READINESS_TTL_MS
  assert.equal(controller.snapshot().services[0].stale, true)
  fail = true
  await controller.refresh()
  await controller.idle()
  const failed = controller.snapshot().services[0]
  assert.equal(failed.state, "unreachable")
  assert.equal(failed.stale, false)
  assert.equal(failed.lastSuccessAt, success)
  const minimal = organizationServiceReadinessSchema.parse(organizationReadiness(controller.snapshot()))
  for (const entry of minimal.services) { assert.equal("required" in entry, false); assert.equal("missingSettings" in entry, false) }
  for (let i = 0; i < 100; i++) organizationReadiness(controller.snapshot())
  assert.equal(probes, 2)
})

test("global rate denial and kill switch stop admissions and new probes, not in-flight work", async () => {
  let enabled = false
  let admitted = 0
  let probes = 0
  const controller = createReadinessController({ enabled: async () => enabled, admit: async () => { admitted++; return 30 }, probe: async () => { probes++; return probeDeploymentServices(deps()) } })
  await controller.refresh()
  assert.equal(admitted, 0)
  enabled = true
  assert.equal(await controller.refresh(), 30)
  assert.equal(probes, 0)
  let checks = 0
  const raced = createReadinessController({ enabled: async () => ++checks === 1, admit: async () => null, probe: async () => { probes++; return probeDeploymentServices(deps()) } })
  await raced.refresh()
  await raced.idle()
  assert.equal(probes, 0)
  const active = createReadinessController({ enabled: async () => enabled, admit: async () => null, probe: async () => { enabled = false; return probeDeploymentServices(deps()) } })
  await active.refresh()
  await active.idle()
  assert.equal(active.snapshot().services[0].state, "ready")
})

test("Check now coalesces a recently completed GET refresh without admission, probes or timestamp changes", async () => {
  let time = Date.parse("2026-10-19T00:00:00Z")
  let admissions = 0
  let probes = 0
  const controller = createReadinessController({ now: () => time, enabled: async () => true, admit: async () => { admissions++; return admissions === 1 ? null : 30 }, probe: async () => { probes++; return probeDeploymentServices(deps()) } })
  // The admin GET's fire-and-forget refresh finishes before the person presses Check now.
  void controller.refresh()
  await controller.idle()
  const completed = controller.snapshot()
  assert.ok(completed.checkedAt)
  time += 29_999
  assert.equal(await controller.refresh(), null)
  assert.deepEqual(controller.snapshot(), completed)
  assert.equal(admissions, 1)
  assert.equal(probes, 1)
  time++
  assert.equal(await controller.refresh(), 30, "once the coalescing window expires, the durable quota still applies")
  assert.equal(probes, 1)
  assert.deepEqual(controller.snapshot(), completed)
})

test("quota denial rechecks the shared snapshot to coalesce a different replica that just finished", async () => {
  const time = Date.parse("2026-10-19T00:00:00Z")
  const publisher = createReadinessController({ now: () => time, enabled: async () => true, admit: async () => null, probe: () => probeDeploymentServices(deps()) })
  await publisher.refresh()
  await publisher.idle()
  let shared: ReturnType<typeof publisher.snapshot> | null = null
  let reads = 0
  const replica = createReadinessController({ now: () => time, enabled: async () => true,
    load: async () => { reads++; return shared },
    admit: async () => { shared = publisher.snapshot(); return 30 },
    probe: async () => { assert.fail("a shared recent result must not launch another probe") },
  })
  assert.equal(await replica.refresh(), null)
  assert.equal(reads, 2)
  assert.deepEqual(replica.snapshot(), publisher.snapshot())
})

test("cached snapshot can be synchronized without ever initiating a probe", async () => {
  const saved = { ...initialReadiness(), checkedAt: "2026-10-19T00:00:00.000Z" }
  const controller = createReadinessController({ enabled: async () => true, admit: async () => { throw new Error("no admission") }, load: async () => saved, probe: async () => { throw new Error("no probe") } })
  controller.syncCache()
  await controller.idle()
  assert.equal(controller.snapshot().checkedAt, saved.checkedAt)
})
