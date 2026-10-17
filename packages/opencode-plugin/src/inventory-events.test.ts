import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { SseParser, subscribeInventory, subscribeSharedInventory } from "./inventory-events.ts"

const session = { apiBaseUrl: "https://den.example", token: "secret-session", orgId: "org_one" }

test("SSE frames tolerate split CRLF, comments, multiline data, unknown fields and UTF-8 chunk boundaries", () => {
  const events: { event: string; data: string }[] = []
  const parser = new SseParser(event => events.push(event))
  const decoder = new TextDecoder()
  const bytes = new TextEncoder().encode(": heartbeat\r\nevent: inventory.changed\r\ndata: {\"revision\":\"é\"}\r\ndata: second\r\nignored: value\r\n\r\n")
  for (const byte of bytes) parser.push(decoder.decode(Uint8Array.of(byte), { stream: true }))
  assert.deepEqual(events, [{ event: "inventory.changed", data: '{"revision":"é"}\nsecond' }])
  assert.throws(() => parser.push("x".repeat(1024 * 1024 + 1)), /too large/)
})

test("subscription reconciles each connection and event, re-resolves session, and cancels the reader", async () => {
  const controller = new AbortController()
  let calls = 0
  let resolved = 0
  let changes = 0
  let cancelled = false
  const headers: Headers[] = []
  const promise = subscribeInventory({
    signal: controller.signal, retryMs: 1,
    session: async () => ({ ...session, token: `token-${++resolved}` }),
    changed: () => { changes++ },
    fetch: async (_url, init) => {
      calls++
      headers.push(new Headers(init?.headers))
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("event: inventory.changed\ndata: {\"revision\":\"1\"}\n\n"))
          if (calls === 1) stream.close()
        },
        cancel() { cancelled = true },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  for (let i = 0; i < 100 && calls < 2; i++) await delay(2)
  assert.equal(calls, 2)
  assert.equal(changes, 4)
  assert.equal(headers[0]?.get("authorization"), "Bearer token-1")
  assert.equal(headers[1]?.get("authorization"), "Bearer token-2")
  assert.equal(headers[1]?.get("x-openwork-org-id"), session.orgId)
  controller.abort()
  await promise
  assert.equal(cancelled, true)
})

test("a silent stream times out, reconnects, and stops retrying after cancellation", async () => {
  const controller = new AbortController()
  let connections = 0
  const promise = subscribeInventory({
    signal: controller.signal, heartbeatMs: 5, retryMs: 1,
    session: async () => session,
    changed: () => { connections++ },
    fetch: async () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
  })
  for (let i = 0; i < 100 && connections < 2; i++) await delay(2)
  assert.ok(connections >= 2)
  controller.abort()
  await promise
  const stoppedAt = connections
  await delay(10)
  assert.equal(connections, stoppedAt)
})

for (const status of [401, 403]) {
  test(`stream ${status} explicitly reports revoked authorization without a generic changed event or retry`, async () => {
    let revoked = 0
    let calls = 0
    await subscribeInventory({
      signal: new AbortController().signal,
      session: async () => session,
      changed: () => assert.fail("auth failure must not look like an inventory change"),
      unauthorized: () => { revoked++ },
      fetch: async () => { calls++; return Response.json({ error: "denied" }, { status }) },
    })
    assert.equal(calls, 1)
    assert.equal(revoked, 1)
  })
}

test("a killed shared session remains terminal when another Location joins", async () => {
  const controllers = Array.from({ length: 5 }, () => new AbortController())
  let calls = 0
  const options = {
    identity: session,
    session: async () => session,
    changed: () => assert.fail("disabled stream must not publish"),
    fetch: async () => { calls++; return new Response(null, { status: 404 }) },
  }
  const first = subscribeSharedInventory({ ...options, signal: controllers[0]!.signal })
  await delay(5)
  const rest = controllers.slice(1).map(controller => subscribeSharedInventory({ ...options, signal: controller.signal }))
  await delay(5)
  assert.equal(calls, 1)
  for (const controller of controllers) controller.abort()
  await Promise.all([first, ...rest])
})

test("feature-disabled 404 is terminal, not a reconnect loop", async () => {
  let calls = 0
  await subscribeInventory({
    signal: new AbortController().signal, retryMs: 1,
    session: async () => session,
    changed: () => assert.fail("disabled stream must not publish"),
    fetch: async () => { calls++; return new Response('{"code":"feature_disabled"}', { status: 404 }) },
  })
  assert.equal(calls, 1)
})
