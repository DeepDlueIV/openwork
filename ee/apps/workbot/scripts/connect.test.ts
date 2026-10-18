import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { readConnectionResult } from "../../../packages/workbot-ui/src/connect-result.js"

test("only the same consent window, callback origin, attempt and connection may wake readiness", () => {
  const popup = {}
  const expected = { popup, callbackOrigin: "https://api.example.test", requestId: randomUUID(), id: "google-workspace" }
  const data = { type: "openwork:connection-result", requestId: expected.requestId, connectionId: expected.id, ok: true }
  const event = { source: popup, origin: expected.callbackOrigin, data }
  assert.equal(readConnectionResult(event, expected)?.ok, true)
  assert.equal(readConnectionResult({ ...event, data: { ...data, ok: false } }, expected)?.ok, false)
  assert.equal(readConnectionResult({ ...event, source: {} }, expected), null)
  assert.equal(readConnectionResult({ ...event, origin: "https://other.example.test" }, expected), null)
  assert.equal(readConnectionResult({ ...event, origin: "null" }, expected), null)
  assert.equal(readConnectionResult({ ...event, data: { ...data, requestId: randomUUID() } }, expected), null)
  assert.equal(readConnectionResult({ ...event, data: { ...data, connectionId: "other-connection" } }, expected), null)
  assert.equal(readConnectionResult({ ...event, data: { ...data, ok: "connected" } }, expected), null)
  assert.equal(readConnectionResult(event, { ...expected, popup: null }), null)
  assert.equal(readConnectionResult(event, { ...expected, callbackOrigin: null }), null)
})
