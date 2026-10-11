import test from "node:test"
import assert from "node:assert/strict"
import { DEVICE_CLIENT_ID, DEFAULT_API_BASE_URL, deviceLogin, normalizeApiBaseUrl, pollDeviceToken, requestJson, retryAfterMs, startDeviceAuthorization, validateIdentity } from "../src/auth.mjs"

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const authorization = { apiBaseUrl: DEFAULT_API_BASE_URL, clientId: DEVICE_CLIENT_ID, deviceCode: "device-secret", intervalMs: 1000, expiresAt: 100_000 }
const me = { user: { id: "user-test", email: "member@example.test" }, session: { activeOrganizationId: "org-test", expiresAt: "2099-01-01T00:00:00.000Z" } }
const orgs = { activeOrgId: "org-test", orgs: [{ id: "org-test", name: "Test Organization" }] }

test("bootstrap API default and existing CLI device client", () => {
  assert.equal(DEFAULT_API_BASE_URL, "https://api.openworklabs.com")
  assert.equal(DEVICE_CLIENT_ID, "openwork-cli")
  assert.equal(normalizeApiBaseUrl("https://example.test/"), "https://example.test")
  for (const url of ["http://example.test", "http://localhost.example.test", "https://u:p@example.test", "file:///secret", "https://example.test?token=secret", "https://example.test#secret"]) assert.throws(() => normalizeApiBaseUrl(url))
  for (const url of ["http://localhost:4444", "http://127.0.0.1:4444", "http://[::1]:4444"]) assert.equal(normalizeApiBaseUrl(url), url)
})

test("requests forbid redirects, scope org headers and bound bodies", async () => {
  await requestJson({ apiBaseUrl: DEFAULT_API_BASE_URL, path: "/v1/me/orgs", token: "secret", orgId: "org-test", fetcher: async (_, init) => {
    assert.equal(init.redirect, "error")
    assert.equal(init.headers.authorization, "Bearer secret")
    assert.equal(init.headers["x-openwork-org-id"], "org-test")
    assert.equal(init.headers["x-openwork-legacy-org-id"], "org-test")
    return json(orgs)
  } })
  await assert.rejects(requestJson({ path: "/v1/me", fetcher: async () => new Response(null, { status: 302 }) }), /redirects/)
  await assert.rejects(requestJson({ path: "//evil.test" }), /request path/)
  await assert.rejects(requestJson({ path: "/v1/me", fetcher: async () => new Response("secret", { headers: { "content-length": "1048577" } }) }), /size limit/)
  await assert.rejects(requestJson({ path: "/v1/me", fetcher: async () => new Response("x".repeat(1048577)) }), /size limit/)
  await assert.rejects(requestJson({ path: "/v1/me", fetcher: async () => new Response("token: secret") }), /invalid JSON/)
})

test("timeout includes a stalled response body", async () => {
  let cancelled = false
  await assert.rejects(requestJson({ path: "/v1/me", timeoutMs: 10, fetcher: async (_, init) => new Response(new ReadableStream({
    start(controller) { init.signal.addEventListener("abort", () => { cancelled = true; controller.error(new Error("cancelled")) }) },
  })) }), /timed out/)
  assert.equal(cancelled, true)
})

test("authorization uses accepted client and formats code", async () => {
  const auth = await startDeviceAuthorization({ now: () => 100, fetcher: async (url, init) => {
    assert.equal(url, `${DEFAULT_API_BASE_URL}/api/auth/device/code`)
    assert.deepEqual(JSON.parse(init.body), { client_id: "openwork-cli" })
    return json({ device_code: "device-secret", user_code: "abcd1234", verification_uri: "https://app.openworklabs.com/device", expires_in: 900, interval: 5 })
  } })
  assert.equal(auth.userCode, "ABCD-1234")
  assert.equal(auth.intervalMs, 5000)
  assert.equal(auth.expiresAt, 900100)
  assert.match(auth.verificationUriComplete, /user_code=abcd1234/)
})

test("RFC polling waits, permanently slows down and respects Retry-After", async () => {
  let time = 0
  const waits = []
  const responses = [json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400, { "retry-after": "12" }), json({ error: "slow_down" }, 429, { "retry-after": "20" }), json({ access_token: "private-token", expires_in: 60 })]
  const result = await pollDeviceToken({ authorization, now: () => time, sleep: async (ms) => { waits.push(ms); time += ms }, fetcher: async (_, init) => {
    assert.equal(JSON.parse(init.body).client_id, "openwork-cli")
    assert.equal(init.headers.authorization, undefined)
    return responses.shift()
  } })
  assert.deepEqual(waits, [1000, 1000, 12000, 20000])
  assert.equal(result.token, "private-token")
  assert.equal(result.expiresAt, new Date(time + 60000).toISOString())
})

test("denial, expiry, and unknown errors are terminal and do not leak bodies", async () => {
  for (const [code, pattern] of [["access_denied", /denied/], ["expired_token", /expired/], ["unknown-secret", /failed \(400\)/]]) {
    await assert.rejects(pollDeviceToken({ authorization, now: () => 0, sleep: async () => {}, fetcher: async () => json({ error: code, access_token: "private-token" }, 400) }), pattern)
  }
  let time = 0
  let calls = 0
  await assert.rejects(pollDeviceToken({ authorization: { ...authorization, expiresAt: 1000 }, now: () => time, sleep: async (ms) => { time += ms }, fetcher: async () => { calls++; return json({}) } }), /expired/)
  assert.equal(calls, 0)
})

test("timeout reduces polling frequency", async () => {
  let time = 0
  let calls = 0
  const waits = []
  const result = await pollDeviceToken({ authorization, now: () => time, timeoutMs: 5, sleep: async (ms) => { waits.push(ms); time += ms }, fetcher: async () => {
    calls++
    if (calls === 1) return new Promise(() => {})
    return json({ access_token: "private-token" })
  } })
  assert.equal(result.token, "private-token")
  assert.deepEqual(waits, [1000, 2000])
})

test("Retry-After handles seconds and HTTP-date without numeric junk", () => {
  assert.equal(retryAfterMs("20", 0), 20000)
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:20 GMT", 0), 20000)
  for (const value of ["-1", "1.5", "oops", null]) assert.equal(retryAfterMs(value, 0), 0)
})

test("identity pins approved org; explicit org mismatch cannot silently switch", async () => {
  const fetcher = async (url, init) => {
    if (url.endsWith("/v1/me")) { assert.equal(init.headers["x-openwork-org-id"], undefined); return json(me) }
    assert.equal(init.headers["x-openwork-org-id"], "org-test")
    return json(orgs)
  }
  const identity = await validateIdentity({ token: "private-token", orgId: "org-test", fetcher })
  assert.equal(identity.orgId, "org-test")
  await assert.rejects(validateIdentity({ token: "private-token", orgId: "other-org", fetcher }), /differs/)
  await assert.rejects(validateIdentity({ token: "private-token", fetcher: async () => json({ user: { id: "user-test" }, session: {} }) }), /approved organization/)
  await assert.rejects(validateIdentity({ token: "private-token", fetcher: async (url) => json(url.endsWith("/v1/me") ? me : { activeOrgId: "other-org", orgs: orgs.orgs }) }), /membership/)
})

test("deviceLogin exposes only user approval details to callback, without persistence", async () => {
  let time = 0
  let shown
  const result = await deviceLogin({ orgId: "org-test", now: () => time, sleep: async (ms) => { time += ms }, onAuthorization: (value) => { shown = value }, fetcher: async (url) => {
    if (url.endsWith("/code")) return json({ device_code: "device-secret", user_code: "abcd1234", verification_uri: "https://app.openworklabs.com/device", expires_in: 900 })
    if (url.endsWith("/token")) return json({ access_token: "private-token" })
    return json(url.endsWith("/v1/me") ? me : orgs)
  } })
  assert.equal(shown.deviceCode, undefined)
  assert.equal(shown.token, undefined)
  assert.equal(result.orgId, "org-test")
  assert.equal(result.token, "private-token")
})
