import { deploymentServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import type { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { deploymentFeatureEnabled } from "../../features.js"
import { adminRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { serviceReadiness } from "../../service-readiness-runtime.js"
import type { AuthContextVariables } from "../../session.js"

const unavailableSchema = z.object({ error: z.literal("service_readiness_unavailable") })
const enabled: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  try {
    if (!await deploymentFeatureEnabled("serviceReadiness")) return c.json({ error: "feature_disabled", feature: "serviceReadiness" }, 404)
  } catch { return c.json({ error: "service_readiness_unavailable" }, 503) }
  await next()
}
export function registerAdminServiceReadinessRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const errors = {
    401: jsonResponse("Authentication required.", unauthorizedSchema),
    403: jsonResponse("Platform admin access required.", forbiddenSchema),
    404: jsonResponse("Service readiness is disabled.", notFoundSchema),
    503: jsonResponse("Diagnostic admission is unavailable; no upstream detail is exposed.", unavailableSchema),
  }
  app.get("/v1/admin/services", describeRoute({
    tags: ["Admin"], summary: "Read cached deployment service readiness", ...{ "x-mcp": false },
    description: "Fixed deployment diagnostics only, not inference or delivery verification. Never waits for an outbound health probe. A stale snapshot remains explicitly stale.",
    responses: { 200: jsonResponse("Cached deployment readiness.", deploymentServiceReadinessSchema), ...errors },
  }), adminRoute(), enabled, (c) => {
    serviceReadiness.syncCache()
    // Stale-while-revalidate is admin-only and bounded by the same durable
    // admission as POST. An organization read never invokes refresh().
    if (serviceReadiness.snapshot().services.some((status) => status.stale)) void serviceReadiness.refresh().catch(() => undefined)
    return c.json(serviceReadiness.snapshot())
  })
  app.post("/v1/admin/services/check", describeRoute({
    tags: ["Admin"], summary: "Queue a deployment service readiness check", ...{ "x-mcp": false },
    description: "Queues bounded, read-only service probes. Active checks and matching-configuration results completed within 30 seconds coalesce without changing timestamps or spending admission. Durable global admission limits new probes across replicas. Never sends email, calls a model, provisions credentials or initiates Slack events.",
    responses: {
      202: jsonResponse("Check queued, already in progress, or completed recently with matching configuration.", deploymentServiceReadinessSchema),
      429: jsonResponse("No recent matching snapshot is available and another replica recently admitted a check; Retry-After indicates the admission window.", deploymentServiceReadinessSchema),
      ...errors,
    },
  }), adminRoute(), enabled, async (c) => {
    try {
      const retryAfter = await serviceReadiness.refresh()
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json(serviceReadiness.snapshot(), 429)
      }
      return c.json(serviceReadiness.snapshot(), 202)
    } catch {
      // Durable limiter/feature-store errors may include database destinations.
      // Fail closed without handing raw errors to request logging middleware.
      return c.json({ error: "service_readiness_unavailable" }, 503)
    }
  })
}
