import { and, eq, gte, isNull, lt, sql } from "drizzle-orm"
import type { createDenDb } from "./client"
import { FreeAutoLimitEventTable as Limit } from "./schema/free-auto-behavior"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"

type Database = ReturnType<typeof createDenDb>["db"]
export const FREE_AUTO_CONVERSION_WINDOW_DAYS = 30
const WINDOW_MS = FREE_AUTO_CONVERSION_WINDOW_DAYS * 86_400_000

/** A missing/malformed correlation header disables guest attribution without affecting access or accounting. */
export function freeAutoJourneyHash(value: string | null | undefined): string | null {
  return value && /^[a-f0-9]{64}$/.test(value) ? freeInferenceDigest("free-auto-journey", value) : null
}

export async function recordFreeAutoLimit(database: Database, input: {
  audience: "guest" | "member"; subjectHash: string; userId?: typeof Limit.$inferInsert.user_id;
  organizationId?: typeof Limit.$inferInsert.organization_id; windowStart: Date; now: Date;
}) {
  const id = freeInferenceDigest("free-auto-limit", `${input.audience}:${input.subjectHash}:${input.windowStart.toISOString()}`)
  await database.insert(Limit).values({ id, audience: input.audience, subject_hash: input.subjectHash,
    user_id: input.userId, organization_id: input.organizationId, window_start_at: input.windowStart, exhausted_at: input.now })
    .onDuplicateKeyUpdate({ set: { id: sql`${Limit.id}` } })
}

/** First authenticated Auto request with the same reported journey; no IP or device fingerprint join. */
export async function linkFreeAutoGuest(database: Database, input: {
  journeyHash: string; userId: NonNullable<typeof Limit.$inferInsert.user_id>;
  organizationId: NonNullable<typeof Limit.$inferInsert.organization_id>; now: Date;
}) {
  await database.update(Limit).set({ user_id: input.userId, organization_id: input.organizationId, authenticated_at: input.now })
    .where(and(eq(Limit.audience, "guest"), eq(Limit.subject_hash, input.journeyHash), isNull(Limit.user_id),
      lt(Limit.exhausted_at, input.now), gte(Limit.exhausted_at, new Date(input.now.getTime() - WINDOW_MS))))
}

/** Durable sign-in evidence, independent of session retention or optional organization audit capture. */
export async function recordFreeAutoSignIn(database: Database, input: { userId: NonNullable<typeof Limit.$inferInsert.user_id>; now: Date }) {
  await database.update(Limit).set({ authenticated_at: input.now }).where(and(eq(Limit.audience, "member"),
    eq(Limit.user_id, input.userId), isNull(Limit.authenticated_at), gte(Limit.exhausted_at, new Date(input.now.getTime() - WINDOW_MS)), lt(Limit.exhausted_at, input.now)))
}
