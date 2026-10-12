/**
 * Model catalog for the profile (`model_catalog_json`). Codex has no metadata
 * for `gwm_*` ids and falls back to generic defaults (wrong context window,
 * different tools). Codex caches full metadata for OpenAI's models in
 * `$CODEX_HOME/models_cache.json`; each gateway model whose upstream model is
 * in that cache gets a copy of its entry under the `gwm_*` id.
 */
import { join } from "node:path"
import { isRecord, readString, readTextFile, type GatewayModelEntry } from "../../agent-gateway-core/src/index.ts"

type JsonObject = Record<string, unknown>

const MAX_CACHE_BYTES = 16 * 1024 * 1024

export function catalogFileName(profileName: string): string {
  return `models-${profileName}.json`
}

export function catalogPath(stateDir: string, profileName: string): string {
  return join(stateDir, catalogFileName(profileName))
}

/** Codex's cached OpenAI model entries, or [] when there is no readable cache. */
export async function readCodexModelCache(codexHome: string): Promise<JsonObject[]> {
  try {
    const text = await readTextFile(join(codexHome, "models_cache.json"), MAX_CACHE_BYTES)
    if (text === null) return []
    const parsed: unknown = JSON.parse(text)
    const models = isRecord(parsed) ? parsed.models : null
    return Array.isArray(models) ? models.filter(isRecord) : []
  } catch {
    return []
  }
}

/** One gateway model's catalog entry, derived from the cached upstream entry. */
function toEntry(template: JsonObject, model: GatewayModelEntry, priority: number): JsonObject {
  const programs = isRecord(template.available_access_programs) ? template.available_access_programs : {}
  return {
    ...template,
    slug: model.id,
    display_name: model.name,
    priority,
    upgrade: null,
    availability_nux: null,
    // Speed tiers and access programs are ChatGPT account features the gateway does not offer.
    additional_speed_tiers: [],
    service_tiers: [],
    available_access_programs: Object.fromEntries(Object.keys(programs).map((key) => [key, []])),
    // The "lite" request format moves tools into input items; keep the
    // standard Responses shape the gateway is known to accept.
    use_responses_lite: false,
  }
}

export interface Catalog {
  readonly models: readonly JsonObject[]
  /** The cached `default_reasoning_level` per gwm id. */
  readonly defaultEffort: ReadonlyMap<string, string>
}

export function buildCatalog(models: readonly GatewayModelEntry[], cache: readonly JsonObject[]): Catalog {
  const entries: JsonObject[] = []
  const defaultEffort = new Map<string, string>()
  for (const model of models) {
    const upstream = model.upstreamModelId?.toLowerCase()
    if (!upstream) continue
    const template = cache.find((entry) => readString(entry.slug)?.toLowerCase() === upstream)
    if (!template) continue
    entries.push(toEntry(template, model, entries.length))
    const effort = readString(template.default_reasoning_level)
    if (effort) defaultEffort.set(model.id, effort)
  }
  return { models: entries, defaultEffort }
}

export function renderCatalog(catalog: Catalog): string {
  return `${JSON.stringify({ models: catalog.models }, null, 2)}\n`
}
