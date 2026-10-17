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

test("stream 401 reports an invalid session without a generic changed event or retry", async () => {
  let revoked = 0
  let calls = 0
  await subscribeInventory({
    signal: new AbortController().signal,
    session: async () => session,
    changed: () => assert.fail("auth failure must not look like an inventory change"),
    unauthorized: () => { revoked++ },
    fetch: async () => { calls++; return Response.json({ error: "denied" }, { status: 401 }) },
  })
  assert.equal(calls, 1)
  assert.equal(revoked, 1)
})

for (const status of [403, 404]) {
  test(`stream ${status} organization denial clears authority and recovers with the same session on a bounded retry`, async () => {
    const controller = new AbortController()
    let revoked = 0
    let calls = 0
    let changes = 0
    let granted = false
    const promise = subscribeInventory({
      signal: controller.signal, retryMs: 20,
      session: async () => session,
      changed: () => { changes++ },
      unauthorized: () => assert.fail("organization membership loss must not invalidate the session"),
      revoked: () => { revoked++ },
      fetch: async (_url, init) => {
        calls++
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${session.token}`)
        if (!granted) return Response.json({ error: "organization_not_found" }, { status })
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
      },
    })
    await delay(5)
    assert.equal(calls, 1)
    assert.equal(revoked, 1)
    assert.equal(changes, 0)
    granted = true
    for (let i = 0; i < 100 && !changes; i++) await delay(2)
    assert.equal(calls, 2)
    assert.equal(changes, 1, "successful regrant reconciles even without an SSE event")
    controller.abort()
    await promise
    await delay(25)
    assert.equal(calls, 2, "unload stops authorization probes")
  })
}

test("a killed shared session remains terminal when another Location joins", async () => {
  const controllers = Array.from({ length: 5 }, () => new AbortController())
  let calls = 0
  const options = {
    identity: session,
    session: async () => session,
    changed: () => assert.fail("disabled stream must not publish"),
    unauthorized: () => assert.fail("kill must retain authority"),
    revoked: () => assert.fail("kill must retain authority"),
    fetch: async () => { calls++; return Response.json({ error: "feature_disabled", feature: "liveProviderSync" }, { status: 404 }) },
  }
  const first = subscribeSharedInventory({ ...options, signal: controllers[0]!.signal })
  await delay(5)
  const rest = controllers.slice(1).map(controller => subscribeSharedInventory({ ...options, signal: controller.signal }))
  await delay(5)
  assert.equal(calls, 1)
  for (const controller of controllers) controller.abort()
  await Promise.all([first, ...rest])
})

for (const body of [
  JSON.stringify({ error: "feature_disabled", feature: "liveProviderSync" }),
  JSON.stringify({ code: "feature_disabled" }),
  JSON.stringify({ error: "not_found" }),
  JSON.stringify({ code: "organization_not_found" }),
  JSON.stringify({ nested: { error: "organization_not_found" } }),
  "Not Found",
  "",
  "x".repeat(16 * 1024 + 1),
]) {
  test(`feature-disabled or unsupported 404 stays terminal without auth clearing (${body.slice(0, 70)})`, async () => {
    let calls = 0
    await subscribeInventory({
      signal: new AbortController().signal, retryMs: 1,
      session: async () => session,
      changed: () => assert.fail("disabled stream must not publish"),
      unauthorized: () => assert.fail("unsupported or killed stream must not invalidate the session"),
      revoked: () => assert.fail("only the explicit Den organization error revokes membership"),
      fetch: async () => { calls++; return new Response(body, { status: 404 }) },
    })
    assert.equal(calls, 1)
  })
}

test("a Location joining a revoked shared subscription is cleared without bypassing retry backoff", async () => {
  const controllers = [new AbortController(), new AbortController()]
  let calls = 0
  let revoked = 0
  let changes = 0
  let granted = false
  const options = {
    identity: session,
    retryMs: 40,
    session: async () => session,
    changed: () => { changes++ },
    revoked: () => { revoked++ },
    fetch: async () => {
      calls++
      return granted
        ? new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        : Response.json({ error: "organization_not_found" }, { status: 404 })
    },
  }
  const first = subscribeSharedInventory({ ...options, signal: controllers[0]!.signal })
  await delay(5)
  assert.equal(revoked, 1)
  const second = subscribeSharedInventory({ ...options, signal: controllers[1]!.signal })
  await delay(5)
  assert.equal(calls, 1)
  assert.equal(revoked, 2, "new Location receives denial, not a stale inventory changed event")
  assert.equal(changes, 0)
  granted = true
  for (let i = 0; i < 100 && changes < 2; i++) await delay(2)
  assert.equal(calls, 2)
  assert.equal(changes, 2)
  for (const controller of controllers) controller.abort()
  await Promise.all([first, second])
})
