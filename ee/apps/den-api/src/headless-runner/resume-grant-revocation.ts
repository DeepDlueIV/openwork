import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { HeadlessResumeGrantTable, HeadlessResumeRevocationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"

const RESUME_TABLES = ["headless_resume_grant", "headless_resume_revocation"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * MySQL "table doesn't exist" (errno 1146) for one of the resume grant tables, through Drizzle's wrapper (`cause`) or
 * PlanetScale's (`body`). Any other error, including a missing table elsewhere, is not this.
 */
export function isMissingResumeTableError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const message = typeof error.message === "string" ? error.message : ""
  const namesResumeTable = RESUME_TABLES.some((table) => message.includes(table))
  if ((error.errno === 1146 || error.code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist")) && namesResumeTable) return true
  return isMissingResumeTableError(error.cause) || isMissingResumeTableError(error.body)
}

/**
 * Runs resume-grant cleanup that sits on another flow's path (credential revocation, user deletion). Until the
 * migration that creates the tables has run, no grant can exist, so a missing table means nothing to revoke: the
 * surrounding flow must not fail because den-api deployed before its migration finished. Every other error is thrown.
 */
export async function unlessResumeTablesMissing<T>(work: () => Promise<T>, nothing: T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isMissingResumeTableError(error)) return nothing
    throw error
  }
}

type OrganizationId = typeof HeadlessResumeGrantTable.$inferSelect.organizationId
type UserId = typeof HeadlessResumeGrantTable.$inferSelect.userId

/**
 * Revokes every resume grant (resume-grants.ts) one person holds in one organization, so the headless runner can no
 * longer get tokens for their turns there. Called from the membership credential revocation path (member removed,
 * role or role permissions changed, ownership transferred). Kept apart from resume-grants.ts so the revocation path
 * does not import the token minter. User deletion deletes the rows instead (user-deletion.ts and the admin user
 * deletion route).
 *
 * The revocation moment is recorded first, then live grants are marked revoked. A grant being minted concurrently is
 * not in the sweep, but it was authorized before this moment, so the exchange refuses it (see
 * headlessResumeGrantAuthorizedBeforeRevocation): no ordering of the two writes lets it through.
 */
export async function revokeHeadlessResumeGrantsForMember(input: { organizationId: OrganizationId; userId: UserId; now?: Date }): Promise<number> {
  return unlessResumeTablesMissing(async () => {
    const now = input.now ?? new Date()
    await db
      .insert(HeadlessResumeRevocationTable)
      .values({ organizationId: input.organizationId, userId: input.userId, revokedAt: now })
      .onDuplicateKeyUpdate({ set: { revokedAt: sql`greatest(${HeadlessResumeRevocationTable.revokedAt}, values(revoked_at))` } })
    const live = await db
      .select({ id: HeadlessResumeGrantTable.id })
      .from(HeadlessResumeGrantTable)
      .where(and(
        eq(HeadlessResumeGrantTable.userId, input.userId),
        eq(HeadlessResumeGrantTable.organizationId, input.organizationId),
        isNull(HeadlessResumeGrantTable.revokedAt),
      ))
    if (!live.length) return 0
    await db
      .update(HeadlessResumeGrantTable)
      .set({ revokedAt: now })
      .where(inArray(HeadlessResumeGrantTable.id, live.map((row) => row.id)))
    return live.length
  }, 0)
}
