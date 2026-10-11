import assert from "node:assert/strict"
import { test } from "node:test"
import {
  SettingsConflictError,
  SettingsError,
  applySetup,
  detectIndent,
  parseChanges,
  parseSettings,
  revertSettings,
  serializeSettings,
  settingsPath,
  type DesiredSettings,
} from "./settings.ts"

const desired: DesiredSettings = {
  apiKeyHelper: '"/usr/bin/node" "/home/a/.openwork/claude-openwork/token-helper.mjs"',
  env: {
    ANTHROPIC_BASE_URL: "https://gw.example.com/api/v1/providers/ipr_a",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gwm_main",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gwm_main",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gwm_fast",
  },
  model: "gwm_main",
  denyWebSearch: true,
}

test("settings path honors CLAUDE_CONFIG_DIR", () => {
  assert.equal(settingsPath({}, "/home/a"), "/home/a/.claude/settings.json")
  assert.equal(settingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/a"), "/cfg/settings.json")
})

test("parse refuses comments, invalid JSON and non-objects; blank is empty", () => {
  assert.deepEqual(parseSettings(null, "s"), {})
  assert.deepEqual(parseSettings("  \n", "s"), {})
  assert.throws(() => parseSettings('{ // hi\n "a": 1 }', "s"), SettingsError)
  assert.throws(() => parseSettings("{\"a\": 1,}", "s"), SettingsError)
  assert.throws(() => parseSettings("[]", "s"), SettingsError)
  assert.throws(() => parseSettings("\"x\"", "s"), SettingsError)
})

test("round trip on an empty file restores nothing-but-empty and flags file removal", () => {
  const { settings, changes } = applySetup({}, desired, { force: false, createdFile: true })
  assert.equal(settings.apiKeyHelper, desired.apiKeyHelper)
  assert.equal(settings.model, "gwm_main")
  assert.deepEqual(settings.env, desired.env)
  assert.deepEqual(settings.permissions, { deny: ["WebSearch"] })
  const reverted = revertSettings(settings, changes)
  assert.deepEqual(reverted.settings, {})
  assert.deepEqual(reverted.warnings, [])
  assert.equal(reverted.removeFile, true)
})

test("round trip keeps unrelated keys, their order, and previous values", () => {
  const original = {
    theme: "dark",
    model: "opus",
    env: { FOO: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "old-haiku" },
    permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] },
    hooks: {},
  }
  const snapshot = structuredClone(original)
  const { settings, changes } = applySetup(original, desired, { force: false, createdFile: false })
  assert.deepEqual(original, snapshot, "input is not mutated")
  assert.deepEqual(Object.keys(settings), ["theme", "model", "env", "permissions", "hooks", "apiKeyHelper"])
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"], deny: ["Read(.env)", "WebSearch"] })
  const reverted = revertSettings(JSON.parse(JSON.stringify(settings)), changes)
  assert.deepEqual(reverted.settings, original)
  assert.equal(serializeSettings(reverted.settings, "  "), serializeSettings(original, "  "))
  assert.equal(reverted.removeFile, false)
})

test("keeps an existing WebSearch deny and does not remove it on uninstall", () => {
  const original = { permissions: { deny: ["WebSearch"] } }
  const { settings, changes } = applySetup(original, desired, { force: false, createdFile: false })
  assert.deepEqual(changes.denyAdded, [])
  assert.deepEqual(revertSettings(settings, changes).settings, original)
})

test("user changes after setup are left alone and reported", () => {
  const { settings, changes } = applySetup({ model: "opus" }, desired, { force: false, createdFile: false })
  const edited = structuredClone(settings)
  edited.model = "gwm_other"
  const env = edited.env
  assert.ok(env && typeof env === "object" && !Array.isArray(env))
  Object.assign(env, { ANTHROPIC_BASE_URL: "https://elsewhere.example.com", EXTRA: "keep" })
  const permissions = edited.permissions
  assert.ok(permissions && typeof permissions === "object" && !Array.isArray(permissions))
  Object.assign(permissions, { deny: ["WebSearch", "Bash(rm:*)"] })
  const reverted = revertSettings(edited, changes)
  assert.equal(reverted.settings.model, "gwm_other")
  assert.deepEqual(reverted.settings.env, { ANTHROPIC_BASE_URL: "https://elsewhere.example.com", EXTRA: "keep" })
  assert.deepEqual(reverted.settings.permissions, { deny: ["Bash(rm:*)"] })
  assert.equal(reverted.settings.apiKeyHelper, undefined)
  assert.deepEqual(reverted.warnings.map((warning) => warning.split(" ")[0]).sort(), ["env.ANTHROPIC_BASE_URL", "model"])
})

test("refuses to clobber a different apiKeyHelper, base URL or competing credentials", () => {
  const cases = [
    { apiKeyHelper: "~/bin/get-key.sh" },
    { env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } },
    { env: { ANTHROPIC_AUTH_TOKEN: "sk-secret" } },
    { env: { ANTHROPIC_API_KEY: "sk-ant-secret" } },
    { env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
  ]
  for (const original of cases) {
    assert.throws(
      () => applySetup(original, desired, { force: false, createdFile: false }),
      (error: unknown) => {
        assert.ok(error instanceof SettingsConflictError)
        assert.doesNotMatch(error.message, /secret|proxy\.example|get-key/)
        assert.match(error.message, /--force/)
        return true
      },
    )
  }
})

test("--force replaces conflicts and uninstall restores them", () => {
  const original = { apiKeyHelper: "~/bin/get-key.sh", env: { ANTHROPIC_API_KEY: "sk-ant-secret", OTHER: "x" } }
  const { settings, changes } = applySetup(original, desired, { force: true, createdFile: false })
  assert.equal(settings.apiKeyHelper, desired.apiKeyHelper)
  const env = settings.env
  assert.ok(env && typeof env === "object" && !Array.isArray(env))
  assert.equal("ANTHROPIC_API_KEY" in env, false)
  const reverted = revertSettings(settings, changes)
  assert.deepEqual(reverted.settings.apiKeyHelper, original.apiKeyHelper)
  assert.deepEqual(reverted.settings.env, { OTHER: "x", ANTHROPIC_API_KEY: "sk-ant-secret" })
})

test("re-running setup keeps the original values and consented overrides", () => {
  const original = { apiKeyHelper: "~/bin/get-key.sh", model: "opus" }
  const first = applySetup(original, desired, { force: true, createdFile: false })
  const changed = { ...desired, model: "gwm_fast", apiKeyHelper: '"/opt/node" "/x/token-helper.mjs"' }
  const base = revertSettings(first.settings, first.changes).settings
  const second = applySetup(base, changed, { force: false, createdFile: false, acknowledged: first.changes.entries })
  assert.equal(second.settings.model, "gwm_fast")
  assert.deepEqual(revertSettings(second.settings, second.changes).settings, original)
})

test("refuses a non-object env or permissions", () => {
  assert.throws(() => applySetup({ env: "x" }, desired, { force: true, createdFile: false }), SettingsError)
  assert.throws(() => applySetup({ permissions: [] }, desired, { force: true, createdFile: false }), SettingsError)
  assert.throws(() => applySetup({ permissions: { deny: "WebSearch" } }, desired, { force: true, createdFile: false }), SettingsError)
  assert.doesNotThrow(() => applySetup({ permissions: [] }, { ...desired, denyWebSearch: false }, { force: false, createdFile: false }))
})

test("recorded changes survive JSON and reject garbage", () => {
  const { changes } = applySetup({ model: "opus" }, desired, { force: false, createdFile: false })
  assert.deepEqual(parseChanges(JSON.parse(JSON.stringify(changes))), changes)
  assert.equal(parseChanges({ entries: [{ path: [], before: {}, after: {} }], denyAdded: [] }), null)
  assert.equal(parseChanges(null), null)
})

test("detects indentation", () => {
  assert.equal(detectIndent('{\n    "a": 1\n}'), "    ")
  assert.equal(detectIndent('{\n\t"a": 1\n}'), "\t")
  assert.equal(detectIndent("{}"), "  ")
  assert.equal(detectIndent(null), "  ")
})
