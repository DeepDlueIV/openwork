import assert from "node:assert/strict"
import { after, test } from "node:test"
import { OrganizationFeatureTable, FeatureRolloutTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, startFakeHttpServer, summary } from "./harness.js"

let reachable = true
let verified = true
let luna = true
const runner = await startFakeHttpServer((request, _body, response) => {
  if (!reachable || request.url !== "/v1/models") { response.writeHead(503).end(); return }
  assert.equal(request.headers.authorization, `Bearer ${"r".repeat(32)}`)
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ defaultModel: "gateway/other", verified, models: [
    { id: "gateway/other", name: "Another model" },
    ...(luna ? [{ id: "gateway/luna", name: "GPT-6 Luna" }] : []),
  ] }))
})
const den = await bootDen({ env: { DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_WORKBOT: "false", DEN_FEATURE_WORKBOT_LUNA_DEFAULT: "false", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) } })
after(async () => { await den.close(); await runner.close() })

test("guided navigation still requires both remaining rollouts after Workbot becomes generally available", async () => {
  const workspace = await den.createOrg(await den.signUp("Navigation Owner"), "Navigation workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const session = async () => {
    const result = await den.request(token, "GET", "/v1/workbot/session")
    assert.equal(result.status, 200, summary(result))
    assert.equal(field(result.body, "enabled"), true)
    return result.body
  }
  for (const [assistant, navigation] of [[false, false], [false, true], [true, false], [true, true]]) {
    const assistantChanged = await den.setFeature(workspace.orgId, "workbotWorkspaceAssistant", assistant)
    assert.equal(assistantChanged.status, 200, summary(assistantChanged))
    const navigationChanged = await den.setFeature(workspace.orgId, "workbotGuidedNavigation", navigation)
    assert.equal(navigationChanged.status, 200, summary(navigationChanged))
    const body = await session()
    assert.equal(field(body, "workspaceAssistant"), assistant)
    assert.equal(field(body, "guidedNavigation"), assistant && navigation)
  }
})

test("an owner always sees explicit Luna readiness and keeps an isolated organization model choice", async () => {
  const workspace = await den.createOrg(await den.signUp("Workspace Owner"), "Model workspace")
  const other = await den.createOrg(await den.signUp("Another Owner"), "Another workspace")
  const call = den.as(workspace.owner, workspace.orgId)
  const path = "/v1/org/workbot-settings"
  // Old database rows, operator locks and kill switches must not hide GA behavior on self-hosted installs.
  const { db } = await import("../../src/db.js")
  for (const feature_key of ["workbot", "workbotLunaDefault", "permissions"]) {
    await db.insert(FeatureRolloutTable).values({ feature_key, enabled: false, killed: true })
    await db.insert(OrganizationFeatureTable).values({ organization_id: normalizeDenTypeId("organization", workspace.orgId), feature_key, enabled: false, source: "platform" })
  }
  const ready = await call("GET", path)
  assert.equal(ready.status, 200, summary(ready))
  assert.equal(field(ready.body, "defaultModel"), "gateway/luna")
  assert.equal(field(ready.body, "defaultReadiness"), "available")
  assert.equal(field(ready.body, "model"), null)
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const session = () => den.request(token, "GET", "/v1/workbot/session")
  const initialSession = await session()
  assert.equal(initialSession.status, 200, summary(initialSession))
  assert.equal(field(initialSession.body, "model"), "gateway/luna")
  assert.equal(field(initialSession.body, "verifyModel"), true)

  const saved = await call("PUT", path, { model: "gateway/other" })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "model"), "gateway/other")
  assert.equal(field((await session()).body, "model"), "gateway/other")
  assert.equal((await den.as(other.owner, workspace.orgId)("GET", path)).status, 404)
  assert.equal((await den.as(other.owner, workspace.orgId)("PUT", path, { model: "gateway/luna" })).status, 404)
  assert.equal(field((await call("GET", path)).body, "model"), "gateway/other")
  const otherSettings = await den.as(other.owner, other.orgId)("GET", path)
  assert.equal(field(otherSettings.body, "model"), null)
  assert.equal(field(otherSettings.body, "defaultModel"), "gateway/luna")
  const otherToken = await den.mintMcpToken(other.owner, other.orgId)
  assert.equal(field((await den.request(otherToken, "GET", "/v1/workbot/session")).body, "model"), "gateway/luna")

  luna = false
  const missing = await call("GET", path)
  assert.equal(field(missing.body, "defaultReadiness"), "unavailable")
  assert.equal(field(missing.body, "defaultModel"), "openai/gpt-6-luna")
  assert.equal(field(missing.body, "model"), "gateway/other")
  assert.equal(field(missing.body, "modelAvailable"), true)
  assert.equal((await call("PUT", path, { model: null })).status, 200)
  assert.equal(field((await session()).body, "model"), "openai/gpt-6-luna")
  assert.equal((await call("PUT", path, { model: "gateway/other" })).status, 200)
  verified = false
  assert.equal(field((await call("GET", path)).body, "defaultReadiness"), "unverified")
  assert.equal((await call("PUT", path, { model: "gateway/other" })).status, 503)
  reachable = false
  const offline = await call("GET", path)
  assert.equal(field(offline.body, "defaultReadiness"), "unverified")
  assert.equal(field(offline.body, "runnerReachable"), false)

  const stillAvailable = await call("GET", path)
  assert.equal(stillAvailable.status, 200, summary(stillAvailable))
  assert.equal(field(stillAvailable.body, "defaultReadiness"), "unverified")
  assert.equal(field(stillAvailable.body, "model"), "gateway/other")
  assert.equal(field((await session()).body, "verifyModel"), true)
})
