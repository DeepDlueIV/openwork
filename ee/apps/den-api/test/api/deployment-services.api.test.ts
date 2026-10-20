import assert from "node:assert/strict"
import { after, test } from "node:test"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const email = "setup-services-operator@example.test"
const code = "services-one-time-setup-code-not-production"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted", DEN_BOOTSTRAP_ADMIN_EMAILS: "",
  DEN_SINGLE_ORG_OWNER_EMAILS: email, DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: code,
} })
after(() => den.close())

const paths = ["/v1/org/deployment-services", "/v1/org/deployment-services/check"]
async function denied(person: Session | null, orgId: string, expected: number) {
  for (const path of paths) {
    const result = await den.request(person?.token ?? null, path.endsWith("check") ? "POST" : "GET", path, { orgId })
    assert.equal(result.status, expected, `${person?.name ?? "anonymous"} ${path}: ${summary(result)}`)
  }
}

async function hint(person: Session, orgId: string) {
  const result = await den.as(person, orgId)("GET", "/v1/org")
  assert.equal(result.status, 200, summary(result))
  return field(result.body, "canManageDeploymentServices")
}

test("real MySQL: setup-created local operator, not org authority; session, membership and both feature gates fail closed", async () => {
  assert.equal(process.env.DEN_BOOTSTRAP_ADMIN_EMAILS, "")
  assert.equal(field((await den.request(null, "GET", "/v1/auth/bootstrap/status")).body, "status"), "available")
  const verified = await den.request(null, "POST", "/v1/auth/bootstrap/verify", { body: { email, code } })
  assert.equal(verified.status, 200, summary(verified))
  const signedUp = await den.request(null, "POST", "/api/auth/sign-up/email", { body: {
    email, name: "Setup Services Operator", password: den.password, bootstrapGrant: text(field(verified.body, "grant"), "bootstrap grant"),
  } })
  assert.equal(signedUp.status, 200, summary(signedUp))
  const signedIn = await den.signIn(email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const operator: Session = { email, name: "Setup Services Operator", token: text(field(signedIn.body, "token"), "session token"), cookie: signedIn.headers.get("set-cookie")?.split(";")[0] ?? "", userId: text(field(signedIn.body, "user", "id"), "user id") }
  const { orgId, owner } = await den.createOrg(operator, "Local services org")
  const member = await den.newMember(owner, orgId, "Services Member")
  const admin = await den.newMember(owner, orgId, "Services Org Admin", "admin")
  const successor = await den.newMember(owner, orgId, "Services Future Owner", "admin")
  assert.equal(await hint(owner, orgId), false, "setup operator is hidden until the feature is enabled")
  for (const person of [member, admin, successor]) assert.equal(await hint(person, orgId), false)
  await denied(null, orgId, 401)
  await denied(owner, orgId, 404)
  const rollout = (body: Record<string, boolean>) => den.request(operator.token, "PUT", "/v1/admin/features/serviceReadiness", { body })
  const orgFeature = (enabled: boolean) => den.request(operator.token, "PUT", `/v1/admin/organizations/${orgId}/capabilities`, { body: { capabilities: { serviceReadiness: enabled } } })
  assert.equal((await orgFeature(true)).status, 200)
  await denied(owner, orgId, 404)
  assert.equal(await hint(owner, orgId), false, "organization override cannot bypass disabled deployment rollout")
  assert.equal((await rollout({ enabled: true })).status, 200)
  assert.equal(await hint(owner, orgId), true, "setup persisted operator authority without environment allowlist seeding")
  assert.equal((await orgFeature(false)).status, 200)
  await denied(owner, orgId, 404)
  assert.equal(await hint(owner, orgId), false, "disabled organization hides the capability despite deployment rollout")
  assert.equal((await orgFeature(true)).status, 200)
  assert.equal(await hint(owner, orgId), true)
  assert.equal((await rollout({ enabled: false })).status, 200)
  await denied(owner, orgId, 404)
  assert.equal(await hint(owner, orgId), false, "turning deployment rollout off withdraws the capability")
  assert.equal((await rollout({ enabled: true })).status, 200)
  assert.equal(await hint(owner, orgId), true)

  // A real durable admission taken by another replica blocks both entry points.
  const { checkRateLimit } = await import("../../src/utils/rate-limit.js")
  const { SERVICE_READINESS_RATE_KEY, SERVICE_READINESS_RATE_WINDOW_MS } = await import("../../src/service-readiness.js")
  assert.equal(await checkRateLimit(SERVICE_READINESS_RATE_KEY, 1, SERVICE_READINESS_RATE_WINDOW_MS, Date.now()), null)
  for (const path of ["/v1/admin/services/check", "/v1/org/deployment-services/check"]) {
    const limited = await den.request(operator.token, "POST", path, { orgId })
    assert.equal(limited.status, 429, summary(limited))
    assert.ok(Number(limited.headers.get("retry-after")) > 0)
    deploymentServiceReadinessSchema.parse(limited.body)
  }
  const full = await den.as(owner, orgId)("GET", paths[0])
  assert.equal(full.status, 200, summary(full))
  deploymentServiceReadinessSchema.parse(full.body)
  for (const person of [member, admin, successor]) {
    await denied(person, orgId, 403)
    const spoofed = await den.as(person, orgId)("GET", paths[0], undefined, { "x-den-deployment": "self_hosted", "x-openwork-deployment": "self_hosted", "x-openwork-platform-admin": "true" })
    assert.equal(spoofed.status, 403, summary(spoofed))
    const forgedCapability = await den.as(person, orgId)("POST", paths[1], { canManageDeploymentServices: true, features: { serviceReadiness: true } }, { "x-can-manage-deployment-services": "true" })
    assert.equal(forgedCapability.status, 403, "forged or stale browser capabilities never authorize a check")
    assert.equal((await den.request(person.token, "GET", "/v1/admin/services")).status, 403, "adminRoute was not widened")
    const minimal = await den.as(person, orgId)("GET", "/v1/org/service-readiness")
    assert.equal(minimal.status, 200, summary(minimal))
    const projection = organizationServiceReadinessSchema.parse(minimal.body)
    for (const service of projection.services) {
      assert.equal("missingSettings" in service, false)
      assert.equal("required" in service, false)
    }
  }

  // Even the operator's own API key must not inherit local operator authority.
  const issued = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Operator automation" })
  assert.equal(issued.status, 201, summary(issued))
  const key = text(field(issued.body, "key"), "API key")
  const keyOrg = await den.request(null, "GET", "/v1/org", { orgId, headers: { "x-api-key": key } })
  assert.equal(keyOrg.status, 200, summary(keyOrg))
  assert.equal(field(keyOrg.body, "canManageDeploymentServices"), false)
  for (const path of paths) {
    const result = await den.request(null, path.endsWith("check") ? "POST" : "GET", path, { orgId, headers: { "x-api-key": key, cookie: owner.cookie } })
    assert.equal(result.status, 403, summary(result))
  }

  const transferred = await den.as(owner, orgId)("POST", `/v1/members/${successor.memberId}/transfer-ownership`)
  assert.equal(transferred.status, 200, summary(transferred))
  // Ownership changes revoke affected sessions; prove access with fresh genuine
  // sessions rather than mistaking that independent revocation for authorization.
  for (const person of [owner, operator, successor]) {
    const refreshed = await den.signIn(person.email)
    assert.equal(refreshed.status, 200, summary(refreshed))
    person.token = text(field(refreshed.body, "token"), "refreshed token")
    person.cookie = refreshed.headers.get("set-cookie")?.split(";")[0] ?? ""
  }
  await denied(successor, orgId, 403)
  assert.equal(await hint(successor, orgId), false, "transferred ownership is not installation authority")
  assert.equal(await hint(owner, orgId), true, "operator authority is independent of former ownership")
  assert.equal((await den.as(owner, orgId)("GET", paths[0])).status, 200)

  assert.equal((await rollout({ killed: true })).status, 200)
  await denied(owner, orgId, 404)
  const killedOrg = await den.as(owner, orgId)("GET", "/v1/org")
  assert.equal(field(killedOrg.body, "deploymentCapabilities", "serviceReadiness"), undefined)
  assert.equal(field(killedOrg.body, "canManageDeploymentServices"), false, "kill switch withdraws Settings capability")
  assert.equal((await rollout({ killed: false })).status, 200)
  assert.equal(await hint(owner, orgId), true, "restoring rollout restores only the operator's capability")

  const foreign = await den.createOrg(await den.signUp("Foreign Services Owner"), "Foreign services org")
  await denied(operator, foreign.orgId, 404)
  const removed = await den.as(successor, orgId)("DELETE", `/v1/members/${owner.memberId}`)
  assert.equal(removed.status, 204, summary(removed))
  const removedSignIn = await den.signIn(operator.email)
  assert.equal(removedSignIn.status, 200, summary(removedSignIn))
  operator.token = text(field(removedSignIn.body, "token"), "removed member fresh session")
  await denied(operator, orgId, 404)
  assert.equal((await den.request(operator.token, "GET", "/v1/org", { orgId })).status, 404)
})
