import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())

test("real MySQL: hosted Den refuses Settings deployment services for every role, including allowlisted platform admins and spoofed deployment headers", async () => {
  const platformAdmin = await den.signUp("Hosted Services Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
  const { orgId, owner } = await den.createOrg(await den.signUp("Hosted Services Owner"), "Hosted services org")
  const member = await den.newMember(owner, orgId, "Hosted Services Member")
  const admin = await den.newMember(owner, orgId, "Hosted Services Admin", "admin")
  const allowlistedMember = await den.join(owner, orgId, platformAdmin)
  assert.equal((await den.request(platformAdmin.token, "PUT", "/v1/admin/features/serviceReadiness", { body: { enabled: true } })).status, 200)
  assert.equal((await den.request(platformAdmin.token, "PUT", `/v1/admin/organizations/${orgId}/capabilities`, { body: { capabilities: { serviceReadiness: true } } })).status, 200)
  for (const person of [owner, member, admin, allowlistedMember]) {
    const context = await den.as(person, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    assert.equal(field(context.body, "canManageDeploymentServices"), false)
    for (const path of ["/v1/org/deployment-services", "/v1/org/deployment-services/check"]) {
      const result = await den.as(person, orgId)(path.endsWith("check") ? "POST" : "GET", path, undefined, {
        "x-den-deployment": "self_hosted", "x-openwork-deployment": "self_hosted", "x-forwarded-host": "self-hosted.example.test",
      })
      assert.equal(result.status, 403, `${person.name} ${path}: ${summary(result)}`)
    }
  }
  // The original platform admin surface remains available on cloud; no widening
  // or accidental deployment restriction has been applied to adminRoute().
  assert.equal((await den.request(platformAdmin.token, "GET", "/v1/admin/services")).status, 200)
  assert.equal((await den.as(member, orgId)("GET", "/v1/org/service-readiness")).status, 200)
})
