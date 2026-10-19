import { WORKBOT_DEFAULT_MODEL_ID, workbotLunaAlias } from "@openwork/types/den/workbot-settings"
import type { HeadlessModelCatalog } from "../headless-runner/client.js"

/** Keep an explicit identity even when unavailable: new turns must not fall through to an unrelated runner default. */
export function explicitWorkbotModel(chosen: string | null, catalog: HeadlessModelCatalog | null): string {
  return chosen ?? (catalog ? workbotLunaAlias(catalog) : null) ?? WORKBOT_DEFAULT_MODEL_ID
}

export function workbotDefaultReadiness(catalog: HeadlessModelCatalog | null): "available" | "unavailable" | "unverified" {
  if (!catalog || catalog.verified !== true) return "unverified"
  return workbotLunaAlias(catalog) ? "available" : "unavailable"
}
