import { z } from "zod"

/** Deployment diagnostics contain fixed facts, never endpoints, credentials or provider errors. */
export const serviceIdSchema = z.enum(["database", "gateway", "headlessRunner", "workbot", "slack", "durableTurns", "email"])
export type ServiceId = z.infer<typeof serviceIdSchema>
export const serviceReadinessStateSchema = z.enum(["ready", "not_configured", "misconfigured", "unreachable", "unknown"])
export type ServiceReadinessState = z.infer<typeof serviceReadinessStateSchema>
export const serviceReadinessReasonSchema = z.enum([
  "not_checked", "not_configured", "missing_configuration", "invalid_configuration",
  "health_verified", "database_verified", "authentication_failed", "unexpected_response",
  "request_failed", "timeout", "dependency_unavailable", "configuration_only",
  "provider_access_unverified", "organization_setup_required", "callback_unverified",
  "delivery_unverified", "incompatible_service",
])
export type ServiceReadinessReason = z.infer<typeof serviceReadinessReasonSchema>

export const deploymentServiceStatusSchema = z.strictObject({
  id: serviceIdSchema,
  required: z.boolean(),
  configured: z.boolean(),
  state: serviceReadinessStateSchema,
  reason: serviceReadinessReasonSchema,
  /** Constant setting names only; values are never part of this contract. */
  missingSettings: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)).max(16),
  dependencies: z.array(serviceIdSchema).max(6),
  checkedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  stale: z.boolean(),
}).meta({ ref: "DeploymentServiceStatus" })
export type DeploymentServiceStatus = z.infer<typeof deploymentServiceStatusSchema>

export const deploymentServiceReadinessSchema = z.strictObject({
  version: z.literal(1),
  checkedAt: z.string().datetime().nullable(),
  checking: z.boolean(),
  services: z.array(deploymentServiceStatusSchema).max(7),
}).meta({ ref: "DeploymentServiceReadiness" })
export type DeploymentServiceReadiness = z.infer<typeof deploymentServiceReadinessSchema>

/** Organization consumers cannot see deployment settings, origins or another member's access. */
export const organizationServiceReadinessSchema = z.strictObject({
  version: z.literal(1),
  checkedAt: z.string().datetime().nullable(),
  checking: z.boolean(),
  services: z.array(deploymentServiceStatusSchema.omit({ missingSettings: true, required: true })).max(7),
}).meta({ ref: "OrganizationServiceReadiness" })
export type OrganizationServiceReadiness = z.infer<typeof organizationServiceReadinessSchema>

export const SERVICE_LABELS: Record<ServiceId, string> = {
  database: "Database", gateway: "AI Gateway", headlessRunner: "Headless runner", workbot: "Workbot",
  slack: "Slack assistant", durableTurns: "Resumable answers", email: "Email",
}
export const SERVICE_SETUP_HINTS: Record<ServiceId, string> = {
  database: "Configure Den's database connection. If Den cannot start, use the deployment logs and existing readiness probe.",
  gateway: "Deploy the AI Gateway and configure GATEWAY_ENABLED, GATEWAY_PROXY_BASE_URL and GATEWAY_PUBLIC_BASE_URL on Den. Model provider credentials are configured separately.",
  headlessRunner: "Deploy a headless runner with a model endpoint and persistent storage. Set DEN_HEADLESS_RUNNER_URL and DEN_HEADLESS_RUNNER_TOKEN on Den; the token must match the runner's HEADLESS_API_TOKEN.",
  workbot: "Deploy Workbot and set DEN_WORKBOT_URL on Den. Configure Workbot's Den origin, runner connection and session-encryption secret separately.",
  slack: "Configure the headless runner first. Each organization must then enable and install its Slack assistant connection, and members must connect their accounts. Deployment health does not verify those credentials.",
  durableTurns: "Configure DEN_HEADLESS_RUNNER_CALLBACK_TOKEN on Den and HEADLESS_DEN_API_URL, HEADLESS_DEN_CALLBACK_TOKEN and HEADLESS_GRANT_KEY on the runner. Callback tokens must match each other and differ from the runner API token. A grant exchange is not tested here.",
  email: "Choose SMTP or Resend and configure EMAIL_FROM. Configuration presence does not verify message delivery.",
}
export const SERVICE_STATE_LABELS: Record<ServiceReadinessState, string> = {
  ready: "Ready", not_configured: "Not set up", misconfigured: "Misconfigured", unreachable: "Unreachable", unknown: "Couldn't verify",
}
export const SERVICE_REASON_LABELS: Record<ServiceReadinessReason, string> = {
  not_checked: "Not checked yet.",
  not_configured: "Optional service. Set it up when you need it.",
  missing_configuration: "Ask the deployment administrator to complete the missing settings.",
  invalid_configuration: "Ask the deployment administrator to correct the service settings.",
  health_verified: "The service answered its health check. This does not test a model completion or message delivery.",
  database_verified: "A database query succeeded.",
  authentication_failed: "The service rejected the health-check credentials. Ask the deployment administrator to check them.",
  unexpected_response: "The service did not return a supported health response.",
  request_failed: "The service could not be reached. Ask the deployment administrator to check the connection.",
  timeout: "The service did not answer in time. Try checking again.",
  dependency_unavailable: "A required service is not set up or could not be verified.",
  configuration_only: "Settings are present, but a live check is not supported.",
  provider_access_unverified: "Service health does not verify each member's model credentials or inference access.",
  organization_setup_required: "Each organization must configure its own connector and member access.",
  callback_unverified: "Settings alone do not verify that interrupted answers can resume.",
  delivery_unverified: "Delivery has not been tested. No message was sent.",
  incompatible_service: "The configured address does not identify a compatible service.",
}
