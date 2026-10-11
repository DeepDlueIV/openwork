/**
 * OpenWork sign-in: Den's OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The member approves a short code on Den web's /device page; polling returns
 * a Den session token (7-day sliding, no refresh token) valid on /v1.
 */
import {
  DEFAULT_API_BASE_URL,
  errorCode,
  isRecord,
  postPublic,
  readAccount,
  validateApiBaseUrl,
  type Fetch,
  type PublicResponse,
} from "./den.ts"

/** Accepted by every Den release. */
export const DEVICE_CLIENT_ID = "openwork-cli"
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
/** Used when Den does not report the session's expiry; Den sessions last 7 days and slide on use. */
export const FALLBACK_SESSION_MS = 6 * 24 * 60 * 60 * 1000
const MAX_INTERVAL_MS = 60_000

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export interface DeviceAuthorization {
  readonly clientId: string
  readonly deviceCode: string
  /** ABCD-EFGH */
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly intervalMs: number
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/** What a CLI may show the member. Never includes the device code. */
export interface DeviceAuthorizationPrompt {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly expiresAt: number
}

export type DeviceFlowErrorCode =
  | "start_failed"
  | "access_denied"
  | "expired"
  | "cancelled"
  | "poll_failed"
  | "no_organization"
  | "not_a_member"

export class DeviceFlowError extends Error {
  readonly code: DeviceFlowErrorCode
  constructor(code: DeviceFlowErrorCode, message: string) {
    super(message)
    this.name = "DeviceFlowError"
    this.code = code
  }
}

export function formatUserCode(value: string): string {
  const clean = value.replace(/[\s-]/g, "").toUpperCase()
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener("abort", onAbort, { once: true })
  })

function cancelled(): DeviceFlowError {
  return new DeviceFlowError("cancelled", "Sign-in was cancelled.")
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

export interface DeviceDeps {
  readonly fetch?: Fetch
  readonly now?: () => number
  readonly sleep?: Sleep
  readonly signal?: AbortSignal
}

export async function startDeviceAuthorization(
  input: { apiBaseUrl: string; clientId?: string } & DeviceDeps,
): Promise<DeviceAuthorization> {
  const apiBaseUrl = validateApiBaseUrl(input.apiBaseUrl)
  const now = input.now ?? Date.now
  const clientId = input.clientId ?? DEVICE_CLIENT_ID
  const started = await postPublic(apiBaseUrl, "/api/auth/device/code", { client_id: clientId }, input)
  const body = started.body
  if (started.status !== 200 || !isRecord(body) || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    const code = errorCode(body)
    throw new DeviceFlowError("start_failed", `Could not start OpenWork sign-in (${started.status}${code ? `: ${code}` : ""}).`)
  }
  const verificationUri = safeHttpUrl(body.verification_uri) ?? `${apiBaseUrl}/device`
  const verificationUriComplete = safeHttpUrl(body.verification_uri_complete)
    ?? `${verificationUri}?user_code=${encodeURIComponent(body.user_code)}`
  const interval = Number(body.interval)
  const expiresIn = Number(body.expires_in)
  return {
    clientId,
    deviceCode: body.device_code,
    userCode: formatUserCode(body.user_code),
    verificationUri,
    verificationUriComplete,
    intervalMs: Math.max(1, Number.isFinite(interval) ? interval : 5) * 1000,
    expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
  }
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000
    return Number.isFinite(milliseconds) ? milliseconds : 0
  }
  if (!/^(?:[A-Za-z]{3}, |[A-Za-z]+, \d{2}-|[A-Za-z]{3} [A-Za-z]{3} )/.test(trimmed)) return 0
  const date = Date.parse(/^[A-Za-z]{3} [A-Za-z]{3} /.test(trimmed) ? `${trimmed} GMT` : trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

/** Network failures and request timeouts: RFC 8628 §3.5 says back off and keep polling. */
function isTransient(error: unknown): boolean {
  if (error instanceof DeviceFlowError) return false
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError"
  }
  return false
}

/** Polls /api/auth/device/token until approved, denied, expired, or aborted. Returns the Den session token. */
export async function pollDeviceToken(
  input: { apiBaseUrl: string; authorization: DeviceAuthorization } & DeviceDeps,
): Promise<string> {
  const apiBaseUrl = validateApiBaseUrl(input.apiBaseUrl)
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? defaultSleep
  const { authorization, signal } = input
  let intervalMs = authorization.intervalMs
  let waitMs = intervalMs
  while (now() < authorization.expiresAt) {
    if (signal?.aborted) throw cancelled()
    await sleep(Math.min(waitMs, Math.max(0, authorization.expiresAt - now())), signal)
    if (signal?.aborted) throw cancelled()
    if (now() >= authorization.expiresAt) break
    waitMs = intervalMs
    let polled: PublicResponse
    try {
      polled = await postPublic(apiBaseUrl, "/api/auth/device/token", {
        grant_type: DEVICE_CODE_GRANT,
        device_code: authorization.deviceCode,
        client_id: authorization.clientId,
      }, { fetch: input.fetch, signal })
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      if (!isTransient(error)) throw error
      intervalMs = Math.min(intervalMs * 2, MAX_INTERVAL_MS)
      waitMs = intervalMs
      continue
    }
    if (polled.status === 200 && isRecord(polled.body) && typeof polled.body.access_token === "string" && polled.body.access_token) {
      return polled.body.access_token
    }
    const error = errorCode(polled.body)
    if (error === "access_denied") throw new DeviceFlowError("access_denied", "Sign-in was denied in the browser.")
    if (error === "expired_token") break
    if (polled.status === 429 || error === "slow_down") {
      intervalMs += 5_000
      waitMs = polled.status === 429 ? Math.max(intervalMs, retryAfterMs(polled.retryAfter, now())) : intervalMs
      continue
    }
    if (error === "authorization_pending") continue
    throw new DeviceFlowError("poll_failed", `OpenWork sign-in failed (${polled.status}${error ? `: ${error}` : ""}).`)
  }
  throw new DeviceFlowError("expired", "The sign-in code expired before it was approved. Run the sign-in again.")
}

export interface DeviceLoginResult {
  readonly apiBaseUrl: string
  readonly token: string
  readonly orgId: string
  readonly orgName: string
  readonly user: { readonly id: string; readonly email: string }
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/**
 * Full sign-in: start, show the code, poll, then validate the identity and
 * organization through /v1/me and /v1/me/orgs. With `orgId`, the member must
 * belong to that organization.
 */
export async function deviceLogin(
  input: {
    apiBaseUrl?: string
    orgId?: string
    onAuthorization: (prompt: DeviceAuthorizationPrompt) => void | Promise<void>
  } & DeviceDeps,
): Promise<DeviceLoginResult> {
  const apiBaseUrl = validateApiBaseUrl(input.apiBaseUrl ?? DEFAULT_API_BASE_URL)
  const now = input.now ?? Date.now
  const authorization = await startDeviceAuthorization({ ...input, apiBaseUrl })
  await input.onAuthorization({
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    verificationUriComplete: authorization.verificationUriComplete,
    expiresAt: authorization.expiresAt,
  })
  const token = await pollDeviceToken({ ...input, apiBaseUrl, authorization })
  const requestedOrg = input.orgId?.trim() || null
  const account = await readAccount({ apiBaseUrl, token, orgId: requestedOrg }, { fetch: input.fetch, signal: input.signal })
  if (requestedOrg && account.orgId !== requestedOrg) {
    throw new DeviceFlowError("not_a_member", "This OpenWork account is not a member of the requested organization.")
  }
  if (!account.orgId || !account.orgName) {
    throw new DeviceFlowError("no_organization", "This OpenWork account has no organization. Create or join one, then sign in again.")
  }
  return {
    apiBaseUrl,
    token,
    orgId: account.orgId,
    orgName: account.orgName,
    user: { id: account.userId, email: account.email },
    expiresAt: account.sessionExpiresAt ?? now() + FALLBACK_SESSION_MS,
  }
}
