import { organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { requireFeature } from "../../features.js"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema } from "../../openapi.js"
import { cachedOrganizationServiceReadiness } from "../../service-readiness-runtime.js"
import type { OrgRouteVariables } from "./shared.js"

export function registerOrgServiceReadinessRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/org/service-readiness", describeRoute({
    tags: ["Organization"], summary: "Read minimal cached deployment service readiness", ...{ "x-mcp": false },
    description: "Member-safe deployment facts only. Does not inspect organization or member credentials, start a probe, or alter access decisions. Missing deployment settings and required-service policy are withheld.",
    responses: {
      200: jsonResponse("Cached service readiness.", organizationServiceReadinessSchema),
      404: jsonResponse("Service readiness is disabled.", notFoundSchema),
    },
  }), orgMemberRoute(), requireFeature("serviceReadiness"), async (c) => {
    const result = await cachedOrganizationServiceReadiness(true)
    c.header("Cache-Control", "no-store")
    if (!result) return c.json({ error: "feature_disabled", feature: "serviceReadiness" }, 404)
    return c.json(result)
  })
}
