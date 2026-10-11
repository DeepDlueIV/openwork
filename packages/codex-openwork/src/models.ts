import {
  inventoryModels,
  modelsFor,
  providersFor,
  type GatewayInventory,
  type GatewayModelEntry,
  type GatewayProviderSummary,
} from "../../agent-gateway-core/src/index.ts"

/** Codex speaks OpenAI Responses, and the gateway does not translate other protocols. */
export const CODEX_PROTOCOL = "openai_responses"

export function compatibleModels(inventory: GatewayInventory): GatewayModelEntry[] {
  return modelsFor(inventoryModels(inventory), CODEX_PROTOCOL)
}

export function incompatibleModels(inventory: GatewayInventory): GatewayModelEntry[] {
  return inventoryModels(inventory).filter((entry) => entry.protocol !== CODEX_PROTOCOL)
}

/** The provider whose `/connect` hands out the member's gateway key. */
export function keyProvider(inventory: GatewayInventory): GatewayProviderSummary | null {
  return providersFor(inventory, CODEX_PROTOCOL)[0] ?? null
}

export function modelLabel(entry: GatewayModelEntry): string {
  const extra = [entry.name !== entry.id ? entry.name : null, entry.providerName].filter((part) => part !== null)
  return extra.length > 0 ? `${entry.id}  (${extra.join(", ")})` : entry.id
}
