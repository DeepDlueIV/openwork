import assert from "node:assert/strict"
import { test } from "node:test"
import { MODEL_PROBE_OUTPUT_TOKENS } from "../src/model-probe.js"
import { modelProbeFixture, type ProbeFixtureMode } from "./model-probe-fixture.js"

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value))
  return value
}

for (const protocol of ["openai", "anthropic"]) {
  test(`${protocol}: only a real bounded synthetic completion can report answered, without creating a chat`, async () => {
    const fixture = await modelProbeFixture({ protocol: protocol === "openai" ? "openai" : "anthropic" })
    try {
      const call = (body: unknown, auth = true) => fixture.app.request("/v1/model-probe", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${"r".repeat(32)}` } : {}) }, body: JSON.stringify(body) })
      assert.equal((await call({ model: "gateway/luna" }, false)).status, 401)
      assert.equal((await call({ model: "gateway/luna", prompt: "member content", apiKey: "untrusted" })).status, 400)
      assert.equal(fixture.calls().length, 0)
      const catalog = await fixture.app.request("/v1/models", { headers: { authorization: `Bearer ${"r".repeat(32)}` } })
      assert.equal(record(await catalog.json()).verified, true)
      assert.equal(fixture.calls().length, 0, "listing a model is not a completion")
      const response = await call({ model: "gateway/luna" })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.deepEqual(result, { status: "answered", errorCode: null, requestedModel: "gateway/luna", reportedModel: "gpt-6-luna-fixture-snapshot" })
      const wire = fixture.calls()
      assert.equal(wire.length, 1)
      assert.equal(wire[0]?.authorized, true)
      const body = record(wire[0]?.body)
      assert.equal(body.model, "gateway/luna", "the requested alias wins over the runner's unrelated configured default")
      assert.equal(body[protocol === "openai" ? "max_completion_tokens" : "max_tokens"], MODEL_PROBE_OUTPUT_TOKENS)
      assert.equal(body.tools, undefined)
      for (const absent of ["member content", "MCP", "memory/", "attachments", "files"]) assert.ok(!JSON.stringify(body).includes(absent))
      for (const absent of ["READY", "fixture-model-key", "fixture-answer", "provider-detail"]) assert.ok(!JSON.stringify(result).includes(absent))
      assert.equal(fixture.sessionCount(), 0)
    } finally { await fixture.close() }
  })
}

test("catalog-listed models that reject completion never report answered or expose provider details", async () => {
  const fixture = await modelProbeFixture()
  const scenarios: { mode: ProbeFixtureMode; errorCode: string }[] = [
    { mode: "unauthorized", errorCode: "authentication_failed" },
    { mode: "payment_required", errorCode: "payment_required" },
    { mode: "unavailable", errorCode: "provider_unavailable" },
    { mode: "empty", errorCode: "invalid_response" },
    { mode: "timeout", errorCode: "timed_out" },
  ]
  try {
    for (const { mode, errorCode } of scenarios) {
      fixture.setMode(mode)
      const before = fixture.calls().length
      const started = Date.now()
      const response = await fixture.app.request("/v1/model-probe", { method: "POST", headers: { authorization: `Bearer ${"r".repeat(32)}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gateway/luna" }) })
      const result = await response.json()
      assert.deepEqual(result, { status: "failed", errorCode, requestedModel: "gateway/luna", reportedModel: null })
      assert.ok(fixture.calls().length - before <= 3, "the real adapter makes at most three bounded attempts")
      assert.ok(Date.now() - started < 10_000, "the synthetic diagnostic has a short hard deadline")
      assert.ok(!JSON.stringify(result).includes("fixture-private"))
      assert.ok(!JSON.stringify(result).includes("fixture-model-key"))
    }
    assert.equal(fixture.sessionCount(), 0)
  } finally { await fixture.close() }
})
