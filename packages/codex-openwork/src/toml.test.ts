import assert from "node:assert/strict"
import { test } from "node:test"
import { PROFILE_MARKER, isManagedProfile, readProfileModel, renderProfile, tomlString, tomlStringArray } from "./toml.ts"

test("tomlString escapes quotes, backslashes, and control characters", () => {
  assert.equal(tomlString("plain"), '"plain"')
  assert.equal(tomlString('say "hi"'), '"say \\"hi\\""')
  assert.equal(tomlString("C:\\Program Files\\node.exe"), '"C:\\\\Program Files\\\\node.exe"')
  assert.equal(tomlString("a\nb\tc\rd\be\ff"), '"a\\nb\\tc\\rd\\be\\ff"')
  assert.equal(tomlString("\u0000\u001b\u007f"), '"\\u0000\\u001B\\u007F"')
  assert.equal(tomlString("ünïcødé ✓ 🚀"), '"ünïcødé ✓ 🚀"')
  assert.equal(tomlStringArray(["/a b/x.mjs", 'q"']), '["/a b/x.mjs", "q\\""]')
})

test("escaped strings round-trip through a JSON-compatible parse", () => {
  for (const value of ["/Users/o'neil/.openwork/codex-openwork/token-helper.mjs", 'x"\\y', "tab\there"]) {
    assert.equal(JSON.parse(tomlString(value)), value)
  }
})

test("renderProfile writes only supported top-level keys and the provider tables", () => {
  const text = renderProfile({
    profileName: "openwork",
    model: "gwm_gpt",
    gatewayBaseUrl: "https://gateway.example.com",
    nodePath: "/opt/node dir/bin/node",
    helperPath: '/home/me/.openwork/codex-openwork/token-helper.mjs',
  })
  assert.ok(text.startsWith(PROFILE_MARKER))
  assert.ok(isManagedProfile(text))
  assert.match(text, /^model_provider = "openwork"$/m)
  assert.match(text, /^model = "gwm_gpt"$/m)
  assert.match(text, /^web_search = "disabled"$/m)
  assert.match(text, /^\[model_providers\.openwork\]\nname = "OpenWork AI Gateway"\nbase_url = "https:\/\/gateway\.example\.com\/api\/v1"\nwire_api = "responses"$/m)
  assert.match(text, /^\[model_providers\.openwork\.auth\]$/m)
  assert.match(text, /^command = "\/opt\/node dir\/bin\/node"$/m)
  assert.match(text, /^args = \["\/home\/me\/\.openwork\/codex-openwork\/token-helper\.mjs"\]$/m)
  assert.match(text, /^timeout_ms = 5000$/m)
  assert.match(text, /^refresh_interval_ms = 300000$/m)
  // Unsupported or conflicting keys are never written.
  assert.doesNotMatch(text, /^\s*(profile|env_key|\[profiles)/m)
  assert.doesNotMatch(text, /ow_gw_/)
  assert.equal(readProfileModel(text), "gwm_gpt")
})

test("isManagedProfile and readProfileModel ignore files we did not write", () => {
  assert.equal(isManagedProfile('model = "o3"\n'), false)
  assert.equal(isManagedProfile(`\uFEFF${PROFILE_MARKER}\n`), true)
  assert.equal(readProfileModel('[x]\nmodel = "nope"\n'), null)
  assert.equal(readProfileModel('model = "gwm_a" # comment\n'), "gwm_a")
})

test("renderProfile declares the OpenWork MCP server only when asked", () => {
  const base = {
    profileName: "work",
    model: "gwm_gpt",
    gatewayBaseUrl: "https://gateway.example.com",
    nodePath: "/node",
    helperPath: "/h.mjs",
  }
  assert.doesNotMatch(renderProfile(base), /mcp_servers/)
  assert.doesNotMatch(renderProfile({ ...base, mcp: null }), /mcp_servers/)
  const text = renderProfile({ ...base, mcp: { name: "openwork", url: "https://den.example.com/mcp/agent" } })
  assert.match(text, /^\[mcp_servers\.openwork\]\nurl = "https:\/\/den\.example\.com\/mcp\/agent"$/m)
  assert.match(text, /^# {3}codex --profile work mcp login openwork$/m)
  assert.ok(isManagedProfile(text))
  assert.equal(readProfileModel(text), "gwm_gpt")
})
