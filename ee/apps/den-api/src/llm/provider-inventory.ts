import { and, eq, gt, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, GatewayCredentialSetTable, GatewayKeyTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { organizationFeatureEnabled } from "../features.js"
import { memberGatewayTeams } from "./inference-provider-lifecycle.js"
import { providerInventoryReadiness, providerInventoryRevision } from "./provider-inventory-revision.js"

export type ProviderInventoryPrincipal = {
  organizationId: typeof OrganizationTable.$inferSelect.id
  memberId: typeof MemberTable.$inferSelect.id
  userId: NonNullable<typeof MemberTable.$inferSelect.userId>
  sessionId: typeof AuthSessionTable.$inferSelect.id
  sessionToken: string
}

/**
 * Dependency fingerprint for the usable list + connect read by providers.ts.
 * Batched, organization-indexed reads in one snapshot, not N gatewaySummary
 * calls, catalog refreshes, key issuance, upstream requests, or timestamp/MAX
 * aggregates. The latter miss model/link deletes, access/team writes, and key
 * rotations that never touch a provider. Include full stored config/readiness
 * inputs so config-only and same-timestamp changes cannot fall through a hole.
 *
 * A conservative revision can change for an inaccessible provider; it reveals
 * no inventory or credential data and merely asks the client to reread its
 * existing authorized APIs. Credentials are restricted to org + this caller.
 */
export async function readProviderInventoryRevision(principal: ProviderInventoryPrincipal): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const [session] = await tx.select({ id: AuthSessionTable.id }).from(AuthSessionTable)
      .where(and(eq(AuthSessionTable.id, principal.sessionId), eq(AuthSessionTable.token, principal.sessionToken), eq(AuthSessionTable.userId, principal.userId), gt(AuthSessionTable.expiresAt, now)))
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
      .where(and(eq(MemberTable.id, principal.memberId), eq(MemberTable.userId, principal.userId), eq(MemberTable.organizationId, principal.organizationId), isNull(MemberTable.removedAt)))
    // Passing the transaction deliberately bypasses the feature cache. A kill
    // switch or org revocation closes an already-open stream on its next check.
    if (!session || !member || !await organizationFeatureEnabled(principal.organizationId, "liveProviderSync", { database: tx })) {
      throw new Error("Provider inventory is no longer authorized.")
    }
    const providers = await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, principal.organizationId))
    const ids = providers.map((provider) => provider.id)
    const models = ids.length ? await tx.select().from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.gateway_provider_id, ids)) : []
    const groups = ids.length ? await tx.select().from(GatewayModelGroupTable).where(inArray(GatewayModelGroupTable.gateway_provider_id, ids)) : []
    const groupIds = groups.map((group) => group.id)
    const links = groupIds.length ? await tx.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groupIds)) : []
    const sets = ids.length ? await tx.select().from(GatewayCredentialSetTable).where(inArray(GatewayCredentialSetTable.gateway_provider_id, ids)) : []
    const grants = ids.length ? await tx.select().from(GatewayProviderAccessTable).where(inArray(GatewayProviderAccessTable.gateway_provider_id, ids)) : []
    const credentials = ids.length ? await tx.select().from(GatewayProviderCredentialTable).where(and(
      inArray(GatewayProviderCredentialTable.gateway_provider_id, ids), eq(GatewayProviderCredentialTable.organization_id, principal.organizationId),
      or(and(eq(GatewayProviderCredentialTable.subject, "org"), isNull(GatewayProviderCredentialTable.org_membership_id)),
        and(eq(GatewayProviderCredentialTable.subject, principal.memberId), eq(GatewayProviderCredentialTable.org_membership_id, principal.memberId))),
    )) : []
    const teams = await memberGatewayTeams(tx, principal.organizationId, principal.memberId)
    const keys = await tx.select().from(GatewayKeyTable).where(and(eq(GatewayKeyTable.organization_id, principal.organizationId), eq(GatewayKeyTable.org_membership_id, principal.memberId)))
    // Time alone can remove readiness: LiteLLM/API-key expiry and the AWS SSO
    // registered client's expiry inside its secret. Never hash the wall clock.
    const readiness = providerInventoryReadiness(credentials, now.getTime())
    return providerInventoryRevision({ organizationId: principal.organizationId, memberId: principal.memberId, gatewayBaseUrl: env.gatewayPublicBaseUrl,
      rows: { providers, models, groups, links, sets, grants, credentials, teams, keys, readiness } }, env.betterAuthSecret)
  }, { isolationLevel: "repeatable read", accessMode: "read only" })
}
