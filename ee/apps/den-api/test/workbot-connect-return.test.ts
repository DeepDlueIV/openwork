import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { workbotConnectRequestSchema, workbotOAuthReturnSchema } from "../src/workbot/connect-return-schema.js"
import { connectCallbackPage } from "../src/capability-sources/oauth-callback-page.js"

test("Workbot OAuth returns accept only bounded path-only destinations", () => {
  for (const returnPath of ["/", "/documents?chat=one#file", "/calendar"]) assert.equal(workbotConnectRequestSchema.safeParse({ requestId: randomUUID(), returnPath }).success, true)
  for (const returnPath of ["https://outside.example.test/", "//outside.example.test/", "\\outside.example.test", "/\\outside.example.test", "/\toutside", "/\nother", "documents", "/".repeat(2049)]) assert.equal(workbotConnectRequestSchema.safeParse({ requestId: randomUUID(), returnPath }).success, false, returnPath)
  assert.equal(workbotConnectRequestSchema.safeParse({ requestId: "arbitrary", returnPath: "/" }).success, false)
  assert.equal(workbotOAuthReturnSchema.safeParse({ requestId: randomUUID(), origin: "https://workbot.example.test", returnPath: "//outside.example.test" }).success, false)
})

test("popup completion sends only the finite outcome to the exact origin and safely escapes return markup", () => {
  const requestId = randomUUID()
  const page = connectCallbackPage({ ok: false, name: "Fixture <app>", message: "Provider secret must stay in this page" }, { origin: "https://workbot.example.test", returnPath: '/documents?q="<script>', requestId, connectionId: "google-workspace" })
  assert.ok(page.includes('postMessage({"type":"openwork:connection-result"'))
  assert.ok(page.includes('"https://workbot.example.test")'))
  assert.equal(page.includes('postMessage("*"'), false)
  assert.ok(page.includes('"ok":false'))
  const script = page.slice(page.indexOf("<script>"))
  assert.equal(script.includes("Provider secret"), false)
  assert.equal(script.includes("Fixture"), false)
  assert.ok(page.includes("Fixture &lt;app&gt;"))
  assert.equal(page.includes('href="https://workbot.example.test/documents?q="<script>'), false)
  assert.equal(connectCallbackPage({ ok: true, name: "Fixture" }).includes("postMessage"), false)
})
