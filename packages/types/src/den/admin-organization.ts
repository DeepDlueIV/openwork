import { z } from "zod"

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const adminOrganizationDetailSchema = z.object({
  organization: z.object({
    id: z.string(), name: z.string(), slug: z.string().nullable(), createdAt: z.string().datetime(),
    planTier: z.string(), seatLimit: count, memberCount: count,
  }),
  members: z.array(z.object({
    id: z.string(), userId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable(),
    role: z.string(), joinedAt: z.string().datetime().nullable(),
  })),
  page: z.object({ limit: count, offset: count, search: z.string(), total: count, returned: count, hasMore: z.boolean(), durationMs: count }),
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminOrganizationDetail" })

export const adminOrganizationUsageTotalsSchema = z.object({
  requests: count, tokens: count, costMicroUsd: count,
  unreportedRequests: count.nullable(), unpricedRequests: count.nullable(),
})

export const adminOrganizationUsageSchema = adminOrganizationDetailSchema.extend({
  usage: z.object({
    from: z.string(), to: z.string(), totals: adminOrganizationUsageTotalsSchema,
    members: z.array(adminOrganizationUsageTotalsSchema.extend({ memberId: z.string() })),
  }),
}).meta({ ref: "AdminOrganizationUsage" })

export type AdminOrganizationDetail = z.infer<typeof adminOrganizationDetailSchema>
export type AdminOrganizationUsage = z.infer<typeof adminOrganizationUsageSchema>
export type AdminOrganizationUsageTotals = z.infer<typeof adminOrganizationUsageTotalsSchema>
