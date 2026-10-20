import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const email = "ordinary-single-org-owner@example.test"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  DEN_ORG_MODE: "single_org",
  DEN_SINGLE_ORG_OWNER_EMAILS: email,
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true",
  DEN_BOOTSTRAP_ADMIN_EMAILS: "",
  DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: "",
  DEN_FEATURE_SERVICE_READINESS: "true",
} })
after(() => den.close())

test("real MySQL: ordinary single-org owner bootstrap and org admin never acquire local operator authority", async () => {
  const deployment = await den.request(null, "GET", "/v1/features")
  assert.equal(deployment.status, 200, summary(deployment))
  assert.equal(field(deployment.body, "deployment"), "self_hosted")
  assert.equal(field(deployment.body, "features", "serviceReadiness"), true, "operator lock enables the deployment gate")

  // Deliberately use ordinary signup: no /setup verification or bootstrapGrant.
  const signedUp = await den.request(null, "POST", "/api/auth/sign-up/email", { body: {
    email, name: "Ordinary Singleton Owner", password: den.password,
  } })
  assert.equal(signedUp.status, 200, summary(signedUp))
  const signedIn = await den.signIn(email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const owner: Session = {
    email, name: "Ordinary Singleton Owner",
    token: text(field(signedIn.body, "token"), "owner session token"),
    cookie: signedIn.headers.get("set-cookie")?.split(";")[0] ?? "",
    userId: text(field(signedIn.body, "user", "id"), "owner user id"),
  }
  const singleton = await den.request(owner.token, "GET", "/v1/org")
  assert.equal(singleton.status, 200, summary(singleton))
  const orgId = text(field(singleton.body, "organization", "id"), "singleton organization id")
  assert.equal(field(singleton.body, "organization", "owner", "userId"), owner.userId)
  assert.equal(field(singleton.body, "currentMember", "role"), "owner", "eligible ordinary account bootstraps the singleton owner")

  // Single-org signup joins the existing singleton; promote through the real API.
  const admin = await den.signUp("Ordinary Singleton Admin")
  const memberId = await den.memberIdOf(owner, orgId, admin.email)
  const promoted = await den.as(owner, orgId)("POST", `/v1/members/${memberId}/role`, { role: "admin" })
  assert.equal(promoted.status, 200, summary(promoted))
  const adminSignIn = await den.signIn(admin.email)
  assert.equal(adminSignIn.status, 200, summary(adminSignIn))
  admin.token = text(field(adminSignIn.body, "token"), "fresh admin session token")
  admin.cookie = adminSignIn.headers.get("set-cookie")?.split(";")[0] ?? ""

  async function denied(person: Session, role: string) {
    const context = await den.as(person, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    assert.equal(field(context.body, "organization", "id"), orgId)
    assert.equal(field(context.body, "currentMember", "role"), role)
    assert.equal(field(context.body, "features", "serviceReadiness"), true, "organization gate is enabled, not masking authority denial")
    assert.equal(field(context.body, "canManageDeploymentServices"), false, `${role} is not a local installation operator`)
    for (const path of ["/v1/org/deployment-services", "/v1/org/deployment-services/check"]) {
      const result = await den.as(person, orgId)(path.endsWith("check") ? "POST" : "GET", path)
      assert.equal(result.status, 403, `${role} ${path}: ${summary(result)}`)
      assert.equal(field(result.body, "error"), "forbidden")
    }
    const platform = await den.request(person.token, "GET", "/v1/admin/services")
    assert.equal(platform.status, 403, `${role} did not gain installation allowlist authority: ${summary(platform)}`)
  }
  await denied(owner, "owner")
  await denied(admin, "admin")
})
