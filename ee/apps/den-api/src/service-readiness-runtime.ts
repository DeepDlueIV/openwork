import { sql } from "@openwork-ee/den-db/drizzle"
import { Agent, fetch as undiciFetch } from "undici"
import { db } from "./db.js"
import { cache } from "./cache.js"
import { env } from "./env.js"
import { deploymentFeatureEnabled } from "./features.js"
import { checkRateLimit } from "./utils/rate-limit.js"
import { createReadinessController, initialReadiness, organizationReadiness, probeDeploymentServices, readinessConfigurationFingerprint, readinessLookup, readinessServiceHosts, SERVICE_READINESS_RATE_KEY, SERVICE_READINESS_RATE_WINDOW_MS, SERVICE_READINESS_TIMEOUT_MS, type ReadinessFetch } from "./service-readiness.js"

// Operator environment is fixed for this replica's lifetime. Use the same
// configuration for DNS policy, probes, initial facts and the private cache key.
const readinessEnvironment = { ...process.env }
const allowedPrivateHosts = readinessServiceHosts(readinessEnvironment)
const configurationFingerprint = readinessConfigurationFingerprint(readinessEnvironment, env.apiPublicUrl)

const agent = new Agent({
  connect: {
    timeout: SERVICE_READINESS_TIMEOUT_MS,
    lookup(hostname, options, callback) {
      void readinessLookup(hostname, undefined, allowedPrivateHosts).then((addresses) => {
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      }, () => callback(new Error("request_failed"), []))
    },
  },
  headersTimeout: SERVICE_READINESS_TIMEOUT_MS,
  bodyTimeout: SERVICE_READINESS_TIMEOUT_MS,
  connections: 4,
})

const serviceFetch: ReadinessFetch = async (url, init) => {
  const requestHeaders: Record<string, string> = {}
  new Headers(init.headers).forEach((value, name) => { requestHeaders[name] = value })
  const response = await undiciFetch(url, {
    method: "GET", headers: requestHeaders, signal: init.signal, redirect: "manual", dispatcher: agent,
  })
  // Match Hono's current Response realm without eagerly consuming untrusted bodies.
  let body: ReadableStream<Uint8Array> | null = null
  if (response.body) {
    const reader = response.body.getReader()
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read()
        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      },
      cancel(reason: unknown) { return reader.cancel(reason) },
    })
  }
  const headers = new Headers()
  response.headers.forEach((value, name) => headers.append(name, value))
  return new Response(body, { status: response.status, headers })
}

// Drizzle/PlanetScale cannot cancel a query. Keep the one underlying SELECT shared
// even after a diagnostic timeout so a broken database never accumulates probes.
let databaseQuery: Promise<unknown> | null = null
function database() {
  databaseQuery ??= Promise.resolve(db.execute(sql`select 1`)).finally(() => { databaseQuery = null })
  return databaseQuery
}

export const serviceReadiness = createReadinessController({
  initial: initialReadiness(readinessEnvironment),
  enabled: () => deploymentFeatureEnabled("serviceReadiness"),
  admit: () => checkRateLimit(SERVICE_READINESS_RATE_KEY, 1, SERVICE_READINESS_RATE_WINDOW_MS, Date.now()),
  probe: () => probeDeploymentServices({ env: readinessEnvironment, denOrigin: env.apiPublicUrl, database, fetch: serviceFetch }),
  load: () => cache.serviceReadiness.load(configurationFingerprint),
  save: (snapshot) => cache.serviceReadiness.save(configurationFingerprint, snapshot),
})

/** No probe, no outbound HTTP, and no member/provider credentials inspected. */
export async function cachedOrganizationServiceReadiness(organizationEnabled: boolean) {
  if (!organizationEnabled) return undefined
  try {
    if (!await deploymentFeatureEnabled("serviceReadiness")) return undefined
    serviceReadiness.syncCache()
    return organizationReadiness(serviceReadiness.snapshot())
  } catch {
    // This advisory projection must not introduce a new failure into /v1/org.
    // Authentication and the organization feature guard still fail closed.
    return undefined
  }
}
