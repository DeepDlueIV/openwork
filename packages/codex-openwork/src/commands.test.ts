import assert from "node:assert/strict"
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { readCredential, writeCredential, type GatewayInventory } from "../../agent-gateway-core/src/index.ts"
import { fakeFetch, json } from "../../agent-gateway-core/src/test-fetch.ts"
import { parseArgs } from "./args.ts"
import { main } from "./main.ts"
import { compatibleModels, incompatibleModels, keyProvider } from "./models.ts"
import {
  API,
  DEN_TOKEN,
  GATEWAY,
  GATEWAY_KEY,
  credential,
  fakeCodex,
  isMcpWrite,
  makeDeps,
  providersBody,
  tempDir,
  type RunCall,
} from "./test-support.ts"

function denRoutes() {
  return fakeFetch({
    "GET /v1/inference-providers?scope=usable": () => json(200, providersBody),
    "GET /v1/inference-providers/ipr_openai/connect": () => json(200, { inferenceProvider: { id: "ipr_openai", apiKey: GATEWAY_KEY } }),
    "GET /api/v1/models": (call) =>
      call.headers.authorization === `Bearer ${GATEWAY_KEY}`
        ? json(200, { data: [{ id: "gwm_gpt", owned_by: "openai" }, { id: "gwm_sonnet", owned_by: "anthropic" }] })
        : json(401, { error: "unauthorized" }),
    "POST /api/auth/sign-out": () => json(200, {}),
  })
}

test("parses commands and options and rejects typos", () => {
  const parsed = parseArgs(["setup", "--model", "gwm_a", "--profile=work", "--yes", "--no-mcp"])
  assert.equal(parsed.command, "setup")
  assert.equal(parsed.values.get("model"), "gwm_a")
  assert.equal(parsed.values.get("profile"), "work")
  assert.ok(parsed.switches.has("yes") && parsed.switches.has("no-mcp"))
  assert.throws(() => parseArgs(["setup", "--modle", "x"]), /Unknown option --modle/)
  assert.throws(() => parseArgs(["setup", "--model"]), /needs a value/)
})

test("only OpenAI Responses models are offered to Codex", () => {
  const inventory: GatewayInventory = { gatewayBaseUrl: GATEWAY, providers: [
    { id: "ipr_openai", name: "OpenAI", family: "openai", protocol: "openai_responses", models: [{ id: "gwm_gpt", name: "GPT", upstreamModelId: null }] },
    { id: "ipr_claude", name: "Anthropic", family: "anthropic", protocol: "anthropic_messages", models: [{ id: "gwm_sonnet", name: "Sonnet", upstreamModelId: null }] },
    { id: "ipr_gemini", name: "Gemini", family: "google", protocol: "other", models: [{ id: "gwm_gemini", name: "Gemini", upstreamModelId: null }] },
  ] }
  assert.deepEqual(compatibleModels(inventory).map((entry) => entry.id), ["gwm_gpt"])
  assert.deepEqual(incompatibleModels(inventory).map((entry) => entry.id), ["gwm_sonnet", "gwm_gemini"])
  assert.equal(keyProvider(inventory)?.id, "ipr_openai")
})

function backups(files: readonly string[]): string[] {
  return files.filter((name) => name.includes(".openwork-backup-"))
}

function assertNoMcpWrites(calls: readonly RunCall[]): void {
  for (const call of calls) assert.ok(!isMcpWrite(call.args), `unexpected config write: ${call.args.join(" ")}`)
}

test("setup --yes --model writes the profile with the MCP server and the helper, never touching config.toml", async () => {
  const dir = await tempDir()
  try {
    const { fetch, calls } = denRoutes()
    const codexDir = join(dir.path, "codex")
    const codex = fakeCodex([], { codexHome: codexDir })
    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    const state = join(dir.path, "state")
    await writeCredential(state, credential())

    const code = await main(["setup", "--yes", "--model", "gwm_mini"], deps)
    assert.equal(code, 0, deps.stderr.text)

    const profile = await readFile(join(codexDir, "openwork.config.toml"), "utf8")
    assert.match(profile, /^# Managed by codex-openwork/)
    assert.match(profile, /^model = "gwm_mini"$/m)
    assert.match(profile, new RegExp(`^base_url = "${GATEWAY.replace(/[./]/g, "\\$&")}/api/v1"$`, "m"))
    assert.match(profile, /^command = "\/usr\/local\/bin\/node"$/m)
    assert.ok(profile.includes(`args = [${JSON.stringify(join(state, "token-helper.mjs"))}]`))
    assert.ok(profile.includes(`[mcp_servers.openwork]\nurl = "${API}/mcp/agent"`))
    assert.ok(!profile.includes(GATEWAY_KEY) && !profile.includes(DEN_TOKEN))
    assert.ok((await readdir(state)).includes("token-helper.mjs"))

    const saved = await readCredential(state)
    assert.equal(saved?.gatewayKey, GATEWAY_KEY)
    assert.equal(saved?.gatewayBaseUrl, GATEWAY)
    assert.ok(calls.some((call) => call.path === "/v1/inference-providers/ipr_openai/connect" && call.headers.authorization === `Bearer ${DEN_TOKEN}`))

    assert.ok(codex.calls.some((call) => call.args.join(" ") === "mcp list --json"), "reads the base config")
    assert.ok(codex.calls.some((call) => call.args.join(" ") === "--profile openwork mcp list --json"), "checks the profile")
    assertNoMcpWrites(codex.calls)
    assert.ok(!codex.calls.some((call) => call.args.includes("login")), "no browser sign-in without a terminal")
    assert.match(deps.stdout.text, /codex --profile openwork mcp login openwork/)
    assert.match(deps.stdout.text, /codex --profile openwork/)
    assert.ok(!deps.stdout.text.includes(GATEWAY_KEY) && !deps.stdout.text.includes(DEN_TOKEN))
    assert.ok(!deps.stderr.text.includes(GATEWAY_KEY) && !deps.stderr.text.includes(DEN_TOKEN))
  } finally {
    await dir.cleanup()
  }
})

test("setup twice with the same inputs leaves no backup files and never runs mcp add/remove", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codexDir = join(dir.path, "codex")
    const codex = fakeCodex([], { codexHome: codexDir })
    await writeCredential(join(dir.path, "state"), credential())

    const first = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["setup", "--yes", "--model", "gwm_mini"], first), 0, first.stderr.text)
    const again = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["setup", "--yes", "--model", "gwm_mini"], again), 0, again.stderr.text)
    assert.match(again.stdout.text, /already up to date/)

    // A different model rewrites our untouched file, still without a backup.
    const other = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], other), 0, other.stderr.text)
    assert.match(other.stdout.text, /Updated/)
    assert.doesNotMatch(other.stdout.text, /Previous version saved/)

    assert.deepEqual(backups(await readdir(codexDir)), [])
    assertNoMcpWrites(codex.calls)
  } finally {
    await dir.cleanup()
  }
})

test("setup inherits an OpenWork MCP server the base config already has under another name", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codexDir = join(dir.path, "codex")
    const codex = fakeCodex([{ name: "ow-gateway", url: `${API}/mcp/agent/` }], { codexHome: codexDir })
    await writeCredential(join(dir.path, "state"), credential())
    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], deps), 0, deps.stderr.text)

    const profile = await readFile(join(codexDir, "openwork.config.toml"), "utf8")
    assert.doesNotMatch(profile, /mcp_servers/)
    assert.match(deps.stdout.text, /already in your Codex setup as "ow-gateway"/)
    assert.match(deps.stdout.text, /codex --profile openwork mcp login ow-gateway/)
    assertNoMcpWrites(codex.calls)
  } finally {
    await dir.cleanup()
  }
})

test("setup leaves a different server named openwork alone and does not shadow it", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codexDir = join(dir.path, "codex")
    const codex = fakeCodex([{ name: "openwork", url: "https://elsewhere.example.com/mcp" }], { codexHome: codexDir })
    await writeCredential(join(dir.path, "state"), credential())
    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], deps), 0, deps.stderr.text)

    const profile = await readFile(join(codexDir, "openwork.config.toml"), "utf8")
    assert.doesNotMatch(profile, /mcp_servers/)
    assert.match(deps.stdout.text, /different address; it was left alone/)
    assertNoMcpWrites(codex.calls)
  } finally {
    await dir.cleanup()
  }
})

test("setup --no-mcp does not ask Codex about MCP servers or add one", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codexDir = join(dir.path, "codex")
    const codex = fakeCodex([], { codexHome: codexDir })
    await writeCredential(join(dir.path, "state"), credential())
    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["setup", "--yes", "--no-mcp", "--model", "gwm_gpt"], deps), 0, deps.stderr.text)
    assert.doesNotMatch(await readFile(join(codexDir, "openwork.config.toml"), "utf8"), /mcp_servers/)
    assert.ok(!codex.calls.some((call) => call.args.includes("mcp")))
  } finally {
    await dir.cleanup()
  }
})

test("setup without a terminal needs --model and --yes, and rejects incompatible models", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    await writeCredential(join(dir.path, "state"), credential())

    const noModel = makeDeps(dir.path, { fetch })
    assert.equal(await main(["setup", "--yes"], noModel), 1)
    assert.match(noModel.stderr.text, /--model/)
    assert.match(noModel.stderr.text, /gwm_gpt/)
    assert.match(noModel.stderr.text, /gwm_mini/)
    assert.doesNotMatch(noModel.stderr.text, /gwm_sonnet/)

    const wrong = makeDeps(dir.path, { fetch })
    assert.equal(await main(["setup", "--yes", "--model", "gwm_sonnet"], wrong), 1)
    assert.match(wrong.stderr.text, /cannot talk to/)

    const noYes = makeDeps(dir.path, { fetch })
    assert.equal(await main(["setup", "--model", "gwm_gpt"], noYes), 1)
    assert.match(noYes.stderr.text, /--yes/)
    await assert.rejects(readFile(join(dir.path, "codex", "openwork.config.toml"), "utf8"))
  } finally {
    await dir.cleanup()
  }
})

test("setup refuses to replace a profile it did not write", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    await writeCredential(join(dir.path, "state"), credential())
    await mkdir(join(dir.path, "codex"), { recursive: true })
    const path = join(dir.path, "codex", "openwork.config.toml")
    await writeFile(path, 'model = "o3"\n')
    const deps = makeDeps(dir.path, { fetch })
    assert.equal(await main(["setup", "--yes", "--no-mcp", "--model", "gwm_gpt"], deps), 1)
    assert.match(deps.stderr.text, /--force/)
    assert.equal(await readFile(path, "utf8"), 'model = "o3"\n')
  } finally {
    await dir.cleanup()
  }
})

test("setup requires sign-in", async () => {
  const dir = await tempDir()
  try {
    const deps = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main(["setup", "--yes"], deps), 1)
    assert.match(deps.stderr.text, /not signed in.*login/)
  } finally {
    await dir.cleanup()
  }
})

test("status reports the setup through the profile without showing secrets", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codex = fakeCodex([], { codexHome: join(dir.path, "codex"), profileAuth: "o_auth" })
    await writeCredential(join(dir.path, "state"), credential())
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], makeDeps(dir.path, { fetch, run: codex.run })), 0)

    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["status"], deps), 0)
    const out = deps.stdout.text
    assert.match(out, /member@example\.com/)
    assert.match(out, /Organization: Acme/)
    assert.match(out, /AI Gateway: reachable .*\(1 Codex model\(s\)\)/)
    assert.match(out, /model gwm_gpt/)
    assert.match(out, /OpenWork MCP: available as "openwork", signed in/)
    assert.equal(codex.calls.at(-1)?.args.join(" "), "--profile openwork mcp list --json")
    assert.ok(!out.includes(GATEWAY_KEY) && !out.includes(DEN_TOKEN))
    assert.ok(!deps.stderr.text.includes(GATEWAY_KEY))
    assertNoMcpWrites(codex.calls)
  } finally {
    await dir.cleanup()
  }
})

test("status shows how to sign in to the MCP server through the profile", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codex = fakeCodex([], { codexHome: join(dir.path, "codex") })
    await writeCredential(join(dir.path, "state"), credential())
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], makeDeps(dir.path, { fetch, run: codex.run })), 0)

    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["status"], deps), 0)
    assert.match(deps.stdout.text, /OpenWork MCP: available as "openwork" \(sign in with: codex --profile openwork mcp login openwork\)/)
  } finally {
    await dir.cleanup()
  }
})

test("status when nothing is set up", async () => {
  const dir = await tempDir()
  try {
    const deps = makeDeps(dir.path, { fetch: denRoutes().fetch, run: async () => ({ code: null, stdout: "", stderr: "", notFound: true }) })
    assert.equal(await main(["status"], deps), 0)
    assert.match(deps.stdout.text, /not signed in/)
    assert.match(deps.stdout.text, /Codex profile: not set up/)
    assert.match(deps.stdout.text, /Codex CLI not found/)
  } finally {
    await dir.cleanup()
  }
})

test("models lists compatible models, and --all marks the rest", async () => {
  const dir = await tempDir()
  try {
    await writeCredential(join(dir.path, "state"), credential())
    const deps = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main(["models", "--all"], deps), 0)
    assert.match(deps.stdout.text, /gwm_gpt {2}\(GPT-5, OpenAI\)/)
    assert.match(deps.stdout.text, /gwm_sonnet .*\[not compatible\]/)
  } finally {
    await dir.cleanup()
  }
})

test("token prints only the key, and fails without one", async () => {
  const dir = await tempDir()
  try {
    const state = join(dir.path, "state")
    const missing = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main(["token"], missing), 1)
    assert.equal(missing.stdout.text, "")

    await writeCredential(state, credential({ gatewayKey: GATEWAY_KEY, gatewayBaseUrl: GATEWAY }))
    const deps = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main(["token"], deps), 0)
    assert.equal(deps.stdout.text, GATEWAY_KEY)
  } finally {
    await dir.cleanup()
  }
})

test("uninstall removes our untouched profile without a backup and the helper, keeps the sign-in; logout removes it", async () => {
  const dir = await tempDir()
  try {
    const { fetch, calls } = denRoutes()
    const codex = fakeCodex([], { codexHome: join(dir.path, "codex") })
    const state = join(dir.path, "state")
    await writeCredential(state, credential())
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], makeDeps(dir.path, { fetch, run: codex.run })), 0)

    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["uninstall", "--yes"], deps), 0, deps.stderr.text)
    const files = await readdir(join(dir.path, "codex"))
    assert.ok(!files.includes("openwork.config.toml"))
    assert.deepEqual(backups(files), [])
    assert.doesNotMatch(deps.stdout.text, /you had edited it/)
    assert.ok(!(await readdir(state)).includes("token-helper.mjs"))
    assert.ok(await readCredential(state))
    assertNoMcpWrites(codex.calls)

    const out = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["logout"], out), 0)
    assert.equal(await readCredential(state), null)
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/api/auth/sign-out"))
    assertNoMcpWrites(codex.calls)
  } finally {
    await dir.cleanup()
  }
})

test("uninstall keeps a backup of a profile the user edited", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = denRoutes()
    const codexDir = join(dir.path, "codex")
    const codex = fakeCodex([], { codexHome: codexDir })
    await writeCredential(join(dir.path, "state"), credential())
    assert.equal(await main(["setup", "--yes", "--model", "gwm_gpt"], makeDeps(dir.path, { fetch, run: codex.run })), 0)

    const path = join(codexDir, "openwork.config.toml")
    const edited = `${await readFile(path, "utf8")}approval_policy = "never"\n`
    await writeFile(path, edited)

    const deps = makeDeps(dir.path, { fetch, run: codex.run })
    assert.equal(await main(["uninstall", "--yes"], deps), 0, deps.stderr.text)
    const files = await readdir(codexDir)
    assert.ok(!files.includes("openwork.config.toml"))
    const saved = backups(files)
    assert.equal(saved.length, 1)
    assert.equal(await readFile(join(codexDir, saved[0] ?? ""), "utf8"), edited)
    assert.match(deps.stdout.text, /you had edited it/)
    assertNoMcpWrites(codex.calls)
  } finally {
    await dir.cleanup()
  }
})

test("login shows the code, saves the sign-in and gateway key, and never prints secrets", async () => {
  const dir = await tempDir()
  try {
    const { fetch } = fakeFetch({
      "POST /api/auth/device/code": () => json(200, { device_code: "dc-secret", user_code: "ABCDEFGH", interval: 1, expires_in: 600 }),
      "POST /api/auth/device/token": () => json(200, { access_token: DEN_TOKEN, token_type: "Bearer" }),
      "GET /v1/me": () => json(200, { user: { id: "usr_1", email: "member@example.com" }, session: { activeOrganizationId: "org_1" } }),
      "GET /v1/me/orgs": () => json(200, { orgs: [{ id: "org_1", name: "Acme", isActive: true }], activeOrgId: "org_1" }),
      "GET /v1/inference-providers?scope=usable": () => json(200, providersBody),
      "GET /v1/inference-providers/ipr_openai/connect": () => json(200, { inferenceProvider: { apiKey: GATEWAY_KEY } }),
    })
    const deps = makeDeps(dir.path, { fetch, sleep: async () => undefined })
    assert.equal(await main(["login", "--api", API], deps), 0, deps.stderr.text)
    assert.match(deps.stdout.text, /device\?user_code=ABCDEFGH|user_code=ABCDEFGH/)
    assert.match(deps.stdout.text, /ABCD-EFGH/)
    assert.match(deps.stdout.text, /Signed in as member@example\.com \(Acme\)/)
    assert.match(deps.stdout.text, /2 AI Gateway model\(s\)/)
    for (const secret of [DEN_TOKEN, GATEWAY_KEY, "dc-secret"]) {
      assert.ok(!deps.stdout.text.includes(secret) && !deps.stderr.text.includes(secret))
    }
    const saved = await readCredential(join(dir.path, "state"))
    assert.equal(saved?.token, DEN_TOKEN)
    assert.equal(saved?.gatewayKey, GATEWAY_KEY)
    assert.equal(saved?.gatewayBaseUrl, GATEWAY)
  } finally {
    await dir.cleanup()
  }
})

test("help and unknown commands", async () => {
  const dir = await tempDir()
  try {
    const help = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main([], help), 0)
    assert.match(help.stdout.text, /codex --profile openwork/)
    const bad = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main(["frobnicate"], bad), 1)
    assert.match(bad.stderr.text, /Unknown command/)
    const wrongFlag = makeDeps(dir.path, { fetch: denRoutes().fetch })
    assert.equal(await main(["token", "--yes"], wrongFlag), 1)
  } finally {
    await dir.cleanup()
  }
})
