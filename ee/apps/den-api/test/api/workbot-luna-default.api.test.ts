import assert from "node:assert/strict"
import { after, test } from "node:test"
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
const den = await bootDen({ env: { DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32) } })
after(async () => { await den.close(); await runner.close() })

test("an owner sees explicit Luna readiness, keeps an isolated organization override, and can kill the rollout", async () => {
  const workspace = await den.createOrg(await den.signUp("Workspace Owner"), "Model workspace")
  const other = await den.createOrg(await den.signUp("Another Owner"), "Another workspace")
  const call = den.as(workspace.owner, workspace.orgId)
  const path = "/v1/org/workbot-settings"
  assert.equal((await call("GET", path)).status, 404)
  assert.equal((await den.setFeature(workspace.orgId, "workbot", true)).status, 200)
  const legacy = await call("GET", path)
  assert.equal(legacy.status, 200, summary(legacy))
  assert.equal(field(legacy.body, "defaultReadiness"), undefined)
  assert.equal(field(legacy.body, "defaultModel"), "gateway/other")
  assert.equal((await den.setFeature(workspace.orgId, "workbotLunaDefault", true)).status, 200)
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
  assert.equal((await den.setFeature(other.orgId, "workbot", true)).status, 200)
  assert.equal((await den.setFeature(other.orgId, "workbotLunaDefault", true)).status, 200)
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

  assert.equal((await den.setFeature(workspace.orgId, "workbotLunaDefault", false)).status, 200)
  const killed = await call("GET", path)
  assert.equal(field(killed.body, "defaultReadiness"), undefined)
  assert.equal(field(killed.body, "model"), "gateway/other")
  const killedSession = await session()
  assert.equal(field(killedSession.body, "verifyModel"), undefined)
  assert.equal(field(killedSession.body, "model"), "gateway/other")
})
