import { describe, expect, test } from "bun:test"
import { parseDeploymentCapabilities } from "@openwork/types/den/deployment-capabilities"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import { headlessServiceHealthSchema, workbotServiceHealthSchema } from "@openwork/types/den/service-health"

const checkedAt = "2026-10-19T12:00:00.000Z"
const service = {
  id: "headlessRunner", configured: false, state: "not_configured", reason: "not_configured",
  dependencies: [], checkedAt, lastSuccessAt: null, stale: false,
}
const projected = { version: 1, checkedAt, checking: false, services: [service] }

describe("optional deployment diagnostics do not change existing capabilities", () => {
  test("older version-one responses keep the configured Gateway capability", () => {
    expect(parseDeploymentCapabilities({ version: 1, aiGateway: true })).toEqual({ version: 1, aiGateway: true })
  })
  test("valid readiness stays separate from the configured capability", () => {
    expect(parseDeploymentCapabilities({ version: 1, aiGateway: true, serviceReadiness: projected }))
      .toEqual({ version: 1, aiGateway: true, serviceReadiness: projected })
  })
  test("malformed diagnostics cannot turn off a valid existing Gateway", () => {
    const parsed = parseDeploymentCapabilities({ version: 1, aiGateway: true, serviceReadiness: { version: 9000 } })
    expect(parsed.aiGateway).toBe(true)
    expect(parsed.serviceReadiness).toBeUndefined()
  })
  test("an unsupported base capability version still fails closed", () => {
    expect(parseDeploymentCapabilities({ version: 9000, aiGateway: true })).toEqual({ version: 1, aiGateway: false })
  })
})

describe("diagnostic contracts never carry raw service configuration", () => {
  test("organization projections reject admin-only missing setting details", () => {
    expect(organizationServiceReadinessSchema.safeParse(projected).success).toBe(true)
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, missingSettings: ["DEN_HEADLESS_RUNNER_TOKEN"] }] }).success).toBe(false)
  })
  test("admin diagnostics accept field names but reject a URL or credential value", () => {
    const snapshot = { ...projected, services: [{ ...service, required: false, missingSettings: ["DEN_HEADLESS_RUNNER_TOKEN"] }] }
    expect(deploymentServiceReadinessSchema.safeParse(snapshot).success).toBe(true)
    expect(deploymentServiceReadinessSchema.safeParse({ ...snapshot, services: [{ ...snapshot.services[0], missingSettings: ["https://private.example.test?token=private"] }] }).success).toBe(false)
  })
  test("arbitrary downstream error text is not a reason code", () => {
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, reason: "upstream printed a private credential" }] }).success).toBe(false)
  })
  test("service health responses contain facts rather than endpoint or token values", () => {
    const runner = { version: 1, service: "headless-runner", modelConfigured: true, resumeConfigured: false, denOriginMatches: null }
    const workbot = { version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: true }
    expect(headlessServiceHealthSchema.safeParse(runner).success).toBe(true)
    expect(workbotServiceHealthSchema.safeParse(workbot).success).toBe(true)
    expect(headlessServiceHealthSchema.safeParse({ ...runner, token: "private" }).success).toBe(false)
    expect(workbotServiceHealthSchema.safeParse({ ...workbot, denApiUrl: "https://private.example.test" }).success).toBe(false)
  })
})
