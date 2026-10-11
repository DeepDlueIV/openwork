import test from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { createHandlers, serve } from "../src/mcp.mjs"

test("MCP initialization and tool discovery require no sign-in or native effects", async () => {
  const input = new PassThrough(); const output = new PassThrough()
  let text = ""
  output.on("data", value => { text += value })
  const handlers = { tools: [{ name: "status" }], initialize: async () => {}, close: async () => {} }
  const running = serve({ input, output, handlers })
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
  input.end()
  await running
  const responses = text.trim().split("\n").map(value => JSON.parse(value))
  assert.equal(responses[0].result.serverInfo.name, "openwork-local")
  assert.deepEqual(responses[1].result.tools, [{ name: "status" }])
})

test("provider tool-call metadata is forwarded separately from model arguments", async () => {
  const input = new PassThrough(); const output = new PassThrough()
  const calls = []
  output.resume()
  const metadata = { "x-codex-turn-metadata": "provider-context" }
  const handlers = { initialize: async () => {}, close: async () => {}, call: async (...args) => { calls.push(args); return { ok: true } } }
  const running = serve({ input, output, handlers })
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "diagnose_native_context", arguments: {}, _meta: metadata } })}\n`)
  input.end()
  await running
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [["diagnose_native_context", {}, metadata]])
  assert.equal(calls[0][3].signal.aborted, true)
})

test("MCP cancellation aborts the current native invocation before its context can be reused", async () => {
  const input = new PassThrough(); const output = new PassThrough()
  output.resume()
  let actualSignal
  const handlers = { initialize: async () => {}, close: async () => {}, call: async (_name, _args, _metadata, invocation) => {
    actualSignal = invocation.signal
    await new Promise(resolve => invocation.signal.addEventListener("abort", resolve, { once: true }))
    return { cancelled: true }
  } }
  const running = serve({ input, output, handlers })
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wait_remote_task", arguments: {} } })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`)
  input.end()
  await running
  assert.equal(actualSignal.aborted, true)
})

test("explicit enrollment gates runner startup and rejects unexpected argument keys", async () => {
  const calls = []
  const handlers = createHandlers({ setup: {
    status: async () => ({ signedIn: true, enabled: false }),
    enable: async args => { assert.equal(args.confirm, true); calls.push("enable"); return { enabled: true } },
    disable: async () => ({ enabled: false }), logout: async () => ({}),
  }, startHost: async () => { calls.push("host"); return { owned: true, close: async () => { calls.push("close") }, status: () => ({ state: "connecting" }) } } })
  await handlers.call("status")
  assert.deepEqual(calls, [])
  await assert.rejects(handlers.call("enable_remote_sessions", { directory: "/test", confirm: true, token: "must-not-be-accepted" }), /Unexpected/)
  assert.deepEqual(calls, [])
  await handlers.call("enable_remote_sessions", { directory: "/test", confirm: true })
  assert.deepEqual(calls, ["enable", "host"])
  await handlers.call("disable_remote_sessions")
  assert.deepEqual(calls, ["enable", "host", "close"])
  await handlers.close()
})

test("device login exposes only public browser details and never its credential", async () => {
  const handlers = createHandlers({ setup: {
    login: async ({ onAuthorization }) => { onAuthorization({ userCode: "ABCD-EFGH", verificationUriComplete: "https://den.example.test/device?user_code=ABCD-EFGH" }); return { token: "secret-member-token" } },
  }, startHost: async () => ({ owned: false, close: async () => {}, status: () => ({}) }) })
  const response = await handlers.call("sign_in")
  assert.equal(response.userCode, "ABCD-EFGH")
  assert.equal(JSON.stringify(response).includes("secret-member-token"), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await handlers.call("sign_in_status")).state, "signed_in")
  await handlers.close()
})
