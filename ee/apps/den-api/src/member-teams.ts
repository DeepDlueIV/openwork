import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

export async function listTeamsForMember(input: {
  organizationId: typeof TeamTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}) {
  return db
    .select({
      id: TeamTable.id,
      name: TeamTable.name,
      organizationId: TeamTable.organizationId,
      createdAt: TeamTable.createdAt,
      updatedAt: TeamTable.updatedAt,
    })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .innerJoin(MemberTable, and(eq(MemberTable.id, TeamMemberTable.orgMembershipId), eq(MemberTable.organizationId, TeamTable.organizationId), isNull(MemberTable.removedAt)))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.memberId)))
    .orderBy(asc(TeamTable.createdAt))
}
