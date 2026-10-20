import assert from "node:assert/strict"
import type { ServerResponse } from "node:http"
import { after, test } from "node:test"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import { bootDen, field, startFakeHttpServer, summary } from "./harness.js"

const requests: string[] = []
const pending: ServerResponse[] = []
const token = "readiness-test-service-token-not-production".repeat(2)
let hold = true
const runnerHealth = { version: 1, service: "headless-runner", modelConfigured: false, resumeConfigured: true, denOriginMatches: true }
const fake = await startFakeHttpServer((request, _body, response) => {
  const path = request.url ?? ""
  requests.push(path)
  response.setHeader("content-type", "application/json")
  if (path === "/health") return void response.end(JSON.stringify({ ok: true, service: "gateway" }))
  if (path === "/ready") return void response.end(JSON.stringify({ ok: true, service: "gateway", checks: { database: "ok" } }))
  assert.equal(request.headers.authorization, `Bearer ${token}`)
  assert.equal(request.headers["x-openwork-den-origin"], "http://127.0.0.1:8790")
  if (path === "/v1/health") {
    if (hold) pending.push(response)
    else response.end(JSON.stringify(runnerHealth))
    return
  }
  assert.equal(path, "/internal/readiness")
  response.end(JSON.stringify({ version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: true }))
})
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  DEN_HEADLESS_RUNNER_URL: fake.url, DEN_HEADLESS_RUNNER_TOKEN: token,
  DEN_WORKBOT_URL: fake.url, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "readiness-test-callback-token".repeat(2),
  // Test the legacy configured proxy without changing Gateway deployment intent.
  GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: fake.url,
} })
after(async () => { for (const response of pending) response.end(JSON.stringify(runnerHealth)); await fake.close(); await den.close() })

async function waitForRunner() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pending.length) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("background runner probe was not started")
}

test("real MySQL: guarded, cheap cached member projection; bounded asynchronous admin probes, durable admission and kill switch", async () => {
  const admin = await den.signUp("Readiness Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
  const setFeature = (orgId: string, enabled: boolean) => den.request(admin.token, "PUT", `/v1/admin/organizations/${orgId}/capabilities`, { body: { capabilities: { serviceReadiness: enabled } } })
  const first = await den.createOrg(await den.signUp("Readiness Member"), "Readiness org one")
  const second = await den.createOrg(await den.signUp("Other Readiness Member"), "Readiness org two")
  const before = await den.as(first.owner, first.orgId)("GET", "/v1/org")
  const gatewayIntent = field(before.body, "deploymentCapabilities", "aiGateway")
  assert.equal(field(before.body, "deploymentCapabilities", "serviceReadiness"), undefined)

  for (const path of ["/v1/admin/services", "/v1/admin/services/check"]) {
    const method = path.endsWith("check") ? "POST" : "GET"
    assert.equal((await den.request(null, method, path)).status, 401)
    assert.equal((await den.request(first.owner.token, method, path)).status, 403, "non-admin is rejected before the disabled-feature guard")
    assert.equal((await den.request(admin.token, method, path)).status, 404)
  }
  assert.equal(requests.length, 0)
  assert.equal((await setFeature(first.orgId, true)).status, 200)
  // An org override alone cannot create an orphan deployment probe surface.
  assert.equal((await den.as(first.owner, first.orgId)("GET", "/v1/org/service-readiness")).status, 404)
  assert.equal(field((await den.as(first.owner, first.orgId)("GET", "/v1/org")).body, "deploymentCapabilities", "serviceReadiness"), undefined)
  assert.equal(requests.length, 0)

  const enabled = await den.request(admin.token, "PUT", "/v1/admin/features/serviceReadiness", { body: { enabled: true } })
  assert.equal(enabled.status, 200, summary(enabled))
  // Explicitly disabled org does not receive deployment facts, and foreign org selection is refused.
  assert.equal((await setFeature(second.orgId, false)).status, 200)
  assert.equal((await den.as(second.owner, second.orgId)("GET", "/v1/org/service-readiness")).status, 404)
  assert.equal(field((await den.as(second.owner, second.orgId)("GET", "/v1/org")).body, "deploymentCapabilities", "serviceReadiness"), undefined)
  const foreign = await den.as(second.owner, first.orgId)("GET", "/v1/org/service-readiness")
  assert.ok(foreign.status === 403 || foreign.status === 404, summary(foreign))
  const cached = await den.as(first.owner, first.orgId)("GET", "/v1/org/service-readiness")
  assert.equal(cached.status, 200, summary(cached))
  assert.equal(organizationServiceReadinessSchema.parse(cached.body).checkedAt, null)
  const org = await den.as(first.owner, first.orgId)("GET", "/v1/org")
  const projection = organizationServiceReadinessSchema.parse(field(org.body, "deploymentCapabilities", "serviceReadiness"))
  assert.equal(projection.checkedAt, null)
  assert.deepEqual(field(org.body, "deploymentCapabilities", "aiGateway"), gatewayIntent)
  assert.equal(requests.length, 0, "neither member route may initiate probes")

  const queued = await den.request(admin.token, "POST", "/v1/admin/services/check")
  assert.equal(queued.status, 202, summary(queued))
  assert.equal(deploymentServiceReadinessSchema.parse(queued.body).checking, true, "POST returns before the held upstream response")
  await waitForRunner()
  const duplicate = await den.request(admin.token, "POST", "/v1/admin/services/check")
  assert.equal(duplicate.status, 202, summary(duplicate))
  const cheapGet = await den.request(admin.token, "GET", "/v1/admin/services")
  assert.equal(cheapGet.status, 200, summary(cheapGet))
  assert.equal(deploymentServiceReadinessSchema.parse(cheapGet.body).checkedAt, null)
  assert.equal(requests.filter((path) => path === "/v1/health").length, 1)

  // A second controller is a different replica's admission path, using the same real durable limiter.
  const { createReadinessController, SERVICE_READINESS_RATE_KEY, SERVICE_READINESS_RATE_WINDOW_MS } = await import("../../src/service-readiness.js")
  const { checkRateLimit } = await import("../../src/utils/rate-limit.js")
  const replica = createReadinessController({ enabled: async () => true,
    admit: () => checkRateLimit(SERVICE_READINESS_RATE_KEY, 1, SERVICE_READINESS_RATE_WINDOW_MS, Date.now()),
    probe: async () => { assert.fail("another replica must not start a probe inside the durable window") },
  })
  assert.ok((await replica.refresh()) !== null)

  const killed = await den.request(admin.token, "PUT", "/v1/admin/features/serviceReadiness", { body: { killed: true } })
  assert.equal(killed.status, 200, summary(killed))
  assert.equal((await den.request(admin.token, "POST", "/v1/admin/services/check")).status, 404)
  assert.equal((await den.as(first.owner, first.orgId)("GET", "/v1/org/service-readiness")).status, 404)
  const whileKilled = await den.as(first.owner, first.orgId)("GET", "/v1/org")
  assert.equal(whileKilled.status, 200)
  assert.equal(field(whileKilled.body, "deploymentCapabilities", "serviceReadiness"), undefined)
  assert.deepEqual(field(whileKilled.body, "deploymentCapabilities", "aiGateway"), gatewayIntent)
  hold = false
  for (const response of pending.splice(0)) response.end(JSON.stringify(runnerHealth))
  const { serviceReadiness } = await import("../../src/service-readiness-runtime.js")
  await serviceReadiness.idle()
  assert.equal(serviceReadiness.snapshot().services.find((status) => status.id === "database")?.state, "ready", "real SELECT succeeded; killing diagnostics preserved in-flight work")

  await den.request(admin.token, "PUT", "/v1/admin/features/serviceReadiness", { body: { killed: false } })
  const completed = serviceReadiness.snapshot()
  const completedRequestCount = requests.length
  const freshGet = await den.request(admin.token, "GET", "/v1/admin/services")
  assert.equal(freshGet.status, 200, summary(freshGet))
  const coalesced = await den.request(admin.token, "POST", "/v1/admin/services/check")
  assert.equal(coalesced.status, 202, summary(coalesced))
  assert.equal(coalesced.headers.get("retry-after"), null)
  assert.deepEqual(deploymentServiceReadinessSchema.parse(coalesced.body), completed, "Check now reuses the completed result without changing success/check timestamps")
  assert.equal(requests.length, completedRequestCount, "fresh GET then Check now must not launch duplicate probes")
  assert.ok((await replica.refresh()) !== null, "a replica without Redis or a fresh local result still obeys the global quota")
  const fresh = await den.as(first.owner, first.orgId)("GET", "/v1/org/service-readiness")
  const memberSnapshot = organizationServiceReadinessSchema.parse(fresh.body)
  assert.ok(memberSnapshot.checkedAt)
  assert.equal(memberSnapshot.services.find((status) => status.id === "slack")?.reason, "organization_setup_required")
  assert.equal(memberSnapshot.services.find((status) => status.id === "durableTurns")?.reason, "callback_unverified")
  for (const status of memberSnapshot.services) { assert.equal("missingSettings" in status, false); assert.equal("required" in status, false) }
  for (const secret of [token, fake.url, "Authorization"]) assert.ok(!fresh.text.includes(secret))
  assert.ok(!requests.some((path) => /resume-token|catalog|models|turns|events/.test(path)))
})
