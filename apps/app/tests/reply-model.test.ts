import { expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { replyModelLabel, replyModelProvider } from "../src/react-app/domains/session/sync/reply-model"
import { AUTO_MODEL_ID } from "../src/react-app/domains/models/model-catalog"

function reply(model: object): UIMessage {
  return { id: "reply", role: "assistant", parts: [], metadata: { opencode: { replyModel: model } } }
}

test("Auto keeps the OpenWork mark and reports the routed name once", () => {
  const message = reply({ requestedProviderID: "openwork", requestedModelID: AUTO_MODEL_ID,
    providerID: "openai", modelID: "gpt-6", name: "GPT-6", resolved: true })
  expect(replyModelLabel(message)).toBe("GPT-6")
  expect(replyModelProvider(message)).toBe("openwork")
})

test("direct provider replies use their provider mark", () => {
  const message = reply({ providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", resolved: true })
  expect(replyModelLabel(message)).toBe("Claude Sonnet")
  expect(replyModelProvider(message)).toBe("anthropic")
})

test("opaque gateway ids are neither labels nor provider monograms", () => {
  const message = reply({ providerID: "ipr_fixture", modelID: "gwm_fixture", resolved: true })
  expect(replyModelLabel(message)).toBeNull()
  expect(replyModelProvider(message)).toBeUndefined()
})

test("unresolved and missing metadata stay absent", () => {
  expect(replyModelLabel(reply({ providerID: "openai", modelID: "gpt-6" }))).toBeNull()
  expect(replyModelLabel(reply({}))).toBeNull()
})
