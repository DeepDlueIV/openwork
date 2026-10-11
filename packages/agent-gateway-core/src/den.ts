/**
 * Den (OpenWork Cloud API) calls shared by the agent CLIs. Every authenticated
 * call sends the member's Den session token as a bearer plus the org headers
 * the desktop sends, so Den resolves the organization the member chose.
 *
 * Error messages never contain tokens, keys, or response bodies.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const DEFAULT_API_BASE_URL = "https://api.openworklabs.com"
export const REQUEST_TIMEOUT_MS = 10_000

export interface DenSession {
  readonly apiBaseUrl: string
  readonly token: string
  readonly orgId: string | null
}

export interface RequestOptions {
  readonly fetch?: Fetch
  readonly signal?: AbortSignal
}

export class DenAuthError extends Error {
  readonly status: number
  readonly path: string
  constructor(status: number, path: string) {
    super(`OpenWork rejected the sign-in (${status} on ${path}). Sign in again.`)
    this.name = "DenAuthError"
    this.status = status
    this.path = path
  }
}

export class DenRequestError extends Error {
  readonly status: number
  readonly path: string
  /** The `error` code from the response body, when Den sent one. Never the body itself. */
  readonly code: string | null
  constructor(status: number, path: string, code: string | null = null) {
    super(`OpenWork request failed (${status} on ${path}${code ? `: ${code}` : ""}).`)
    this.name = "DenRequestError"
    this.status = status
    this.path = path
    this.code = code
  }
}

export class DenUrlError extends Error {
  constructor(value: string) {
    super(`Refusing to send OpenWork credentials to ${describeUrl(value)}: use an https:// address.`)
    this.name = "DenUrlError"
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** Trims whitespace and trailing slashes without a backtracking pattern. */
export function normalizeBaseUrl(value: string): string {
  let end = value.length
  while (end > 0 && /\s/.test(value[end - 1] ?? "")) end--
  while (end > 0 && value[end - 1] === "/") end--
  return value.slice(0, end).trim()
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Never echo credentials embedded in a URL, or arbitrary text, back to the terminal. */
function describeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return "an invalid address"
  }
}

/**
 * Where tokens may be sent: HTTPS, or plain HTTP only to this machine (local
 * development and self-hosted testing). No embedded credentials, query, or hash.
 */
export function isAllowedApiBaseUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password || url.search || url.hash) return false
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
}

/** Normalizes and validates a base URL; throws DenUrlError when tokens must not go there. */
export function validateApiBaseUrl(value: string): string {
  const normalized = normalizeBaseUrl(value)
  if (!isAllowedApiBaseUrl(normalized)) throw new DenUrlError(normalized)
  return normalized
}

export function timeoutSignal(signal?: AbortSignal, ms: number = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function errorCode(body: unknown): string | null {
  return isRecord(body) && typeof body.error === "string" && /^[a-z0-9_.-]{1,64}$/i.test(body.error) ? body.error : null
}

export interface PublicResponse {
  readonly status: number
  readonly body: unknown
  readonly retryAfter: string | null
}

/** Unauthenticated JSON POST (device authorization endpoints). */
export async function postPublic(
  apiBaseUrl: string,
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<PublicResponse> {
  // The device token arrives in this response, so the same transport rule applies.
  const base = validateApiBaseUrl(apiBaseUrl)
  const fetcher = options.fetch ?? globalThis.fetch
  const response = await fetcher(`${base}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: timeoutSignal(options.signal),
  })
  return { status: response.status, body: await readResponseJson(response), retryAfter: response.headers.get("retry-after") }
}

export interface DenRequestInit extends RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE"
  readonly body?: unknown
}

/** Authenticated JSON request. 401 becomes DenAuthError; other non-2xx become DenRequestError. */
export async function denRequest(session: DenSession, path: string, init: DenRequestInit = {}): Promise<unknown> {
  const base = validateApiBaseUrl(session.apiBaseUrl)
  const fetcher = init.fetch ?? globalThis.fetch
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${session.token}`,
  }
  if (session.orgId) {
    headers["x-openwork-org-id"] = session.orgId
    headers["x-openwork-legacy-org-id"] = session.orgId
  }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetcher(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "error",
    signal: timeoutSignal(init.signal),
  })
  const body = await readResponseJson(response)
  if (response.status === 401) throw new DenAuthError(response.status, path)
  if (!response.ok) throw new DenRequestError(response.status, path, errorCode(body))
  return body
}

function readTime(value: unknown): number | null {
  const text = readString(value)
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : null
}

export interface DenMe {
  readonly userId: string
  readonly email: string
  /** Milliseconds since the epoch; Den slides it forward on use. */
  readonly sessionExpiresAt: number | null
  readonly activeOrganizationId: string | null
}

/** GET /v1/me: the user and the session. Any authenticated call also revalidates the session. */
export async function readMe(session: DenSession, options: RequestOptions = {}): Promise<DenMe> {
  const body = await denRequest(session, "/v1/me", options)
  if (!isRecord(body) || !isRecord(body.user)) throw new DenRequestError(200, "/v1/me", "invalid_response")
  const sessionInfo = isRecord(body.session) ? body.session : {}
  const userId = readString(body.user.id)
  if (!userId) throw new DenRequestError(200, "/v1/me", "invalid_response")
  return {
    userId,
    email: readString(body.user.email) ?? "",
    sessionExpiresAt: readTime(sessionInfo.expiresAt),
    activeOrganizationId: readString(sessionInfo.activeOrganizationId),
  }
}

export interface DenOrg {
  readonly id: string
  readonly name: string
  readonly slug: string | null
  readonly isActive: boolean
}

export interface DenAccount {
  readonly userId: string
  readonly email: string
  readonly sessionExpiresAt: number | null
  /** The organization the session resolves to, or null when the member has none. */
  readonly orgId: string | null
  readonly orgName: string | null
  readonly orgSlug: string | null
  readonly orgs: readonly DenOrg[]
}

function parseOrg(value: unknown): DenOrg | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  if (!id) return null
  const slug = readString(value.slug)
  return { id, name: readString(value.name) ?? slug ?? id, slug, isActive: value.isActive === true }
}

/** GET /v1/me/orgs. */
export async function readOrgs(
  session: DenSession,
  options: RequestOptions = {},
): Promise<{ orgs: DenOrg[]; activeOrgId: string | null }> {
  const body = await denRequest(session, "/v1/me/orgs", options)
  const orgs: DenOrg[] = []
  if (isRecord(body) && Array.isArray(body.orgs)) {
    for (const entry of body.orgs) {
      const org = parseOrg(entry)
      if (org) orgs.push(org)
    }
  }
  return { orgs, activeOrgId: isRecord(body) ? readString(body.activeOrgId) : null }
}

/**
 * The member's account, with the organization the session is scoped to:
 * `session.orgId` when set, else the session's active organization.
 */
export async function readAccount(session: DenSession, options: RequestOptions = {}): Promise<DenAccount> {
  const me = await readMe(session, options)
  const requested = session.orgId ?? me.activeOrganizationId
  const { orgs, activeOrgId } = await readOrgs({ ...session, orgId: requested }, options)
  const wanted = session.orgId ?? activeOrgId ?? requested
  const org = orgs.find((entry) => entry.id === wanted)
    ?? (session.orgId ? undefined : orgs.find((entry) => entry.isActive))
    ?? null
  return {
    userId: me.userId,
    email: me.email,
    sessionExpiresAt: me.sessionExpiresAt,
    orgId: org?.id ?? null,
    orgName: org?.name ?? null,
    orgSlug: org?.slug ?? null,
    orgs,
  }
}

/** POST /api/auth/sign-out: ends the Den session. Best effort; never throws. */
export async function signOut(session: Pick<DenSession, "apiBaseUrl" | "token">, options: RequestOptions = {}): Promise<boolean> {
  if (!isAllowedApiBaseUrl(normalizeBaseUrl(session.apiBaseUrl))) return false
  const fetcher = options.fetch ?? globalThis.fetch
  try {
    const response = await fetcher(`${normalizeBaseUrl(session.apiBaseUrl)}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: timeoutSignal(options.signal),
    })
    return response.ok
  } catch {
    return false
  }
}
