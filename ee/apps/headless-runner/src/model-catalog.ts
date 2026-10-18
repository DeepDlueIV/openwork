import type { Config } from "./config.js"
import { fetchGatewayModels, type ModelOption } from "./model.js"

/** A catalog is verified only by an authenticated gateway read, never by the configured default alone. */
export function gatewayModelCatalog(config: Config, readModels = fetchGatewayModels) {
  let cached: { at: number; models: ModelOption[] } | null = null
  return async () => {
    const fallback = { defaultModel: config.model.model, models: [{ id: config.model.model, name: config.model.model }], verified: false }
    if (!config.model.defaultApiKey) return fallback
    if (!cached || Date.now() - cached.at > 5 * 60_000) {
      try {
        cached = {
          at: Date.now(),
          models: await readModels({ baseUrl: config.model.baseUrl, protocol: config.model.protocol, apiKey: config.model.defaultApiKey }),
        }
      } catch {
        return fallback
      }
    }
    if (cached.models.length === 0) return fallback
    return { defaultModel: config.model.model, models: cached.models, verified: true }
  }
}
