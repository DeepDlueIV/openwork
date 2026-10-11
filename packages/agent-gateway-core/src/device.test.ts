import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEVICE_CLIENT_ID,
  DEVICE_CODE_GRANT,
  DeviceFlowError,
  deviceLogin,
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceAuthorizationPrompt,
} from "./device.ts"
import { fakeFetch, json, type Route } from "./test-fetch.ts"

const API = "https://den.example.com"

function clock(start = 1_000_000) {
  let time = start
  const waits: number[] = []
  return {
    now: () => time,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DeviceFlowError("cancelled", "Sign-in was cancelled.")
      waits.push(ms)
      time += ms
    },
    waits,
    advance(ms: number) {
      time += ms
    },
  }
}

function authorization(now: number, overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return {
    clientId: DEVICE_CLIENT_ID,
    deviceCode: "device-code-secret",
    userCode: "ABCD-EFGH",
    verificationUri: `${API}/device`,
    verificationUriComplete: `${API}/device?user_code=ABCDEFGH`,
    intervalMs: 5_000,
    expiresAt: now + 900_000,
    ...overrides,
  }
}

const pending: Route = () => json(400, { error: "authorization_pending" })
const approved: Route = () => json(200, { access_token: "den-token", token_type: "Bearer" })

test("starts with the openwork-cli client id and formats the code", async () => {
  const c = clock()
  const { fetch, calls } = fakeFetch({
    "POST /api/auth/device/code": () => json(200, { device_code: "dc", user_code: "abcdefgh", interval: 3, expires_in: 600 }),
  })
  const started = await startDeviceAuthorization({ apiBaseUrl: API, fetch, now: c.now })
  assert.deepEqual(calls[0]?.body, { client_id: "openwork-cli" })
  assert.equal(started.userCode, "ABCD-EFGH")
  assert.equal(started.verificationUri, `${API}/device`)
  assert.equal(started.verificationUriComplete, `${API}/device?user_code=abcdefgh`)
  assert.equal(started.intervalMs, 3_000)
  assert.equal(started.expiresAt, c.now() + 600_000)
})

test("start failures report status and code only", async () => {
  const { fetch } = fakeFetch({ "POST /api/auth/device/code": () => json(400, { error: "invalid_client" }) })
  await assert.rejects(startDeviceAuthorization({ apiBaseUrl: API, fetch }), /400: invalid_client/)
})

test("polls through pending and slow_down (+5s) until approved", async () => {
  const c = clock()
  const { fetch, calls } = fakeFetch({
    "POST /api/auth/device/token": [pending, () => json(400, { error: "slow_down" }), pending, approved],
  })
  const token = await pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch, now: c.now, sleep: c.sleep })
  assert.equal(token, "den-token")
  assert.deepEqual(c.waits, [5_000, 5_000, 10_000, 10_000])
  assert.deepEqual(calls[0]?.body, { grant_type: DEVICE_CODE_GRANT, device_code: "device-code-secret", client_id: "openwork-cli" })
})

test("429 honours Retry-After and keeps the larger interval afterwards", async () => {
  const c = clock()
  const { fetch } = fakeFetch({
    "POST /api/auth/device/token": [() => json(429, {}, { "retry-after": "30" }), pending, approved],
  })
  await pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch, now: c.now, sleep: c.sleep })
  assert.deepEqual(c.waits, [5_000, 30_000, 10_000])
})

test("network timeouts double the interval and keep polling", async () => {
  const c = clock()
  let attempt = 0
  const base = fakeFetch({ "POST /api/auth/device/token": approved })
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    attempt++
    if (attempt <= 2) throw new DOMException("timed out", "TimeoutError")
    return base.fetch(input, init)
  }
  const token = await pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch, now: c.now, sleep: c.sleep })
  assert.equal(token, "den-token")
  assert.deepEqual(c.waits, [5_000, 10_000, 20_000])
})

test("access_denied, expired_token, expiry, and unknown errors end the flow", async () => {
  const c = clock()
  const denied = fakeFetch({ "POST /api/auth/device/token": () => json(400, { error: "access_denied" }) })
  await assert.rejects(
    pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch: denied.fetch, now: c.now, sleep: c.sleep }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "access_denied",
  )
  const expired = fakeFetch({ "POST /api/auth/device/token": () => json(400, { error: "expired_token" }) })
  await assert.rejects(
    pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch: expired.fetch, now: c.now, sleep: c.sleep }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "expired",
  )
  const forever = fakeFetch({ "POST /api/auth/device/token": pending })
  await assert.rejects(
    pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now(), { expiresAt: c.now() + 12_000 }), fetch: forever.fetch, now: c.now, sleep: c.sleep }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "expired",
  )
  assert.equal(forever.calls.length, 2)
  const broken = fakeFetch({ "POST /api/auth/device/token": () => json(500, { error: "server_error" }) })
  await assert.rejects(
    pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch: broken.fetch, now: c.now, sleep: c.sleep }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "poll_failed" && !error.message.includes("device-code-secret"),
  )
})

test("an aborted signal cancels polling", async () => {
  const c = clock()
  const controller = new AbortController()
  const { fetch } = fakeFetch({
    "POST /api/auth/device/token": () => {
      controller.abort()
      return json(400, { error: "authorization_pending" })
    },
  })
  await assert.rejects(
    pollDeviceToken({ apiBaseUrl: API, authorization: authorization(c.now()), fetch, now: c.now, sleep: c.sleep, signal: controller.signal }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "cancelled",
  )
})

function loginRoutes(orgs: unknown[], activeOrgId: string | null) {
  return {
    "POST /api/auth/device/code": () => json(200, { device_code: "dc-secret", user_code: "ABCDEFGH", interval: 1, expires_in: 600 }),
    "POST /api/auth/device/token": [pending, approved],
    "GET /v1/me": () => json(200, {
      user: { id: "u1", email: "a@example.com" },
      session: { expiresAt: "2026-10-18T00:00:00.000Z", activeOrganizationId: activeOrgId },
    }),
    "GET /v1/me/orgs": () => json(200, { orgs, activeOrgId }),
  }
}

test("deviceLogin shows only the code fields, then validates identity and org", async () => {
  const c = clock()
  const { fetch, calls } = fakeFetch(loginRoutes([{ id: "org_1", name: "Acme", slug: "acme", isActive: true }], "org_1"))
  const prompts: DeviceAuthorizationPrompt[] = []
  const result = await deviceLogin({
    apiBaseUrl: `${API}/`,
    fetch,
    now: c.now,
    sleep: c.sleep,
    onAuthorization: (prompt) => {
      prompts.push(prompt)
    },
  })
  assert.deepEqual(Object.keys(prompts[0] ?? {}).sort(), ["expiresAt", "userCode", "verificationUri", "verificationUriComplete"])
  assert.doesNotMatch(JSON.stringify(prompts), /dc-secret/)
  assert.deepEqual(result, {
    apiBaseUrl: API,
    token: "den-token",
    orgId: "org_1",
    orgName: "Acme",
    user: { id: "u1", email: "a@example.com" },
    expiresAt: Date.parse("2026-10-18T00:00:00.000Z"),
  })
  const me = calls.find((call) => call.path === "/v1/me")
  assert.equal(me?.headers.authorization, "Bearer den-token")
})

test("deviceLogin with orgId requires membership; no org at all is an error", async () => {
  const c = clock()
  const member = fakeFetch(loginRoutes([{ id: "org_1", name: "One" }, { id: "org_2", name: "Two" }], "org_1"))
  const result = await deviceLogin({ apiBaseUrl: API, orgId: "org_2", fetch: member.fetch, now: c.now, sleep: c.sleep, onAuthorization: () => {} })
  assert.equal(result.orgId, "org_2")
  assert.equal(member.calls.find((call) => call.path === "/v1/me")?.headers["x-openwork-org-id"], "org_2")

  const outsider = fakeFetch(loginRoutes([{ id: "org_1", name: "One" }], "org_1"))
  await assert.rejects(
    deviceLogin({ apiBaseUrl: API, orgId: "org_9", fetch: outsider.fetch, now: c.now, sleep: c.sleep, onAuthorization: () => {} }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "not_a_member",
  )
  const lonely = fakeFetch(loginRoutes([], null))
  await assert.rejects(
    deviceLogin({ apiBaseUrl: API, fetch: lonely.fetch, now: c.now, sleep: c.sleep, onAuthorization: () => {} }),
    (error: unknown) => error instanceof DeviceFlowError && error.code === "no_organization",
  )
})
