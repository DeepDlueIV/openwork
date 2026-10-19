import type { HeadlessModelAccess, HeadlessModelCatalog } from "@openwork-ee/headless-protocol"
import { parseGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import { WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import type { GatewayProviderSummary } from "@openwork/types/den/gateway"
import { gatewayProviderUrl, readProviderConfigNpm } from "../llm/inference-provider-config.js"

export type CloudAgentGatewayActor = { organizationId: string; userId: string }
export type CloudAgentGatewayProtocol = HeadlessModelAccess["protocol"]
export type CloudAgentGatewayAccess = HeadlessModelAccess
export type CloudAgentGatewaySummary = Pick<GatewayProviderSummary, "id" | "providerId" | "status" | "providerConfig" | "models">
export type CloudAgentGatewayModel = {
  id: string
  name: string
  upstreamModelId: string
  provider: string
  baseUrl: string
  protocol: CloudAgentGatewayProtocol
}

/** Classify the shared Gateway's rewritten SDK, not a model's display name or upstream URL. */
export function cloudAgentGatewayProtocol(config: Record<string, unknown>): CloudAgentGatewayProtocol | null {
  switch (readProviderConfigNpm(config)) {
    case "@ai-sdk/anthropic": return "anthropic"
    case "@ai-sdk/openai": return "openai-responses"
    case "@ai-sdk/openai-compatible":
    case "@openrouter/ai-sdk-provider":
    case "@ai-sdk/amazon-bedrock/mantle": return "openai"
    default: return null
  }
}

/** Only gatewaySummary(..., false).models is usable; authorizationRequests are never a fallback. */
export function projectCloudAgentGatewayModels(summaries: CloudAgentGatewaySummary[], gatewayBaseUrl: string): CloudAgentGatewayModel[] {
  const models = new Map<string, CloudAgentGatewayModel>()
  for (const summary of summaries) {
    if (summary.status !== "active") continue
    const protocol = cloudAgentGatewayProtocol(summary.providerConfig)
    if (!protocol) continue
    const baseUrl = gatewayProviderUrl(gatewayBaseUrl, summary.id)
    for (const model of summary.models) {
      if (!parseGatewayModelAlias(model.id)) continue
      models.set(model.id, { id: model.id, name: model.name, upstreamModelId: model.upstreamModelId, provider: summary.providerId, baseUrl, protocol })
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function cloudAgentGatewayCatalogProjection(models: CloudAgentGatewayModel[]): HeadlessModelCatalog {
  const luna = models.filter((model) => model.upstreamModelId === "gpt-6-luna")
  return {
    defaultModel: luna.length === 1 ? luna[0]?.id ?? WORKBOT_DEFAULT_MODEL_ID : WORKBOT_DEFAULT_MODEL_ID,
    models: models.map(({ id, name, provider }) => ({ id, name, provider })),
    // Credential/grant readiness only. This is not a paid completion or a claim that upstream is healthy.
    verified: true,
  }
}

export type CloudAgentGatewaySnapshot = { memberId: string; gatewayBaseUrl: string; summaries: CloudAgentGatewaySummary[] }
export type CloudAgentGatewayDeps = {
  snapshot: (actor: CloudAgentGatewayActor) => Promise<CloudAgentGatewaySnapshot>
  memberKey: (actor: CloudAgentGatewayActor, memberId: string) => Promise<string>
}

/** Injectable boundary for focused authorization tests. No catalog or access is cached between calls. */
export function createCloudAgentGatewayModelService(deps: CloudAgentGatewayDeps) {
  async function current(actor: CloudAgentGatewayActor) {
    const snapshot = await deps.snapshot(actor)
    return { ...snapshot, models: projectCloudAgentGatewayModels(snapshot.summaries, snapshot.gatewayBaseUrl) }
  }
  return {
    async catalog(actor: CloudAgentGatewayActor): Promise<HeadlessModelCatalog> {
      return cloudAgentGatewayCatalogProjection((await current(actor)).models)
    },
    async access(actor: CloudAgentGatewayActor, model: string): Promise<CloudAgentGatewayAccess> {
      const snapshot = await current(actor)
      const selected = snapshot.models.find((entry) => entry.id === model)
      if (!selected) throw new Error("cloud_agent_gateway_model_unavailable")
      const apiKey = await deps.memberKey(actor, snapshot.memberId)
      return { baseUrl: selected.baseUrl, apiKey, protocol: selected.protocol }
    },
  }
}

// Lazy server imports keep the projections and injectable service usable without booting Den/DB.
const databaseDeps: CloudAgentGatewayDeps = {
  async snapshot(actor) {
    const [{ and, asc, eq, isNull }, { AuthUserTable, GatewayProviderTable, MemberTable, OrganizationTable }, { normalizeDenTypeId }, { db }, { env }, { gatewaySummary }, { scheduleLiteLlmProvisioning }, { isLiteLlmProviderId }] = await Promise.all([
      import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"),
      import("../db.js"), import("../env.js"), import("../llm/gateway-matrix.js"), import("../llm/litellm-issued.js"), import("@openwork-ee/utils/litellm-catalog"),
    ])
    if (!env.gatewayEnabled) throw new Error("cloud_agent_gateway_not_configured")
    const organizationId = normalizeDenTypeId("organization", actor.organizationId)
    const userId = normalizeDenTypeId("user", actor.userId)
    const [member] = await db.select({ id: MemberTable.id }).from(MemberTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
      .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
      .limit(1)
    if (!member) throw new Error("cloud_agent_gateway_member_not_found")
    const providers = await db.select().from(GatewayProviderTable)
      .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
      .orderBy(asc(GatewayProviderTable.id))
    const summaries: CloudAgentGatewaySummary[] = []
    for (const provider of providers) {
      const summary = await gatewaySummary(provider, member.id, env.gatewayPublicBaseUrl, false)
      // Only granted members appear in these projections. Provisioning rechecks eligibility itself.
      if (isLiteLlmProviderId(provider.provider_id) && (summary.models.length || summary.authorizationRequests.length)) {
        scheduleLiteLlmProvisioning(provider, member.id)
      }
      summaries.push(summary)
    }
    return { memberId: member.id, gatewayBaseUrl: env.gatewayPublicBaseUrl, summaries }
  },
  async memberKey(actor, memberId) {
    const [{ ensureMemberGatewayKey }, { normalizeDenTypeId }] = await Promise.all([
      import("../gateway-keys.js"), import("@openwork-ee/utils/typeid"),
    ])
    return ensureMemberGatewayKey({ organizationId: normalizeDenTypeId("organization", actor.organizationId), memberId: normalizeDenTypeId("member", memberId) })
  },
}

const service = createCloudAgentGatewayModelService(databaseDeps)
export const cloudAgentGatewayCatalog = service.catalog
export const cloudAgentGatewayAccess = service.access
