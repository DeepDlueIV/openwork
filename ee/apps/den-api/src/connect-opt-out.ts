import { and, eq } from "@openwork-ee/den-db/drizzle"
import { FeatureRolloutTable, OrganizationFeatureTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"

/**
 * OpenWork Connect is generally available: it has no feature flag, no /admin
 * switch and no Helm key, and nothing can turn it off anymore.
 *
 * The retired `mcpConnections` feature could be turned off before that. Those
 * opt-outs are honored exactly as before, so an organization whose
 * administrator turned Connect off keeps it off (member-facing connections,
 * marketplace capabilities, native Google Workspace / Microsoft 365 actions,
 * Apps). The stored state is only read here: the admin capability endpoints
 * ignore the retired key, so no new opt-out can be written. Support clears an
 * existing one by deleting its row.
 */

/** The retired registry key, as stored in organization_feature and feature_rollout. */
export const LEGACY_CONNECT_FEATURE_KEY = "mcpConnections"

export type LegacyConnectState = {
  /** The deployment-wide feature_rollout row, if one was stored. */
  rollout: { enabled: boolean; killed: boolean } | null
  /** DEN_FEATURE_MCP_CONNECTIONS, if the operator set it. */
  lock: boolean | null
  /** The organization's organization_feature row, if one was stored. */
  override: boolean | null
}

/**
 * Same order the retired feature resolved in (packages/features resolveFeature):
 * kill switch, operator lock, organization override, deployment-wide state,
 * then the old default (on). Connect was available on every deployment.
 */
export function resolveLegacyConnectState(state: LegacyConnectState): boolean {
  if (state.rollout?.killed) return false
  if (state.lock !== null) return state.lock
  if (state.override !== null) return state.override
  return state.rollout?.enabled ?? true
}

/**
 * Whether Connect is available to this organization's members: true unless a
 * legacy opt-out stored before the switch was retired says otherwise. Read
 * fresh on every call (two primary-key lookups), like features.ts.
 */
export async function connectAvailable(organizationId: string): Promise<boolean> {
  const [rollout] = await db
    .select({ enabled: FeatureRolloutTable.enabled, killed: FeatureRolloutTable.killed })
    .from(FeatureRolloutTable)
    .where(eq(FeatureRolloutTable.feature_key, LEGACY_CONNECT_FEATURE_KEY))
    .limit(1)
  if (rollout?.killed) return false
  if (env.legacyConnectLock !== null) return env.legacyConnectLock
  const [override] = await db
    .select({ enabled: OrganizationFeatureTable.enabled })
    .from(OrganizationFeatureTable)
    .where(and(
      eq(OrganizationFeatureTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(OrganizationFeatureTable.feature_key, LEGACY_CONNECT_FEATURE_KEY),
    ))
    .limit(1)
  return resolveLegacyConnectState({
    rollout: rollout ?? null,
    lock: env.legacyConnectLock,
    override: override?.enabled ?? null,
  })
}
