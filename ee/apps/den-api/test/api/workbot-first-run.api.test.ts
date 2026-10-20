import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("first-sign-in presentation follows the token workspace and needs no Workbot enable action", async () => {
  const workspace = await den.createOrg(await den.signUp("Example Owner"), "First workspace")
  const other = await den.createOrg(await den.signUp("Example Member"), "Other workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const read = () => den.request(token, "GET", "/v1/workbot/session", { orgId: other.orgId })
  const before = await read()
  assert.equal(before.status, 200, summary(before))
  assert.equal(field(before.body, "firstRun"), false)
  assert.equal(field(before.body, "organization", "id"), workspace.orgId)
  assert.equal((await den.setFeature(workspace.orgId, "workbotFirstRun", true)).status, 200)
  const blocked = await read()
  assert.equal(field(blocked.body, "enabled"), true)
  assert.equal(field(blocked.body, "firstRun"), true)
  assert.equal(field(blocked.body, "canEnableWorkbot"), false, "Workbot is already generally available")
  assert.equal((await den.request(workspace.owner.token, "PUT", "/v1/admin/features/workbotFirstRun", { body: { enabled: true } })).status, 403)
  const email = `platform-admin+${den.stamp}@example.test`
  const signedIn = await den.signIn(email)
  const admin = await den.join(workspace.owner, workspace.orgId, {
    token: text(field(signedIn.body, "token"), "admin session"),
    userId: text(field(signedIn.body, "user", "id"), "admin id"),
    cookie: signedIn.headers.get("set-cookie")?.split(";")[0] ?? "",
    email, name: "Platform Admin",
  })
  const adminToken = await den.mintMcpToken(admin, workspace.orgId)
  const adminRecovery = await den.request(adminToken, "GET", "/v1/workbot/session")
  assert.equal(adminRecovery.status, 200, summary(adminRecovery))
  assert.equal(field(adminRecovery.body, "canEnableWorkbot"), false)
  const enabled = await read()
  assert.equal(field(enabled.body, "enabled"), true)
  assert.equal(field(enabled.body, "canEnableWorkbot"), false)
  assert.equal((await den.setFeature(workspace.orgId, "workbotFirstRun", false)).status, 200)
  assert.equal(field((await read()).body, "firstRun"), false)
  assert.equal((await den.request(null, "GET", "/v1/workbot/session")).status, 401)
})
