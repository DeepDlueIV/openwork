/** Choosing the AI Gateway provider and models Claude Code will use. */
import {
  pick,
  providersFor,
  type GatewayInventory,
  type GatewayModelSummary,
  type GatewayProviderSummary,
  type PromptStreams,
} from "../../agent-gateway-core/src/index.ts"

export class SelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SelectionError"
  }
}

/** Providers Claude Code can talk to: the gateway serves them over Anthropic Messages. */
export function claudeProviders(inventory: GatewayInventory): GatewayProviderSummary[] {
  return providersFor(inventory, "anthropic_messages")
}

export async function chooseProvider(
  providers: readonly GatewayProviderSummary[],
  requested: string | undefined,
  streams: PromptStreams,
): Promise<GatewayProviderSummary> {
  if (providers.length === 0) {
    throw new SelectionError(
      "Your organization has no AI Gateway models Claude Code can use (it needs an Anthropic Messages provider). Ask an admin to add one, then run setup again.",
    )
  }
  if (requested) {
    const match = providers.find((provider) => provider.id === requested)
    if (!match) {
      throw new SelectionError(
        `Provider ${requested} is not available for Claude Code. Available: ${providers.map((provider) => provider.id).join(", ")}.`,
      )
    }
    return match
  }
  return pick(
    "Which AI Gateway provider should Claude Code use?",
    providers.map((provider) => ({ label: `${provider.name} (${provider.id}, ${provider.models.length} models)`, value: provider })),
    { ...streams, hint: "pass --provider ipr_…" },
  )
}

export function findModel(provider: GatewayProviderSummary, id: string, flag: string): GatewayModelSummary {
  const match = provider.models.find((model) => model.id === id)
  if (!match) {
    throw new SelectionError(
      `${flag} ${id} is not a model of ${provider.name} (${provider.id}). Available: ${provider.models.map((model) => model.id).join(", ")}.`,
    )
  }
  return match
}

export function modelLabel(model: GatewayModelSummary): string {
  const upstream = model.upstreamModelId && model.upstreamModelId !== model.name ? `, ${model.upstreamModelId}` : ""
  return `${model.name} (${model.id}${upstream})`
}

export async function chooseModel(
  provider: GatewayProviderSummary,
  requested: string | undefined,
  streams: PromptStreams,
): Promise<GatewayModelSummary> {
  if (requested) return findModel(provider, requested, "--model")
  if (provider.models.length === 0) throw new SelectionError(`${provider.name} (${provider.id}) has no models you can use.`)
  return pick(
    "Which model should Claude Code use?",
    provider.models.map((model) => ({ label: modelLabel(model), value: model })),
    { ...streams, hint: "pass --model gwm_…" },
  )
}
