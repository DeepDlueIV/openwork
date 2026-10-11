import assert from "node:assert/strict"
import { Readable, Writable } from "node:stream"
import { test } from "node:test"
import { PromptError, type GatewayProviderSummary } from "../../agent-gateway-core/src/index.ts"
import { SelectionError, chooseModel, chooseProvider, claudeProviders } from "./select.ts"

const streams = {
  input: Readable.from([]),
  output: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
}

const a: GatewayProviderSummary = {
  id: "ipr_a",
  name: "A",
  family: "anthropic",
  protocol: "anthropic_messages",
  models: [
    { id: "gwm_1", name: "One", upstreamModelId: null },
    { id: "gwm_2", name: "Two", upstreamModelId: null },
  ],
}
const b: GatewayProviderSummary = { ...a, id: "ipr_b", name: "B", models: [{ id: "gwm_3", name: "Three", upstreamModelId: null }] }
const o: GatewayProviderSummary = { ...a, id: "ipr_o", name: "O", protocol: "openai_responses" }

test("only Anthropic Messages providers are offered", () => {
  assert.deepEqual(claudeProviders({ gatewayBaseUrl: null, providers: [a, o] }).map((provider) => provider.id), ["ipr_a"])
})

test("provider selection without a terminal", async () => {
  await assert.rejects(chooseProvider([], undefined, streams), SelectionError)
  assert.equal((await chooseProvider([a], undefined, streams)).id, "ipr_a")
  assert.equal((await chooseProvider([a, b], "ipr_b", streams)).id, "ipr_b")
  await assert.rejects(chooseProvider([a, b], undefined, streams), (error: unknown) => error instanceof PromptError && /--provider/.test(error.message))
  await assert.rejects(chooseProvider([a, b], "ipr_o", streams), /not available for Claude Code/)
})

test("model selection without a terminal", async () => {
  assert.equal((await chooseModel(b, undefined, streams)).id, "gwm_3")
  assert.equal((await chooseModel(a, "gwm_2", streams)).id, "gwm_2")
  await assert.rejects(chooseModel(a, undefined, streams), (error: unknown) => error instanceof PromptError && /--model/.test(error.message))
  await assert.rejects(chooseModel(a, "gwm_3", streams), SelectionError)
})
