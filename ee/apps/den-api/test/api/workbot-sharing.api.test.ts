import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable } from "@openwork-ee/den-db/schema"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("sharing stays member scoped and never turns a Workbot token into a fresh invitation session", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Sharing Owner"), "Sharing workspace")
  const member = await den.newMember(owner, orgId, "Sharing Member")
  const token = await den.mintMcpToken(member, orgId)
  assert.equal((await den.setFeature(orgId, "workbot", true)).status, 200)
  const get = () => den.request(token, "GET", "/v1/workbot/session")
  assert.deepEqual(field((await get()).body, "shareWorkbot"), { enabled: false })
  assert.equal((await den.setFeature(orgId, "workbotInvites", true)).status, 200)
  assert.deepEqual(field((await get()).body, "shareWorkbot"), { enabled: true })

  const email = `coworker+${den.stamp}@example.test`
  const body = { email, role: "member" }
  const tokenInvite = await den.request(token, "POST", "/v1/invitations", { orgId, body })
  assert.equal(tokenInvite.status, 401, summary(tokenInvite))
  const noEndpoint = await den.request(token, "POST", "/v1/workbot/invitations", { orgId, body })
  assert.ok(noEndpoint.status >= 400, summary(noEndpoint))
  const noPermission = await den.as(member, orgId)("POST", "/v1/invitations", body)
  assert.equal(noPermission.status, 403, summary(noPermission))
  assert.equal(field(noPermission.body, "requiredPermission"), "invitations.manage")

  // Arrangement changes only this throwaway database's real session timestamp.
  const { db } = await import("../../src/db.js")
  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.token, owner.token))
  const stale = await den.as(owner, orgId)("POST", "/v1/invitations", body)
  assert.equal(stale.status, 403, summary(stale))
  assert.equal(field(stale.body, "reason"), "fresh_auth_required")
  assert.equal((await den.setFeature(orgId, "workbotInvites", false)).status, 200)
  assert.deepEqual(field((await get()).body, "shareWorkbot"), { enabled: false })
  assert.equal((await den.setFeature(orgId, "workbot", false)).status, 200)
  assert.equal(field((await get()).body, "shareWorkbot"), undefined)
})
