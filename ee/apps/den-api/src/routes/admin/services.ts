import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { adminRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { checkDeploymentServices, deploymentServicesCheckResponses, deploymentServicesEnabled, deploymentServicesReadResponses, readDeploymentServices } from "../deployment-services.js"

export function registerAdminServiceReadinessRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/services", describeRoute({
    tags: ["Admin"], summary: "Read cached deployment service readiness", ...{ "x-mcp": false },
    description: "Fixed deployment diagnostics only, not inference or delivery verification. Never waits for an outbound health probe. A stale snapshot remains explicitly stale.",
    responses: deploymentServicesReadResponses,
  }), adminRoute(), deploymentServicesEnabled, readDeploymentServices)
  app.post("/v1/admin/services/check", describeRoute({
    tags: ["Admin"], summary: "Queue a deployment service readiness check", ...{ "x-mcp": false },
    description: "Queues bounded, read-only service probes. Active checks and matching-configuration results completed within 30 seconds coalesce without changing timestamps or spending admission. Durable global admission limits new probes across replicas. Never sends email, calls a model, provisions credentials or initiates Slack events.",
    responses: deploymentServicesCheckResponses,
  }), adminRoute(), deploymentServicesEnabled, checkDeploymentServices)
}
