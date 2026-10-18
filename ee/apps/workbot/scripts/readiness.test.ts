import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

test("unavailable Luna blocks editing before deletion, keeps history readable, and the kill switch restores legacy sends", async () => {
  let writes = 0
  let verifyModel = true
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.setHeader("content-type", "application/json")
    if (request.url === "/v1/models") { response.end(JSON.stringify({ defaultModel: "gateway/other", verified: true, models: [{ id: "gateway/other", name: "Another model" }] })); return }
    if (request.method !== "GET") {
      writes += 1
      if (request.method === "DELETE") { response.end(JSON.stringify({ removed: [] })); return }
      if (request.method === "PUT") { response.end(JSON.stringify({ id: request.url?.split("/").at(-1) })); return }
      response.statusCode = 202; response.end(JSON.stringify({ state: "accepted" })); return
    }
    if (request.url?.startsWith("/v1/sessions/")) {
      response.end(JSON.stringify({ turns: [{ messageId: "wb_message_001", status: "completed", error: null }], messages: [{ role: "user", messageId: "wb_message_001", text: "Earlier message" }], finalAssistantText: "" })); return
    }
    response.statusCode = 404; response.end("{}")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Runner did not start")
  try {
    const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: `http://127.0.0.1:${address.port}`, WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
    const den = { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), runToken: async () => "fixture-token" }
    const auth = createAuth({ config, den })
    const app = new Hono<AppEnv>()
    registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
      const who = denSessionSchema.parse({ user: { id: "user_example", name: "Example", email: "member@example.test" }, organization: { id: "org_example", name: "Example workspace", brandAppName: null }, memberId: "member_example", enabled: true, canSchedule: false, model: "openai/gpt-6-luna", verifyModel })
      c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who })
      await next()
    } })
    const edit = () => app.request("http://localhost:3090/v1/workbot/messages/message_001/edit", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3090" }, body: JSON.stringify({ newId: "message_002", text: "Revised message" }) })
    const blocked = await edit()
    assert.equal(blocked.status, 409)
    assert.deepEqual(await blocked.json(), { error: "workbot_model_unavailable" })
    assert.equal(writes, 0, "no history deleted and no session changed")
    const history = await app.request("http://localhost:3090/v1/workbot")
    assert.equal(history.status, 200)
    assert.ok((await history.text()).includes("Earlier message"))
    assert.equal(writes, 0)
    verifyModel = false
    assert.equal((await edit()).status, 202)
    assert.equal(writes, 3, "legacy edit deletes, refreshes the session and sends as before")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
