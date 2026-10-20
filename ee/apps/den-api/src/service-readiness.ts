import { createHmac } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { headlessRunnerConfig } from "@openwork-ee/headless-protocol"
import { gatewayOrigin } from "@openwork-ee/utils/gateway-env"
import { headlessServiceHealthSchema, workbotServiceHealthSchema } from "@openwork/types/den/service-health"
import { serviceIdSchema, type DeploymentServiceReadiness, type DeploymentServiceStatus, type OrganizationServiceReadiness, type ServiceId, type ServiceReadinessReason, type ServiceReadinessState } from "@openwork/types/den/service-readiness"
import { z } from "zod"
import { isPrivateAddress } from "./capability-sources/url-guard.js"

export const SERVICE_READINESS_TTL_MS = 60_000
export const SERVICE_READINESS_TIMEOUT_MS = 2_000
export const SERVICE_READINESS_RATE_KEY = "service-readiness:deployment:check:v1"
export const SERVICE_READINESS_RATE_WINDOW_MS = 30_000
const MAX_BODY_BYTES = 16_384

type Environment = Readonly<Record<string, string | undefined>>
export type ReadinessFetch = (url: string, init: RequestInit) => Promise<Response>
export type ServiceProbeDependencies = {
  env: Environment
  /** Configured/derived public Den origin, never the incoming request origin. */
  denOrigin?: string
  database: (signal: AbortSignal) => Promise<unknown>
  fetch: ReadinessFetch
  timeoutMs?: number
}
type Fact = Pick<DeploymentServiceStatus, "configured" | "state" | "reason" | "missingSettings">
type ProbeFacts = { services: Map<ServiceId, Fact>; drained?: Promise<void> }
export type ServiceProbeFact = Fact
export type ServiceProbeResult = ProbeFacts
type TrackProbe = (operation: Promise<unknown>) => void

function fact(state: ServiceReadinessState, reason: ServiceReadinessReason, configured = true, missingSettings: string[] = []): Fact {
  return { state, reason, configured, missingSettings }
}
function configuration(source: Environment, names: string[]): Fact | null {
  const missing = names.filter((name) => !source[name]?.trim())
  if (missing.length === names.length) return fact("not_configured", "not_configured", false)
  return missing.length ? fact("misconfigured", "missing_configuration", false, missing) : null
}

/** Trusted operator settings only. Reuses the deployment origin validator, with a stricter HTTP boundary. */
export function readinessServiceOrigin(raw: string): string {
  const origin = gatewayOrigin(raw, "service origin", false)
  const url = new URL(origin)
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const internal = !isIP(host) && (!host.includes(".") || /\.(?:internal|local|svc|cluster\.local)$/.test(host))
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host)
  if ((url.protocol === "http:" && !internal && !loopback) || blockedMetadataAddress(host) || host === "metadata.google.internal"
    || (isIP(host) && isPrivateAddress(host) && !supportedInternalAddress(host))) {
    throw new Error("invalid_configuration")
  }
  return origin
}

function blockedMetadataAddress(address: string): boolean {
  let host = address.toLowerCase().replace(/^\[|\]$/g, "")
  try { if (isIP(host) === 6) host = new URL(`http://[${host}]`).hostname.slice(1, -1) } catch { return true }
  return /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host === "fd00:ec2::254"
    || host === "::" || host === "0.0.0.0" || /^::ffff:a9fe:/.test(host)
    || /^::ffff:0:a9fe:/.test(host) || /^64:ff9b::a9fe:/.test(host)
}

function supportedInternalAddress(address: string): boolean {
  const host = address.toLowerCase()
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number)
    return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)
  }
  // Reject transition/mapped/reserved IPv6, even for trusted service DNS. Only
  // native loopback and unique-local service networks need private access.
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host)
}

/** Build only from validated operator settings, never from a request or redirect destination. */
export function readinessServiceHosts(source: Environment): ReadonlySet<string> {
  const hosts = new Set<string>()
  const gateway = source.GATEWAY_ENABLED === "false" ? undefined : source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
  for (const raw of [gateway, source.DEN_HEADLESS_RUNNER_URL, source.DEN_WORKBOT_URL]) {
    if (!raw) continue
    try { hosts.add(new URL(readinessServiceOrigin(raw)).hostname.replace(/^\[|\]$/g, "").toLowerCase()) } catch { /* Invalid settings never grant network access. */ }
  }
  return hosts
}

type ServiceAddresses = Array<{ address: string; family: number }>
const resolveServiceAddresses = (hostname: string) => lookup(hostname, { all: true, verbatim: true })
const noPrivateServiceHosts: ReadonlySet<string> = new Set()
/** Used by the transport's DNS lookup itself (not a vulnerable resolve-then-fetch preflight).
 * Default policy is public-only. Native private/loopback networks require an
 * exact hostname explicitly derived from the operator's validated service origins.
 */
export async function readinessLookup(hostname: string, resolve: (hostname: string) => Promise<ServiceAddresses> = resolveServiceAddresses, allowedPrivateHosts: ReadonlySet<string> = noPrivateServiceHosts): Promise<ServiceAddresses> {
  const addresses = await resolve(hostname)
  const trusted = allowedPrivateHosts.has(hostname.toLowerCase())
  if (!addresses.length || addresses.some(({ address }) => blockedMetadataAddress(address)
    || (isPrivateAddress(address) && (!trusted || !supportedInternalAddress(address))))) {
    throw new Error("invalid_configuration")
  }
  return addresses
}

// Include every setting that influences a probe or configuration-derived fact.
// Never expose the fingerprint, inputs or resulting Redis key in a response/log.
const readinessConfigurationSettings = [
  "DB_MODE", "DATABASE_URL", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD",
  "GATEWAY_ENABLED", "GATEWAY_PROXY_BASE_URL", "INFERENCE_PROXY_BASE_URL", "GATEWAY_PUBLIC_BASE_URL",
  "DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN", "DEN_HEADLESS_RUNNER_CALLBACK_TOKEN", "DEN_WORKBOT_URL",
  "DEN_API_PUBLIC_URL", "EMAIL_FROM", "RESEND_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "OPENWORK_DEV_MODE",
]
/** Internal namespace only: rolling replicas with changed settings cannot reuse old Ready facts.
 * The existing deployment encryption key also prevents dictionary-testing weak
 * individual settings against a visible cache key. No new secret is required.
 */
export function readinessConfigurationFingerprint(source: Environment, denOrigin?: string): string {
  const inputs = readinessConfigurationSettings.map((name) => [name, source[name] ?? null])
  const key = source.DEN_DB_ENCRYPTION_KEY
  if (!key) throw new Error("invalid_configuration")
  return createHmac("sha256", key)
    .update(JSON.stringify({ version: 1, denOrigin: denOrigin ?? null, settings: inputs }))
    .digest("hex")
}

class ProbeFailure extends Error {
  constructor(readonly state: ServiceReadinessState, readonly reason: ServiceReadinessReason) { super(reason) }
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, track?: TrackProbe): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ProbeFailure("unreachable", "timeout"))
    }, timeoutMs)
  })
  try {
    const pending = operation(controller.signal)
    track?.(pending)
    return await Promise.race([pending, timeout])
  } finally { clearTimeout(timer) }
}
async function jsonBody(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined)
    throw new ProbeFailure("unknown", "unexpected_response")
  }
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    throw new ProbeFailure("unknown", "unexpected_response")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_BODY_BYTES) throw new ProbeFailure("unknown", "unexpected_response")
      chunks.push(chunk.value)
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      return parsed
    } catch { throw new ProbeFailure("unknown", "unexpected_response") }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
async function health<T>(deps: ServiceProbeDependencies & { track: TrackProbe }, raw: string, path: "/health" | "/ready" | "/v1/health" | "/internal/readiness", schema: z.ZodType<T>, token?: string): Promise<T> {
  let origin: string
  try { origin = readinessServiceOrigin(raw) } catch { throw new ProbeFailure("misconfigured", "invalid_configuration") }
  return bounded(async (signal) => {
    const headers: Record<string, string> = { accept: "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    if (deps.denOrigin && token) headers["X-OpenWork-Den-Origin"] = new URL(deps.denOrigin).origin
    const response = await deps.fetch(`${origin}${path}`, { method: "GET", headers, signal, redirect: "manual" })
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) throw new ProbeFailure("misconfigured", "authentication_failed")
      if (response.status === 404) throw new ProbeFailure("unknown", "incompatible_service")
      if (response.status >= 500) throw new ProbeFailure("unreachable", "request_failed")
      throw new ProbeFailure("unknown", "unexpected_response")
    }
    const result = schema.safeParse(await jsonBody(response))
    if (!result.success) throw new ProbeFailure("unknown", "incompatible_service")
    return result.data
  }, deps.timeoutMs ?? SERVICE_READINESS_TIMEOUT_MS, deps.track)
}
async function protect(probe: () => Promise<Fact>): Promise<Fact> {
  try { return await probe() } catch (error) {
    // Never serialize, log or retain upstream errors: they can contain URLs, headers and bodies.
    return error instanceof ProbeFailure ? fact(error.state, error.reason) : fact("unreachable", "request_failed")
  }
}
const gatewayHealth = z.object({ ok: z.literal(true), service: z.literal("gateway") })
const gatewayReady = z.object({ ok: z.literal(true), service: z.literal("gateway"), checks: z.object({ database: z.literal("ok") }) })

export function emailReadiness(source: Environment): Fact {
  const present = (name: string) => Boolean(source[name]?.trim())
  // Match @openwork/email: SMTP_HOST > RESEND_API_KEY > development sink.
  if (present("SMTP_HOST")) {
    const missing = ["EMAIL_FROM", ...(present("SMTP_USER") ? ["SMTP_PASS"] : []), ...(present("SMTP_PASS") ? ["SMTP_USER"] : [])].filter((name) => !present(name))
    if (missing.length) return fact("misconfigured", "missing_configuration", false, missing)
    const port = source.SMTP_PORT ?? "587"
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || (source.SMTP_SECURE !== undefined && !/^(true|false)$/i.test(source.SMTP_SECURE))) return fact("misconfigured", "invalid_configuration", false)
    return fact("unknown", "delivery_unverified")
  }
  if (present("RESEND_API_KEY")) return present("EMAIL_FROM") ? fact("unknown", "delivery_unverified") : fact("misconfigured", "missing_configuration", false, ["EMAIL_FROM"])
  if (["SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE"].some(present)) return fact("misconfigured", "missing_configuration", false, ["SMTP_HOST"])
  if (source.OPENWORK_DEV_MODE === "1") return fact("unknown", "configuration_only")
  if (present("EMAIL_FROM")) return fact("misconfigured", "missing_configuration", false, ["SMTP_HOST", "RESEND_API_KEY"])
  return fact("not_configured", "not_configured", false)
}

/** At most four concurrent read-only probes; all other statuses derive from these same facts. */
export async function probeDeploymentServices(deps: ServiceProbeDependencies): Promise<ProbeFacts> {
  const operations: Promise<unknown>[] = []
  const track: TrackProbe = (operation) => { operations.push(operation) }
  const tracked = { ...deps, track }
  const source = deps.env
  const runnerConfig = headlessRunnerConfig(source)
  let runnerHealth: z.infer<typeof headlessServiceHealthSchema> | undefined
  const database = protect(async () => {
    await bounded(deps.database, deps.timeoutMs ?? SERVICE_READINESS_TIMEOUT_MS, track)
    return fact("ready", "database_verified")
  })
  const gateway = protect(async () => {
    const raw = source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
    if (source.GATEWAY_ENABLED === "false" || (!raw && source.GATEWAY_ENABLED !== "true")) return fact("not_configured", "not_configured", false)
    if (!raw) return fact("misconfigured", "missing_configuration", false, ["GATEWAY_PROXY_BASE_URL"])
    await health(tracked, raw, "/health", gatewayHealth)
    await health(tracked, raw, "/ready", gatewayReady)
    return fact("ready", "health_verified")
  })
  const runner = protect(async () => {
    const incomplete = configuration(source, ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"])
    if (incomplete) return incomplete
    if (!runnerConfig) return fact("misconfigured", "invalid_configuration", false)
    runnerHealth = await health(tracked, runnerConfig.url, "/v1/health", headlessServiceHealthSchema, runnerConfig.token)
    if (runnerHealth.denOriginMatches === false) return fact("misconfigured", "invalid_configuration")
    // Per-member credentials may supply models; no model invocation or provider catalog lookup here.
    return fact("ready", "health_verified")
  })
  const workbot = protect(async () => {
    if (!source.DEN_WORKBOT_URL?.trim()) return fact("not_configured", "not_configured", false)
    if (!source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) return fact("misconfigured", "missing_configuration", false, ["DEN_HEADLESS_RUNNER_TOKEN"])
    if (source.DEN_HEADLESS_RUNNER_TOKEN.trim().length < 32) return fact("misconfigured", "invalid_configuration", false)
    const result = await health(tracked, source.DEN_WORKBOT_URL, "/internal/readiness", workbotServiceHealthSchema, source.DEN_HEADLESS_RUNNER_TOKEN.trim())
    if (result.denOriginMatches === false || !result.runnerConfigured) return fact("misconfigured", "invalid_configuration")
    if (result.denOriginMatches === null || !deps.denOrigin) return fact("unknown", "configuration_only")
    return fact("ready", "health_verified")
  })
  const [databaseFact, gatewayFact, runnerFact, workbotFact] = await Promise.all([database, gateway, runner, workbot])
  const services = new Map<ServiceId, Fact>([["database", databaseFact], ["gateway", gatewayFact], ["headlessRunner", runnerFact], ["workbot", workbotFact.state === "ready" && runnerFact.state !== "ready" ? fact("unknown", "dependency_unavailable") : workbotFact]])
  services.set("slack", runnerFact.state === "not_configured" ? fact("not_configured", "not_configured", false) : runnerFact.state !== "ready" ? fact("unknown", "dependency_unavailable", Boolean(runnerConfig)) : fact("unknown", "organization_setup_required"))
  let durable: Fact
  const callback = source.DEN_HEADLESS_RUNNER_CALLBACK_TOKEN?.trim()
  if (!callback && !runnerHealth?.resumeConfigured) durable = fact("not_configured", "not_configured", false)
  else if (!callback) durable = fact("misconfigured", "missing_configuration", false, ["DEN_HEADLESS_RUNNER_CALLBACK_TOKEN"])
  else if (callback.length < 32 || callback === source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) durable = fact("misconfigured", "invalid_configuration", false)
  else if (!runnerConfig) {
    const missing = ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"].filter((name) => !source[name]?.trim())
    durable = fact("misconfigured", missing.length ? "missing_configuration" : "invalid_configuration", false, missing)
  } else if (!deps.denOrigin) durable = fact("misconfigured", "missing_configuration", false, ["DEN_API_PUBLIC_URL"])
  else if (runnerFact.state !== "ready") durable = fact("unknown", "dependency_unavailable", Boolean(runnerConfig))
  else if (!runnerHealth?.resumeConfigured || runnerHealth.denOriginMatches === false) durable = fact("misconfigured", "invalid_configuration")
  else durable = fact("unknown", "callback_unverified")
  services.set("durableTurns", durable)
  services.set("email", emailReadiness(source))
  return { services, drained: Promise.allSettled(operations).then(() => undefined) }
}

function dependencies(id: ServiceId): ServiceId[] {
  if (id === "gateway") return ["database"]
  if (id === "workbot" || id === "slack") return ["headlessRunner"]
  if (id === "durableTurns") return ["database", "headlessRunner"]
  return []
}
function configurationHint(id: ServiceId, source: Environment): Fact {
  const unchecked = fact("unknown", "not_checked")
  if (id === "database") return unchecked
  if (id === "email") return emailReadiness(source)
  if (id === "gateway") {
    const raw = source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
    if (source.GATEWAY_ENABLED === "false" || (!raw && source.GATEWAY_ENABLED !== "true")) return fact("not_configured", "not_configured", false)
    if (!raw) return fact("misconfigured", "missing_configuration", false, ["GATEWAY_PROXY_BASE_URL"])
    try { readinessServiceOrigin(raw); return unchecked } catch { return fact("misconfigured", "invalid_configuration", false) }
  }
  const runner = configuration(source, ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"])
  if (id === "headlessRunner") {
    if (runner) return runner
    const config = headlessRunnerConfig(source)
    if (!config) return fact("misconfigured", "invalid_configuration", false)
    try { readinessServiceOrigin(config.url); return unchecked } catch { return fact("misconfigured", "invalid_configuration", false) }
  }
  if (id === "slack") return runner?.state === "not_configured" ? runner : runner ? fact("unknown", "dependency_unavailable", false) : unchecked
  if (id === "workbot") {
    if (!source.DEN_WORKBOT_URL?.trim()) return fact("not_configured", "not_configured", false)
    if (!source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) return fact("misconfigured", "missing_configuration", false, ["DEN_HEADLESS_RUNNER_TOKEN"])
    if (source.DEN_HEADLESS_RUNNER_TOKEN.trim().length < 32) return fact("misconfigured", "invalid_configuration", false)
    try { readinessServiceOrigin(source.DEN_WORKBOT_URL); return unchecked } catch { return fact("misconfigured", "invalid_configuration", false) }
  }
  const callback = source.DEN_HEADLESS_RUNNER_CALLBACK_TOKEN?.trim()
  if (!callback) return fact("not_configured", "not_configured", false)
  if (callback.length < 32 || callback === source.DEN_HEADLESS_RUNNER_TOKEN?.trim()) return fact("misconfigured", "invalid_configuration", false)
  return runner ? fact("misconfigured", "missing_configuration", false, runner.missingSettings.length ? runner.missingSettings : ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"]) : unchecked
}
export function initialReadiness(source?: Environment): DeploymentServiceReadiness {
  return { version: 1, checkedAt: null, checking: false, services: serviceIdSchema.options.map((id) => ({
    id, required: id === "database", ...(source ? configurationHint(id, source) : fact("unknown", "not_checked", false)), dependencies: dependencies(id), checkedAt: null, lastSuccessAt: null, stale: true,
  })) }
}
export function organizationReadiness(snapshot: DeploymentServiceReadiness): OrganizationServiceReadiness {
  return { version: 1, checkedAt: snapshot.checkedAt, checking: snapshot.checking, services: snapshot.services.map(({ required: _required, missingSettings: _missing, ...status }) => status) }
}
export type ReadinessControllerDependencies = {
  enabled: () => Promise<boolean>
  /** Durable shared admission; null admits, otherwise seconds until another check may be admitted. */
  admit: () => Promise<number | null>
  probe: () => Promise<ProbeFacts>
  now?: () => number
  initial?: DeploymentServiceReadiness
  load?: () => Promise<DeploymentServiceReadiness | null>
  save?: (snapshot: DeploymentServiceReadiness) => Promise<void>
}

/** Diagnostics are never an authorization input. Turning the flag off stops new admissions, not in-flight work. */
export function createReadinessController(deps: ReadinessControllerDependencies) {
  const now = deps.now ?? Date.now
  let current = deps.initial ?? initialReadiness()
  let admission: Promise<number | null> | null = null
  let active: Promise<void> | null = null
  let sync: Promise<void> | null = null
  let lastSync = -Infinity
  function snapshot(): DeploymentServiceReadiness {
    return { ...current, checking: admission !== null || active !== null, services: current.services.map((status) => ({ ...status, missingSettings: [...status.missingSettings], dependencies: [...status.dependencies], stale: !status.checkedAt || now() - Date.parse(status.checkedAt) >= SERVICE_READINESS_TTL_MS })) }
  }
  async function run() {
    const result = await deps.probe()
    const checkedAt = new Date(now()).toISOString()
    current = { version: 1, checkedAt, checking: false, services: current.services.map((old) => {
      const next = result.services.get(old.id) ?? fact("unknown", "not_checked", false)
      return { ...old, ...next, checkedAt, stale: false, lastSuccessAt: next.state === "ready" ? checkedAt : old.lastSuccessAt }
    }) }
    if (deps.save) await bounded(() => deps.save?.(current) ?? Promise.resolve(), 250).catch(() => undefined)
    // A timeout publishes a fresh failed fact immediately, but an uncancellable
    // database/DNS/body operation must drain before another local check starts.
    await result.drained
  }
  async function loadCache() {
    if (!deps.load) return
    const cached = await bounded(() => deps.load?.() ?? Promise.resolve(null), 250).catch(() => null)
    if (cached?.checkedAt && (!current.checkedAt || cached.checkedAt > current.checkedAt) && !active) current = cached
  }
  function completedRecently() {
    if (!current.checkedAt || current.services.length !== serviceIdSchema.options.length) return false
    const age = now() - Date.parse(current.checkedAt)
    return age >= 0 && age < SERVICE_READINESS_RATE_WINDOW_MS
      && current.services.every((status) => status.checkedAt === current.checkedAt)
  }
  function refresh(): Promise<number | null> {
    if (admission) return admission
    if (active) return Promise.resolve(null)
    admission = (async () => {
      if (!await deps.enabled()) return null
      // A GET's recent background result is also the answer to Check now. Reuse
      // it without changing timestamps, spending quota or launching more work.
      // Loading first also preserves the previous replica's last-success facts.
      await loadCache()
      if (completedRecently()) return null
      const retryAfter = await deps.admit()
      if (retryAfter !== null) {
        // Another replica may finish between our cache read and quota claim.
        await loadCache()
        return completedRecently() ? null : retryAfter
      }
      // Recheck after durable admission: a kill racing admission must not launch probes.
      if (!await deps.enabled()) return null
      active = run().catch(() => undefined).finally(() => { active = null })
      return null
    })().finally(() => { admission = null })
    return admission
  }
  function syncCache() {
    if (!deps.load || sync || now() - lastSync < 10_000) return
    lastSync = now()
    sync = loadCache().catch(() => undefined).finally(() => { sync = null })
  }
  return { snapshot, refresh, syncCache, async idle() { await admission; await active; await sync } }
}
