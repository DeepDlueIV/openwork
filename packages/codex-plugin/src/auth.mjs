import { setTimeout as delay } from "node:timers/promises"

export const DEFAULT_API_BASE_URL = "https://api.openworklabs.com"
export const DEVICE_CLIENT_ID = "openwork-cli"
const MAX_BODY_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value) => typeof value === "string" && value.trim().length > 0

/** Tokens travel only over HTTPS or exact loopback HTTP; never follow redirects. */
export function normalizeApiBaseUrl(value = DEFAULT_API_BASE_URL) {
  let url
  try { url = new URL(value) } catch { throw new Error("Invalid OpenWork API URL.") }
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("OpenWork API URL must use HTTPS (or loopback HTTP), without credentials, query, or fragment.")
  }
  return url.href.replace(/\/+$/, "")
}

async function limitedJson(response) {
  const declared = Number(response.headers.get("content-length"))
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel()
    throw new Error("OpenWork response exceeded the size limit.")
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) throw new Error("OpenWork response exceeded the size limit.")
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  if (size === 0) return null
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  catch { throw new Error("OpenWork returned invalid JSON.") }
}

/** Raw status/body for device flow; never puts response bodies or tokens in errors. */
export async function requestJson({ apiBaseUrl = DEFAULT_API_BASE_URL, path, token, orgId, method = "GET", body, fetcher = fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const base = normalizeApiBaseUrl(apiBaseUrl)
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path)) throw new Error("Invalid OpenWork request path.")
  const headers = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  if (orgId) {
    headers["x-openwork-org-id"] = orgId
    headers["x-openwork-legacy-org-id"] = orgId
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  const controller = new AbortController()
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  // Race includes body consumption, not just the response headers.
  let timer
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(`${base}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: requestSignal,
        })
        if (response.status >= 300 && response.status < 400) throw new Error("OpenWork redirects are not permitted.")
        return { status: response.status, body: await limitedJson(response), retryAfter: response.headers.get("retry-after") }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("OpenWork request timed out.")) }, timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer) }
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0
  const text = value.trim()
  if (/^\d+$/.test(text)) return Number.isFinite(Number(text) * 1000) ? Number(text) * 1000 : 0
  if (!/^(?:[A-Za-z]{3}, |[A-Za-z]+, \d{2}-|[A-Za-z]{3} [A-Za-z]{3} )/.test(text)) return 0
  const time = Date.parse(/^[A-Za-z]{3} [A-Za-z]{3} /.test(text) ? `${text} GMT` : text)
  return Number.isFinite(time) ? Math.max(0, time - now) : 0
}

export async function startDeviceAuthorization(options = {}) {
  const now = options.now ?? Date.now
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl)
  const result = await requestJson({ ...options, apiBaseUrl, path: "/api/auth/device/code", method: "POST", body: { client_id: DEVICE_CLIENT_ID } })
  const body = result.body
  if (result.status !== 200 || !isRecord(body) || !nonempty(body.device_code) || !nonempty(body.user_code) || !nonempty(body.verification_uri)) {
    throw new Error(`Could not start OpenWork sign-in (${result.status}).`)
  }
  // Validate browser links too; they are shown but never automatically opened.
  const verificationUri = new URL(body.verification_uri)
  normalizeApiBaseUrl(verificationUri.origin)
  if (verificationUri.username || verificationUri.password) throw new Error("Invalid OpenWork verification URL.")
  const complete = new URL(body.verification_uri_complete ?? `${verificationUri.href}?user_code=${encodeURIComponent(body.user_code)}`)
  normalizeApiBaseUrl(complete.origin)
  if (complete.username || complete.password || complete.origin !== verificationUri.origin) throw new Error("Invalid OpenWork verification URL.")
  const interval = Number(body.interval ?? 5)
  const expiresIn = Number(body.expires_in)
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 3600) throw new Error("Invalid OpenWork sign-in expiry or polling interval.")
  const code = body.user_code.replace(/[\s-]/g, "").toUpperCase()
  return {
    apiBaseUrl, clientId: DEVICE_CLIENT_ID, deviceCode: body.device_code,
    userCode: code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code,
    verificationUri: verificationUri.href, verificationUriComplete: complete.href,
    intervalMs: Math.max(1000, interval * 1000), expiresAt: now() + expiresIn * 1000,
  }
}

/** RFC 8628: wait before every poll; slow_down adds five seconds permanently. */
export async function pollDeviceToken({ authorization, now = Date.now, sleep = delay, ...options }) {
  let intervalMs = authorization.intervalMs
  let nextWait = intervalMs
  while (now() < authorization.expiresAt) {
    options.signal?.throwIfAborted()
    await sleep(Math.min(nextWait, authorization.expiresAt - now()), undefined, { signal: options.signal })
    options.signal?.throwIfAborted()
    if (now() >= authorization.expiresAt) break
    let result
    try {
      result = await requestJson({ ...options, apiBaseUrl: authorization.apiBaseUrl, path: "/api/auth/device/token", method: "POST", body: {
        client_id: DEVICE_CLIENT_ID, device_code: authorization.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      } })
    } catch (error) {
      options.signal?.throwIfAborted()
      // Connection timeouts must reduce polling frequency (RFC 8628 section 3.5).
      if (error.message === "OpenWork request timed out.") { intervalMs *= 2; nextWait = intervalMs; continue }
      throw error
    }
    const body = result.body
    if (result.status === 200 && isRecord(body) && nonempty(body.access_token)) {
      const expiresIn = Number(body.expires_in)
      return { token: body.access_token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now() + expiresIn * 1000).toISOString() : null }
    }
    const code = isRecord(body) ? body.error : null
    if (code === "access_denied") throw new Error("OpenWork sign-in was denied in the browser.")
    if (code === "expired_token") break
    if (code === "slow_down" || result.status === 429) intervalMs += 5000
    else if (code !== "authorization_pending") throw new Error(`OpenWork sign-in failed (${result.status}).`)
    nextWait = Math.max(intervalMs, retryAfterMs(result.retryAfter, now()))
  }
  throw new Error("OpenWork sign-in code expired. Run login again.")
}

/** Pin all subsequent requests to the organization approved by device sign-in. */
export async function validateIdentity({ apiBaseUrl = DEFAULT_API_BASE_URL, token, orgId, ...options }) {
  const base = normalizeApiBaseUrl(apiBaseUrl)
  if (!nonempty(token)) throw new Error("An OpenWork login is required.")
  const me = await requestJson({ ...options, apiBaseUrl: base, token, path: "/v1/me" })
  if (me.status !== 200 || !isRecord(me.body?.user) || !nonempty(me.body.user.id) || !nonempty(me.body?.session?.activeOrganizationId)) {
    throw new Error("OpenWork identity or approved organization could not be validated. Run login again.")
  }
  const approvedOrgId = me.body.session.activeOrganizationId
  if (orgId !== undefined && orgId !== approvedOrgId) throw new Error("Selected organization differs from the organization approved at sign-in. Run login and approve the selected organization.")
  const orgs = await requestJson({ ...options, apiBaseUrl: base, token, orgId: approvedOrgId, path: "/v1/me/orgs" })
  const org = Array.isArray(orgs.body?.orgs) ? orgs.body.orgs.find((entry) => isRecord(entry) && entry.id === approvedOrgId) : null
  if (orgs.status !== 200 || orgs.body?.activeOrgId !== approvedOrgId || !org) throw new Error("OpenWork organization membership could not be validated.")
  return {
    apiBaseUrl: base, orgId: approvedOrgId,
    user: { id: me.body.user.id, email: typeof me.body.user.email === "string" ? me.body.user.email : null },
    organization: { id: approvedOrgId, name: typeof org.name === "string" ? org.name : null },
    expiresAt: typeof me.body.session.expiresAt === "string" ? me.body.session.expiresAt : null,
  }
}

/** No persistence, browser launch, token logging, or remote-control enrollment. */
export async function deviceLogin({ apiBaseUrl = DEFAULT_API_BASE_URL, orgId, onAuthorization, ...options } = {}) {
  const authorization = await startDeviceAuthorization({ ...options, apiBaseUrl })
  // The callback intentionally does not receive the secret device_code.
  await onAuthorization?.({ userCode: authorization.userCode, verificationUri: authorization.verificationUri, verificationUriComplete: authorization.verificationUriComplete, expiresAt: authorization.expiresAt })
  const granted = await pollDeviceToken({ ...options, authorization })
  const identity = await validateIdentity({ ...options, apiBaseUrl, token: granted.token, orgId })
  return { ...identity, token: granted.token, expiresAt: identity.expiresAt ?? granted.expiresAt }
}
