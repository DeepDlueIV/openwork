import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { buildCatalog, readCodexModelCache, renderCatalog } from "./catalog.ts"

const model = (id: string, name: string, upstreamModelId: string | null) => ({
  id, name, upstreamModelId, protocol: "openai_responses" as const, providerId: "ipr_a", providerName: "OpenAI", family: "openai",
})

const cached = {
  slug: "gpt-5.6-luna",
  display_name: "GPT-5.6-Luna",
  default_reasoning_level: "medium",
  context_window: 272000,
  priority: 9,
  additional_speed_tiers: ["fast"],
  service_tiers: [{ id: "priority", name: "Fast" }],
  available_access_programs: { cyber: ["standard"] },
  upgrade: { model: "gpt-6" },
  use_responses_lite: true,
  tool_mode: "code_mode_only",
}

test("copies the cached upstream entry under the gwm id without ChatGPT-only features", () => {
  const catalog = buildCatalog([model("gwm_luna", "GPT-5.6 Luna", "gpt-5.6-luna"), model("gwm_old", "GPT-5.4", "gpt-5.4"), model("gwm_x", "X", null)], [cached])
  assert.equal(catalog.models.length, 1)
  assert.deepEqual(catalog.models[0], {
    ...cached,
    slug: "gwm_luna",
    display_name: "GPT-5.6 Luna",
    priority: 0,
    upgrade: null,
    availability_nux: null,
    additional_speed_tiers: [],
    service_tiers: [],
    available_access_programs: { cyber: [] },
    use_responses_lite: false,
  })
  assert.equal(catalog.defaultEffort.get("gwm_luna"), "medium")
  assert.deepEqual(JSON.parse(renderCatalog(catalog)).models[0].slug, "gwm_luna")
})

test("a missing or unreadable Codex cache gives an empty list", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-cache-"))
  assert.deepEqual(await readCodexModelCache(home), [])
  writeFileSync(join(home, "models_cache.json"), "not json")
  assert.deepEqual(await readCodexModelCache(home), [])
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [cached, "junk"] }))
  assert.equal((await readCodexModelCache(home)).length, 1)
})
