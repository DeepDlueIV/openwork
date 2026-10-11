import test from "node:test"
import assert from "node:assert/strict"
import { diagnoseCallerContext } from "../src/caller-context.mjs"

test("genuine provider metadata is reported by presence only, never as authorization", () => {
  const result = diagnoseCallerContext({
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "private-thread-id", turn_id: "private-turn-id" }),
    "openai/toolCallId": "private-call-id", authorization: "private-bearer-token",
  }, { CODEX_APP_TOOLS_PIPE_PATH: "/private/native/socket", CODEX_MCP_NODE_PATH: "/private/native/node" })
  assert.equal(result.hasCodexTurnMetadata, true)
  assert.equal(result.hasCallCorrelation, true)
  assert.equal(result.hasNativeAppToolsPipe, true)
  assert.match(result.message, /does not authorize/)
  const text = JSON.stringify(result)
  for (const value of ["private-thread-id", "private-turn-id", "private-call-id", "private-bearer-token", "/private/native/socket", "/private/native/node"]) assert.equal(text.includes(value), false)
})

test("absent, malformed or oversized metadata never fabricates context", () => {
  for (const metadata of [undefined, null, [], { "x-codex-turn-metadata": "invalid" }, { "x-codex-turn-metadata": "x".repeat(4097) }]) {
    const result = diagnoseCallerContext(metadata, {})
    assert.equal(result.hasCodexTurnMetadata, false)
    assert.equal(result.hasThreadCorrelation, false)
    assert.equal(result.hasTurnCorrelation, false)
    assert.equal(result.hasCallCorrelation, false)
    assert.equal(result.hasNativeAppToolsPipe, false)
  }
})
