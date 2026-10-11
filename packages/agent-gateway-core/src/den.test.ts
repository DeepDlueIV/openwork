import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DenAuthError,
  DenRequestError,
  DenUrlError,
  denRequest,
  isAllowedApiBaseUrl,
  normalizeBaseUrl,
  readAccount,
  signOut,
  validateApiBaseUrl,
} from "./den.ts"
import { fakeFetch, json } from "./test-fetch.ts"

const SECRET = "den_session_secret_value"
const session = { apiBaseUrl: "https://den.example.com/", token: SECRET, orgId: "org_1" }

test("tokens only travel over HTTPS, or plain HTTP to this machine", () => {
  assert.equal(isAllowedApiBaseUrl("https://api.openworklabs.com"), true)
  assert.equal(isAllowedApiBaseUrl("http://127.0.0.1:8790"), true)
  assert.equal(isAllowedApiBaseUrl("http://localhost:8790"), true)
  assert.equal(isAllowedApiBaseUrl("http://[::1]:8790"), true)
  assert.equal(isAllowedApiBaseUrl("http://den.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("http://127.0.0.1.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("https://user:pass@den.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("https://den.example.com/?x=1"), false)
  assert.equal(isAllowedApiBaseUrl("ftp://den.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("not a url"), false)
  assert.equal(validateApiBaseUrl(" https://den.example.com/// "), "https://den.example.com")
  assert.equal(normalizeBaseUrl("/".repeat(100_000)), "")
})

test("URL errors never echo embedded credentials", () => {
  assert.throws(() => validateApiBaseUrl("http://user:hunter2@den.example.com"), (error: unknown) => {
    assert.ok(error instanceof DenUrlError)
    assert.doesNotMatch(error.message, /hunter2/)
    return true
  })
})

test("sends bearer and org headers, refuses redirects, and refuses plain HTTP before any request", async () => {
  const { fetch, calls } = fakeFetch({ "GET /v1/me": () => json(200, { user: { id: "u1" } }) })
  await denRequest(session, "/v1/me", { fetch })
  assert.equal(calls[0]?.url, "https://den.example.com/v1/me")
  assert.equal(calls[0]?.headers.authorization, `Bearer ${SECRET}`)
  assert.equal(calls[0]?.headers["x-openwork-org-id"], "org_1")
  assert.equal(calls[0]?.headers["x-openwork-legacy-org-id"], "org_1")
  assert.equal(calls[0]?.redirect, "error")
  await assert.rejects(denRequest({ ...session, apiBaseUrl: "http://den.example.com" }, "/v1/me", { fetch }), DenUrlError)
  assert.equal(calls.length, 1)
})

test("errors carry status and code but never the token or the response body", async () => {
  const { fetch } = fakeFetch({
    "GET /v1/me": () => json(401, { error: "unauthorized", echo: SECRET }),
    "GET /v1/fail": () => json(500, { error: "boom", detail: `leak ${SECRET} ow_gw_secret` }),
    "GET /v1/junk": () => json(400, { error: `weird ${SECRET}` }),
  })
  await assert.rejects(denRequest(session, "/v1/me", { fetch }), (error: unknown) => {
    assert.ok(error instanceof DenAuthError)
    assert.equal(error.status, 401)
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(SECRET))
    return true
  })
  await assert.rejects(denRequest(session, "/v1/fail", { fetch }), (error: unknown) => {
    assert.ok(error instanceof DenRequestError)
    assert.equal(error.status, 500)
    assert.equal(error.code, "boom")
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)} ${String(error.stack)}`, /den_session_secret_value|ow_gw_/)
    return true
  })
  await assert.rejects(denRequest(session, "/v1/junk", { fetch }), (error: unknown) => {
    assert.ok(error instanceof DenRequestError)
    assert.equal(error.code, null)
    assert.doesNotMatch(error.message, new RegExp(SECRET))
    return true
  })
})

test("readAccount resolves the requested org and the session expiry", async () => {
  const { fetch, calls } = fakeFetch({
    "GET /v1/me": () => json(200, {
      user: { id: "u1", email: "a@example.com" },
      session: { expiresAt: "2026-10-18T00:00:00.000Z", activeOrganizationId: "org_2" },
    }),
    "GET /v1/me/orgs": () => json(200, {
      orgs: [{ id: "org_1", name: "One", slug: "one", isActive: false }, { id: "org_2", name: "Two", slug: "two", isActive: true }],
      activeOrgId: "org_2",
    }),
  })
  const pinned = await readAccount(session, { fetch })
  assert.equal(pinned.orgId, "org_1")
  assert.equal(pinned.orgName, "One")
  assert.equal(pinned.sessionExpiresAt, Date.parse("2026-10-18T00:00:00.000Z"))
  assert.equal(calls[1]?.headers["x-openwork-org-id"], "org_1")
  const active = await readAccount({ ...session, orgId: null }, { fetch })
  assert.equal(active.orgId, "org_2")
  const missing = await readAccount({ ...session, orgId: "org_9" }, { fetch })
  assert.equal(missing.orgId, null)
})

test("signOut is best effort and never throws", async () => {
  const { fetch, calls } = fakeFetch({ "POST /api/auth/sign-out": () => json(200, {}) })
  assert.equal(await signOut(session, { fetch }), true)
  assert.equal(calls[0]?.headers.authorization, `Bearer ${SECRET}`)
  assert.equal(await signOut({ apiBaseUrl: "http://den.example.com", token: SECRET }, { fetch }), false)
  const failing = async (): Promise<Response> => {
    throw new TypeError("fetch failed")
  }
  assert.equal(await signOut(session, { fetch: failing }), false)
})
