import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { anthropicModel, ModelError, openAIModel, type ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"
import { type WorkbotTurnFact } from "../src/workbot-telemetry.js"

const limits = { maxConcurrentTurns: 2, maxSteps: 2, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 10_000 }
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const sessionId = `hs_wb_${"a".repeat(40)}`

function setup(model: ModelClient, failTelemetry = false) {
  const directory = mkdtempSync(join(tmpdir(), "workbot-telemetry-"))
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  store.putSession(sessionId, {})
  const facts: WorkbotTurnFact[] = []
  const runner = new Runner({ store, model, defaultModel: "configured-default", defaultModelApiKey: "test-key", limits,
    // No SessionEvents, browser stream or host relay exists in this world.
    workbotTelemetry: async (fact, token) => {
      assert.equal(token, "member-token")
      facts.push(fact)
      if (failTelemetry) throw new Error("offline")
    },
  })
  return { store, runner, facts, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test("a greeting completes with its answering model when the browser is closed; duplicate sends are not new firsts", async () => {
  const world = setup({ complete: async () => ({ text: "private greeting body", model: "actual-answer-model", toolCalls: [], usage }) })
  try {
    const input = { sessionId, messageId: "wb_hello", prompt: "private greeting prompt", credentials: { mcpToken: "member-token" } }
    assert.equal(world.runner.send(input).ok, true)
    await world.runner.idle()
    assert.equal(world.runner.send(input).ok, true)
    await world.runner.idle()
    assert.deepEqual(world.facts.map((fact) => fact.event), ["accepted", "completed"])
    const outcome = world.facts[1]
    assert.ok(outcome.event === "completed")
    assert.equal(outcome.model, "actual-answer-model")
    assert.equal(outcome.modelSource, "response")
    assert.equal(JSON.stringify(world.facts).includes("private greeting"), false)
  } finally { world.close() }
})

test("greeting failures record codes without text, and telemetry failure never fails a turn", async () => {
  const world = setup({ complete: async () => { throw new Error("private provider details") } }, true)
  try {
    world.runner.send({ sessionId, messageId: "wb_hello", prompt: "private prompt", credentials: { mcpToken: "member-token" } })
    await world.runner.idle()
    assert.equal(world.store.getTurn(sessionId, "wb_hello")?.status, "failed")
    const outcome = world.facts.find((fact) => fact.event === "failed")
    assert.ok(outcome?.event === "failed")
    assert.equal(outcome.errorCode, "runner_error")
    assert.equal(JSON.stringify(world.facts).includes("private"), false)
  } finally { world.close() }
  const successful = setup({ complete: async () => ({ text: "answer", toolCalls: [], usage }) }, true)
  try {
    successful.runner.send({ sessionId, messageId: "wb_message0001", prompt: "[OpenWork visible context v1]\nprivate context", credentials: { mcpToken: "member-token", readOnly: true } })
    await successful.runner.idle()
    assert.equal(successful.store.getTurn(sessionId, "wb_message0001")?.status, "completed")
    const first = successful.facts[0]
    assert.ok(first.event === "accepted")
    assert.equal(first.hasContext, true)
    assert.equal(first.attachmentCount, 0)
    successful.runner.send({ sessionId, messageId: "wb_message0002", prompt: "[OpenWork visible context v1]\njust typed text", credentials: { mcpToken: "member-token" } })
    await successful.runner.idle()
    const ordinary = successful.facts.find((fact) => fact.event === "accepted" && fact.messageId === "wb_message0002")
    assert.ok(ordinary?.event === "accepted")
    assert.equal(ordinary.hasContext, false, "typed text cannot impersonate server-supplied context metadata")
  } finally { successful.close() }
})

test("provider-defined error slugs are bucketed, not copied into telemetry", async () => {
  const world = setup({ complete: async () => { throw new ModelError("model_stream_private_marker_must_not_be_recorded", "private provider details", false) } })
  try {
    world.runner.send({ sessionId, messageId: "wb_hello", prompt: "private prompt", credentials: { mcpToken: "member-token" } })
    await world.runner.idle()
    const outcome = world.facts.find((fact) => fact.event === "failed")
    assert.ok(outcome?.event === "failed")
    assert.equal(outcome.errorCode, "model_stream_error")
    assert.equal(JSON.stringify(world.facts).includes("private_marker"), false)
  } finally { world.close() }
})

test("a provider cannot reflect the model key into model telemetry", async () => {
  const world = setup({ complete: async () => ({ text: "answer", model: "test-key", toolCalls: [], usage }) })
  try {
    world.runner.send({ sessionId, messageId: "wb_hello", prompt: "private prompt", credentials: { mcpToken: "member-token" } })
    await world.runner.idle()
    const outcome = world.facts.find((fact) => fact.event === "completed")
    assert.ok(outcome?.event === "completed")
    assert.equal(outcome.model, "unreported")
    assert.notEqual(outcome.modelSource, "response")
    assert.equal(JSON.stringify(world.facts).includes("test-key"), false)
  } finally { world.close() }
})

test("model adapters keep the provider-reported model for both protocols and streams", async () => {
  for (const stream of [false, true]) {
    const request = { system: "test", messages: [], tools: [], model: "requested-alias", apiKey: "test-key", signal: new AbortController().signal, ...(stream ? { onText: () => undefined } : {}) }
    const openAI = openAIModel({ baseUrl: "https://model.example.test/v1", maxOutputTokens: 256, fetch: async () => stream
      ? new Response('data: {"model":"actual-openai","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
      : Response.json({ model: "actual-openai", choices: [{ message: { content: "answer" } }] }) })
    assert.equal((await openAI.complete(request)).model, "actual-openai")
    const anthropic = anthropicModel({ baseUrl: "https://model.example.test/v1", maxOutputTokens: 256, fetch: async () => stream
      ? new Response('data: {"type":"message_start","message":{"model":"actual-anthropic","usage":{}}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
      : Response.json({ model: "actual-anthropic", content: [{ type: "text", text: "answer" }] }) })
    assert.equal((await anthropic.complete(request)).model, "actual-anthropic")
  }
})
