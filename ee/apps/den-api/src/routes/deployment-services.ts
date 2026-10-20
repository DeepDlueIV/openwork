import { deploymentServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import type { Handler, MiddlewareHandler } from "hono"
import { z } from "zod"
import { deploymentFeatureEnabled } from "../features.js"
import { forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../openapi.js"
import { serviceReadiness } from "../service-readiness-runtime.js"

const unavailableSchema = z.object({ error: z.literal("service_readiness_unavailable") })

// Both entry points use these exact handlers and the runtime's single controller,
// including stale-while-revalidate, coalescing and durable deployment admission.
export const deploymentServicesEnabled: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  try {
    if (!await deploymentFeatureEnabled("serviceReadiness")) return c.json({ error: "feature_disabled", feature: "serviceReadiness" }, 404)
  } catch { return c.json({ error: "service_readiness_unavailable" }, 503) }
  await next()
}

export const deploymentServicesErrors = {
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("Deployment operator access required.", forbiddenSchema),
  404: jsonResponse("Service readiness is disabled.", notFoundSchema),
  503: jsonResponse("Diagnostic admission is unavailable; no upstream detail is exposed.", unavailableSchema),
}

export const deploymentServicesReadResponses = {
  200: jsonResponse("Cached deployment readiness.", deploymentServiceReadinessSchema), ...deploymentServicesErrors,
}
export const deploymentServicesCheckResponses = {
  202: jsonResponse("Check queued, already in progress, or completed recently with matching configuration.", deploymentServiceReadinessSchema),
  429: jsonResponse("No recent matching snapshot is available and another replica recently admitted a check; Retry-After indicates the admission window.", deploymentServiceReadinessSchema),
  ...deploymentServicesErrors,
}

export const readDeploymentServices: Handler = (c) => {
  serviceReadiness.syncCache()
  // Only authorized operator/admin reads refresh; the minimal org read never does.
  if (serviceReadiness.snapshot().services.some((status) => status.stale)) void serviceReadiness.refresh().catch(() => undefined)
  return c.json(serviceReadiness.snapshot())
}

export const checkDeploymentServices: Handler = async (c) => {
  try {
    const retryAfter = await serviceReadiness.refresh()
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter))
      return c.json(serviceReadiness.snapshot(), 429)
    }
    return c.json(serviceReadiness.snapshot(), 202)
  } catch {
    // Durable limiter/feature-store errors may include database destinations.
    return c.json({ error: "service_readiness_unavailable" }, 503)
  }
}
