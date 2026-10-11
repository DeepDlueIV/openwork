import assert from "node:assert/strict"
import test from "node:test"
import { unsupportedGatewayPayload } from "./payload-policy.js"

const fn = (name: string) => ({ type: "function", name, parameters: { type: "object", properties: {} } })

// Shape of a real Codex 0.162 Responses request with store:false (contents replaced).
function codexRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "gwm_example",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "thread-id",
    client_metadata: { thread_id: "thread-id", session_id: "thread-id", turn_id: "turn-id" },
    input: [
      { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "instructions" }] },
      { type: "message", id: "msg_user", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
      { type: "message", id: "msg_assistant", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ],
    tools: [
      fn("exec_command"),
      { type: "custom", name: "apply_patch" },
      { type: "namespace", name: "mcp__openwork", description: "OpenWork", tools: [fn("search_capabilities"), fn("execute_capability")] },
    ],
    tool_choice: "auto",
    ...overrides,
  }
}

test("accepts Codex inline items, client metadata and namespaces of client-executed tools", () => {
  assert.equal(unsupportedGatewayPayload(codexRequest(), "openai", "openai"), null)
})

test("still rejects hosted tools, including inside a namespace", () => {
  assert.equal(unsupportedGatewayPayload(codexRequest({ tools: [{ type: "web_search" }] }), "openai", "openai"), "resource")
  assert.equal(unsupportedGatewayPayload(codexRequest({ tools: [{ type: "namespace", name: "x", tools: [{ type: "web_search" }] }] }), "openai", "openai"), "resource")
  assert.equal(unsupportedGatewayPayload(codexRequest({ tools: [{ type: "namespace", name: "x", tools: [{ type: "namespace", name: "y", tools: [] }] }] }), "openai", "openai"), "resource")
  assert.equal(unsupportedGatewayPayload(codexRequest({ tools: [{ type: "namespace", name: "x" }] }), "openai", "openai"), "resource")
})

test("an item id without complete inline content still counts as a stored reference", () => {
  const remoteImage = { type: "message", id: "msg_1", role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }
  const fileRef = { type: "message", id: "msg_2", role: "user", content: [{ type: "input_file", file_id: "file_1" }] }
  const bare = { type: "message", id: "msg_3", role: "user" }
  for (const item of [remoteImage, fileRef, bare]) {
    assert.equal(unsupportedGatewayPayload(codexRequest({ input: [item] }), "openai", "openai"), "resource")
  }
  const inlineImage = { type: "message", id: "msg_4", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }
  assert.equal(unsupportedGatewayPayload(codexRequest({ input: [inlineImage] }), "openai", "openai"), null)
})

test("provider-state references are still rejected outside client metadata", () => {
  assert.equal(unsupportedGatewayPayload(codexRequest({ previous_response_id: "resp_1" }), "openai", "openai"), "resource")
  assert.equal(unsupportedGatewayPayload(codexRequest({ conversation: "conv_1" }), "openai", "openai"), "resource")
  assert.equal(unsupportedGatewayPayload(codexRequest({ input: [{ type: "item_reference", id: "msg_1" }] }), "openai", "openai"), "resource")
})

test("namespaces are an OpenAI shape and stay rejected for Anthropic-family providers", () => {
  const body = { model: "gwm_example", messages: [], tools: [{ type: "namespace", name: "x", tools: [fn("a")] }] }
  assert.equal(unsupportedGatewayPayload(body, "anthropic", "anthropic"), "resource")
})
