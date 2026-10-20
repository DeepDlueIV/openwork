import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { requireFeature } from "../../features.js"
import { orgMemberRoute, requireLocalDeploymentOperatorMiddleware, userSessionRoute } from "../../middleware/index.js"
import { checkDeploymentServices, deploymentServicesCheckResponses, deploymentServicesEnabled, deploymentServicesReadResponses, readDeploymentServices } from "../deployment-services.js"
import type { OrgRouteVariables } from "./shared.js"

export function registerOrgDeploymentServiceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/org/deployment-services", describeRoute({
    tags: ["Organizations"], summary: "Read local deployment service readiness", ...{ "x-mcp": false },
    description: "Self-hosted deployment operators with an active organization membership only. Organization ownership and permissions do not grant access. Shares the platform diagnostics snapshot and bounded refresh admission.",
    responses: deploymentServicesReadResponses,
  }), userSessionRoute(), orgMemberRoute(), requireLocalDeploymentOperatorMiddleware, requireFeature("serviceReadiness"), deploymentServicesEnabled, readDeploymentServices)
  app.post("/v1/org/deployment-services/check", describeRoute({
    tags: ["Organizations"], summary: "Queue a local deployment service readiness check", ...{ "x-mcp": false },
    description: "Self-hosted deployment operators with an active organization membership only. Queues the same read-only, bounded probes as platform diagnostics; shares active checks, recent results and deployment-wide rate limits. Never sends email, calls a model or initiates Slack events.",
    responses: deploymentServicesCheckResponses,
  }), userSessionRoute(), orgMemberRoute(), requireLocalDeploymentOperatorMiddleware, requireFeature("serviceReadiness"), deploymentServicesEnabled, checkDeploymentServices)
}
