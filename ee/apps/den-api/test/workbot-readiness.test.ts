import assert from "node:assert/strict"
import { test } from "node:test"
import { WORKBOT_DEFAULT_MODEL_ID, workbotLunaAlias } from "@openwork/types/den/workbot-settings"
import { explicitWorkbotModel, workbotDefaultReadiness } from "../src/workbot/readiness.js"

const catalog = { defaultModel: "gateway/other", verified: true, models: [
  { id: "gateway/other", name: "Another model" },
  { id: "gateway/luna", name: "GPT-6 Luna" },
] }

test("no organization choice resolves the exact Luna alias, not the configured runner default", () => {
  assert.equal(explicitWorkbotModel(null, catalog), "gateway/luna")
  assert.equal(workbotDefaultReadiness(catalog), "available")
  assert.equal(explicitWorkbotModel("gateway/custom", catalog), "gateway/custom")
  assert.equal(explicitWorkbotModel("gateway/removed", catalog), "gateway/removed")
})

test("an unavailable or unverified Luna never resolves to a different provider", () => {
  const unavailable = { ...catalog, models: catalog.models.slice(0, 1) }
  assert.equal(explicitWorkbotModel(null, unavailable), WORKBOT_DEFAULT_MODEL_ID)
  assert.equal(workbotDefaultReadiness(unavailable), "unavailable")
  for (const unknown of [null, { ...catalog, verified: false }, { defaultModel: catalog.defaultModel, models: catalog.models }]) {
    assert.equal(workbotDefaultReadiness(unknown), "unverified")
  }
  assert.equal(explicitWorkbotModel(null, null), WORKBOT_DEFAULT_MODEL_ID)
})

test("ambiguous aliases and similar model names cannot silently pick a provider", () => {
  assert.equal(workbotLunaAlias({ ...catalog, models: [{ id: "gateway/lookalike", name: "GPT-6 Luna Fast" }] }), null)
  const ambiguous = { ...catalog, models: [...catalog.models, { id: "gateway/second", name: "GPT-6 Luna" }] }
  assert.equal(workbotLunaAlias(ambiguous), null)
  assert.equal(workbotLunaAlias({ ...ambiguous, defaultModel: "gateway/luna" }), "gateway/luna")
})
