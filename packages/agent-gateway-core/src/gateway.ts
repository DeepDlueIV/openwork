/**
 * OpenWork AI Gateway inventory for agent CLIs.
 *
 * Den lists the gateway providers (`ipr_*`) the member can use and hands out
 * the member's `ow_gw_` key. The gateway itself serves each provider's native
 * protocol and does not translate between them, so every model is classified:
 * Claude Code needs Anthropic Messages, Codex needs OpenAI Responses.
 */
import {
  DenRequestError,
  denRequest,
  errorCode,
  isAllowedApiBaseUrl,
  isRecord,
  normalizeBaseUrl,
  readResponseJson,
  readString,
  timeoutSignal,
  validateApiBaseUrl,
  type DenSession,
  type RequestOptions,
} from "./den.ts"

export type GatewayProtocol = "anthropic_messages" | "openai_responses" | "other"

export interface GatewayModelSummary {
  readonly id: string
  readonly name: string
  readonly upstreamModelId: string | null
}

export interface GatewayProviderSummary {
  /** `ipr_*` */
  readonly id: string
  readonly name: string
  /** Den's provider family, e.g. "anthropic" or "openai". */
  readonly family: string | null
  readonly protocol: GatewayProtocol
  readonly models: readonly GatewayModelSummary[]
}

export interface GatewayInventory {
  /** Public gateway origin (+ path prefix), or null when Den has no gateway providers. */
  readonly gatewayBaseUrl: string | null
  readonly providers: readonly GatewayProviderSummary[]
}

/** One model as a CLI shows it, from either Den's inventory or the gateway's model list. */
export interface GatewayModelEntry {
  /** `gwm_*`: what the CLI sends as the model name. */
  readonly id: string
  readonly name: string
  readonly protocol: GatewayProtocol
  /** `ipr_*`, or null when the gateway did not say. */
  readonly providerId: string | null
  readonly providerName: string | null
  readonly family: string | null
  readonly upstreamModelId: string | null
}

export class GatewayError extends Error {
  readonly status: number | null
  readonly code: string | null
  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message)
    this.name = "GatewayError"
    this.status = status
    this.code = code
  }
}

const ANTHROPIC_FAMILIES = new Set(["anthropic", "google_vertex_anthropic", "microsoft_foundry"])
const OPENAI_FAMILIES = new Set(["openai", "azure", "openai_compatible", "bedrock_mantle"])
const ANTHROPIC_PACKAGES = new Set(["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"])
const OPENAI_PACKAGES = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/azure"])

/** Classifies by Den's `providerConfig.npm` (the preferred signal). */
export function protocolFromNpm(npm: string | null | undefined): GatewayProtocol {
  if (!npm) return "other"
  if (ANTHROPIC_PACKAGES.has(npm)) return "anthropic_messages"
  if (OPENAI_PACKAGES.has(npm)) return "openai_responses"
  return "other"
}

/** Classifies by provider family (Den `providerId` or the gateway's `owned_by`). */
export function protocolFromFamily(family: string | null | undefined): GatewayProtocol {
  if (!family) return "other"
  const key = family.trim().toLowerCase().replace(/-/g, "_")
  if (ANTHROPIC_FAMILIES.has(key)) return "anthropic_messages"
  if (OPENAI_FAMILIES.has(key)) return "openai_responses"
  return "other"
}

export function classifyProtocol(input: { npm?: string | null; family?: string | null }): GatewayProtocol {
  const byNpm = protocolFromNpm(input.npm)
  return byNpm === "other" ? protocolFromFamily(input.family) : byNpm
}

/**
 * `providerConfig.api` looks like `<gatewayBase>/api/v1/providers/<ipr>`;
 * returns `<gatewayBase>`, or null when it does not, or is not a safe URL.
 */
export function gatewayBaseFromProviderApi(api: string | null | undefined, providerId: string): string | null {
  if (!api) return null
  const normalized = normalizeBaseUrl(api)
  const suffix = `/api/v1/providers/${providerId}`
  if (!normalized.endsWith(suffix)) return null
  const base = normalizeBaseUrl(normalized.slice(0, -suffix.length))
  return base && isAllowedApiBaseUrl(base) ? base : null
}

function parseModels(value: unknown): GatewayModelSummary[] {
  if (!Array.isArray(value)) return []
  const models: GatewayModelSummary[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = readString(entry.id)
    if (!id || !id.startsWith("gwm_")) continue
    models.push({ id, name: readString(entry.name) ?? id, upstreamModelId: readString(entry.upstreamModelId) })
  }
  return models.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * GET /v1/inference-providers?scope=usable, classified per protocol. Providers
 * with no accessible models are left out. Deployments without the AI Gateway
 * (404/405/501) yield an empty inventory.
 */
export async function fetchGatewayInventory(session: DenSession, options: RequestOptions = {}): Promise<GatewayInventory> {
  let listed: unknown
  try {
    listed = await denRequest(session, "/v1/inference-providers?scope=usable", options)
  } catch (error) {
    if (error instanceof DenRequestError && [404, 405, 501].includes(error.status)) {
      return { gatewayBaseUrl: null, providers: [] }
    }
    throw error
  }
  const rows = isRecord(listed) && Array.isArray(listed.inferenceProviders) ? listed.inferenceProviders : []
  const providers: GatewayProviderSummary[] = []
  let gatewayBaseUrl: string | null = null
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = readString(row.id)
    const name = readString(row.name)
    if (!id || !id.startsWith("ipr_") || !name) continue
    const models = parseModels(row.models)
    if (models.length === 0) continue
    const config = isRecord(row.providerConfig) ? row.providerConfig : {}
    const providerOptions = isRecord(config.options) ? config.options : {}
    const family = readString(row.providerId)
    gatewayBaseUrl ??= gatewayBaseFromProviderApi(readString(config.api), id)
      ?? gatewayBaseFromProviderApi(readString(providerOptions.baseURL), id)
    providers.push({ id, name, family, protocol: classifyProtocol({ npm: readString(config.npm), family }), models })
  }
  providers.sort((left, right) => left.id.localeCompare(right.id))
  return { gatewayBaseUrl, providers }
}

/** GET /v1/inference-providers/:ipr/connect → the member's `ow_gw_` key (one per member per org, no expiry). */
export async function fetchGatewayKey(session: DenSession, providerId: string, options: RequestOptions = {}): Promise<string> {
  if (!/^ipr_[A-Za-z0-9_-]+$/.test(providerId)) throw new GatewayError("Invalid AI Gateway provider id.")
  const body = await denRequest(session, `/v1/inference-providers/${encodeURIComponent(providerId)}/connect`, options)
  const detail = isRecord(body) ? body.inferenceProvider : null
  const key = isRecord(detail) ? readString(detail.apiKey) : null
  if (!key || !key.startsWith("ow_gw_")) {
    throw new GatewayError("OpenWork did not return an AI Gateway key for this provider. Ask an admin to check its credentials.")
  }
  return key
}

/**
 * GET <gatewayBase>/api/v1/models with the member's key. When Den's inventory
 * is given, protocol comes from the matching provider (joined by `ipr_*`),
 * falling back to the gateway's `owned_by` family.
 */
export async function listGatewayModels(
  gatewayBaseUrl: string,
  key: string,
  options: RequestOptions & { inventory?: GatewayInventory } = {},
): Promise<GatewayModelEntry[]> {
  const base = validateApiBaseUrl(gatewayBaseUrl)
  const fetcher = options.fetch ?? globalThis.fetch
  const response = await fetcher(`${base}/api/v1/models`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
    redirect: "error",
    signal: timeoutSignal(options.signal),
  })
  const body = await readResponseJson(response)
  if (response.status === 401 || response.status === 403) {
    throw new GatewayError(`The AI Gateway rejected the key (${response.status}). Sign in again.`, response.status, errorCode(body))
  }
  if (!response.ok) {
    throw new GatewayError(`AI Gateway request failed (${response.status}).`, response.status, errorCode(body))
  }
  const byProvider = new Map((options.inventory?.providers ?? []).map((provider) => [provider.id, provider]))
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : []
  const entries: GatewayModelEntry[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = readString(row.id)
    if (!id) continue
    const meta = isRecord(row.openwork) ? row.openwork : {}
    const providerId = readString(meta.provider_id)
    const family = readString(row.owned_by)
    const provider = providerId ? byProvider.get(providerId) : undefined
    const joined = provider && provider.protocol !== "other" ? provider.protocol : null
    entries.push({
      id,
      name: readString(row.name) ?? id,
      protocol: joined ?? protocolFromFamily(family ?? provider?.family),
      providerId,
      providerName: readString(meta.provider_name) ?? provider?.name ?? null,
      family: family ?? provider?.family ?? null,
      upstreamModelId: readString(meta.upstream_model_id),
    })
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id))
}

/** Flattens Den's inventory into model entries. */
export function inventoryModels(inventory: GatewayInventory): GatewayModelEntry[] {
  return inventory.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      protocol: provider.protocol,
      providerId: provider.id,
      providerName: provider.name,
      family: provider.family,
      upstreamModelId: model.upstreamModelId,
    })),
  )
}

/** Models a client speaking `protocol` can use. */
export function modelsFor<T extends { readonly protocol: GatewayProtocol }>(entries: readonly T[], protocol: GatewayProtocol): T[] {
  return entries.filter((entry) => entry.protocol === protocol)
}

/** Providers a client speaking `protocol` can use. */
export function providersFor(inventory: GatewayInventory, protocol: GatewayProtocol): GatewayProviderSummary[] {
  return modelsFor(inventory.providers, protocol)
}
