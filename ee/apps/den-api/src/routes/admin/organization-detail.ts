import { and, asc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { adminOrganizationDetailSchema, adminOrganizationUsageSchema } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { parseOrganizationPlan } from "../../entitlements.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { DEFAULT_ORGANIZATION_LIMITS, normalizeOrganizationMetadata } from "../../organization-limits.js"
import type { AuthContextVariables } from "../../session.js"
import { readAdminOrganizationUsage } from "../org/gateway-usage.js"
import { buildAdminPageInfo, normalizeAdminPageRequest, sanitizeAdminSearchForLike, type AdminPageRequest } from "./scale-performance.js"

const querySchema = z.object({ search: z.string().optional(), limit: z.string().optional(), offset: z.string().optional() })

async function organizationDetail(id: typeof OrganizationTable.$inferSelect.id, request: AdminPageRequest) {
  const started = Date.now()
  const [organization] = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug, metadata: OrganizationTable.metadata, createdAt: OrganizationTable.createdAt })
    .from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  if (!organization) return null
  const scope = and(eq(MemberTable.organizationId, id), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false))
  const pattern = `%${sanitizeAdminSearchForLike(request.search)}%`
  const filter = and(scope, request.search ? sql`(lower(${AuthUserTable.name}) like ${pattern} escape '|' or lower(${AuthUserTable.email}) like ${pattern} escape '|' or lower(${MemberTable.role}) like ${pattern} escape '|')` : undefined)
  const [members, totals, matching] = await Promise.all([
    db.select({ id: MemberTable.id, userId: MemberTable.userId, name: AuthUserTable.name, email: AuthUserTable.email, role: MemberTable.role, joinedAt: MemberTable.joinedAt })
      .from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id)).where(filter)
      .orderBy(asc(AuthUserTable.name), asc(MemberTable.id)).limit(request.limit).offset(request.offset),
    db.select({ total: sql<number>`count(*)` }).from(MemberTable).where(scope),
    db.select({ total: sql<number>`count(*)` }).from(MemberTable).leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id)).where(filter),
  ])
  const metadata = normalizeOrganizationMetadata(organization.metadata).metadata
  return {
    organization: {
      id: organization.id, name: organization.name, slug: organization.slug, createdAt: organization.createdAt.toISOString(),
      planTier: parseOrganizationPlan(metadata).tier, seatLimit: metadata.limits.members ?? DEFAULT_ORGANIZATION_LIMITS.members,
      memberCount: Number(totals[0]?.total ?? 0),
    },
    members: members.map((member) => ({ ...member, joinedAt: member.joinedAt?.toISOString() ?? null })),
    page: buildAdminPageInfo(request, Number(matching[0]?.total ?? 0), members.length, Date.now() - started),
    generatedAt: new Date().toISOString(),
  }
}

export function registerAdminOrganizationDetailRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  for (const usage of [false, true]) {
    app.get(`/v1/admin/organizations/:organizationId${usage ? "/usage" : ""}`,
      describeRoute({
        tags: ["Admin"], summary: usage ? "Get organization usage and a bounded member page" : "Get an organization and a bounded member page",
        description: usage ? "Returns the organization's last 30 UTC days of gateway usage, with requests, reported tokens, recorded cost and accounting coverage. Member usage is bounded to the requested member page; organization totals include all members, including removed members. Raw and retained usage use the same accounting as the organization dashboard." : "Returns organization identity, plan, seats and active memberships. Members are searched and paginated on the server. Does not calculate usage or resolve feature maps.",
        responses: {
          200: jsonResponse("Organization detail returned.", usage ? adminOrganizationUsageSchema : adminOrganizationDetailSchema),
          400: jsonResponse("Invalid organization id or pagination query.", invalidRequestSchema),
          401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema),
          404: jsonResponse("Organization not found.", notFoundSchema),
        },
      }), adminRoute(), queryValidator(querySchema), async (c) => {
        c.header("Cache-Control", "no-store")
        const id = c.req.param("organizationId")
        if (!isDenTypeId("organization", id)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
        const detail = await organizationDetail(id, normalizeAdminPageRequest(c.req.valid("query")))
        if (!detail) return c.json({ error: "not_found", message: "Organization not found." }, 404)
        if (!usage) return c.json(detail)
        return c.json({ ...detail, usage: await readAdminOrganizationUsage(id, detail.members.map((member) => member.id)) })
      })
  }
}
