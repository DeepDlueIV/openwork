import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { after, test } from "node:test"
import { writeCredential, type StoredCredential } from "../../agent-gateway-core/src/index.ts"
import { fakeFetch, json, type Route } from "../../agent-gateway-core/src/test-fetch.ts"
import { main, type CliDeps, type RunResult } from "./main.ts"

const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const NOW = 1_700_000_000_000
const DEN = "https://den.example.com"
const GATEWAY = "https://gw.example.com"
const DEN_TOKEN = "den-secret-token"
const GATEWAY_KEY = "ow_gw_secretkey123"

class Collector extends Writable {
  text = ""
  readonly isTTY: boolean
  constructor(isTTY = false) {
    super()
    this.isTTY = isTTY
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString()
    callback()
  }
}

function provider(id: string, models: string[], npm = "@ai-sdk/anthropic") {
  return {
    id,
    providerId: npm === "@ai-sdk/anthropic" ? "anthropic" : "openai",
    name: `Provider ${id}`,
    providerConfig: { npm, api: `${GATEWAY}/api/v1/providers/${id}` },
    models: models.map((model) => ({ id: model, name: model.toUpperCase(), upstreamModelId: null })),
  }
}

const inventoryOne = { inferenceProviders: [provider("ipr_a", ["gwm_main", "gwm_fast"]), provider("ipr_o", ["gwm_gpt"], "@ai-sdk/openai")] }
const inventoryTwo = { inferenceProviders: [provider("ipr_a", ["gwm_main"]), provider("ipr_b", ["gwm_b"])] }

type Routes = Record<string, Route | Route[]>

const denRoutes = (inventory: unknown): Routes => ({
  "GET /v1/inference-providers?scope=usable": () => json(200, inventory),
  "GET /v1/inference-providers/ipr_a/connect": () => json(200, { inferenceProvider: { apiKey: GATEWAY_KEY } }),
  "POST /api/auth/sign-out": () => json(200, {}),
})

interface Harness {
  readonly root: string
  readonly stateDir: string
  readonly configDir: string
  readonly settingsFile: string
  readonly commands: string[][]
  readonly run: (argv: string[], options?: { stdoutTTY?: boolean }) => Promise<{ code: number; stdout: string; stderr: string }>
}

async function harness(options: {
  routes?: Routes
  credential?: Partial<StoredCredential> | null
  mcpPresent?: boolean
  claudeMissing?: boolean
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "claude-ow-main-"))
  roots.push(root)
  const stateDir = join(root, "state")
  const configDir = join(root, "claude config")
  const commands: string[][] = []
  if (options.credential !== null) {
    await writeCredential(stateDir, {
      apiBaseUrl: DEN,
      token: DEN_TOKEN,
      orgId: "org_1",
      orgName: "Acme",
      user: { id: "u1", email: "a@example.com" },
      expiresAt: NOW + 86_400_000,
      gatewayKey: GATEWAY_KEY,
      gatewayBaseUrl: GATEWAY,
      ...options.credential,
    })
  }
  const { fetch } = fakeFetch(options.routes ?? denRoutes(inventoryOne))
  const runCommand = async (command: string, args: readonly string[]): Promise<RunResult> => {
    commands.push([command, ...args])
    if (options.claudeMissing) return { code: null, stdout: "", stderr: "", notFound: true }
    if (args[1] === "get") {
      return options.mcpPresent
        ? { code: 0, stdout: `openwork:\n  URL: ${DEN}/mcp/agent\n`, stderr: "", notFound: false }
        : { code: 1, stdout: "", stderr: "No MCP server found", notFound: false }
    }
    return { code: 0, stdout: "", stderr: "", notFound: false }
  }
  const run = async (argv: string[], runOptions: { stdoutTTY?: boolean } = {}) => {
    const stdout = new Collector(runOptions.stdoutTTY)
    const stderr = new Collector()
    const deps: CliDeps = {
      fetch,
      runCommand,
      env: { CLAUDE_OPENWORK_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: configDir },
      home: root,
      stdin: Readable.from([]),
      stdout,
      stderr,
      now: () => NOW,
      nodePath: "/opt/node js/bin/node",
      platform: "darwin",
      sleep: async () => undefined,
    }
    const code = await main(argv, deps)
    return { code, stdout: stdout.text, stderr: stderr.text }
  }
  return { root, stateDir, configDir, settingsFile: join(configDir, "settings.json"), commands, run }
}

function assertNoSecrets(text: string): void {
  assert.doesNotMatch(text, new RegExp(DEN_TOKEN))
  assert.doesNotMatch(text, new RegExp(GATEWAY_KEY))
}

test("login saves the credential and gateway key without printing secrets", async () => {
  const h = await harness({
    credential: null,
    routes: {
      ...denRoutes(inventoryOne),
      "POST /api/auth/device/code": () =>
        json(200, { device_code: "dev-secret", user_code: "ABCDEFGH", verification_uri: `${DEN}/device`, interval: 1, expires_in: 600 }),
      "POST /api/auth/device/token": [() => json(400, { error: "authorization_pending" }), () => json(200, { access_token: DEN_TOKEN })],
      "GET /v1/me": () => json(200, { user: { id: "u1", email: "a@example.com" }, session: { expiresAt: "2030-01-01T00:00:00Z", activeOrganizationId: "org_1" } }),
      "GET /v1/me/orgs": () => json(200, { orgs: [{ id: "org_1", name: "Acme", isActive: true }], activeOrgId: "org_1" }),
    },
  })
  const result = await h.run(["login", "--api", DEN])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /ABCD-EFGH/)
  assert.match(result.stdout, /Signed in as a@example.com \(Acme\)/)
  assert.match(result.stdout, /AI Gateway key saved/)
  assertNoSecrets(result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /dev-secret/)
  const saved = JSON.parse(await readFile(join(h.stateDir, "credentials.json"), "utf8"))
  assert.equal(saved.gatewayKey, GATEWAY_KEY)
  assert.equal(saved.gatewayBaseUrl, GATEWAY)
  assert.equal(h.commands.length, 0, "no browser without --open")
})

test("setup requires a sign-in", async () => {
  const h = await harness({ credential: null })
  const result = await h.run(["setup", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Not signed in/)
})

test("setup without a terminal needs --provider, valid models, and --yes", async () => {
  const two = await harness({ routes: denRoutes(inventoryTwo) })
  let result = await two.run(["setup", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--provider/)
  result = await two.run(["setup", "--provider", "ipr_zzz", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /ipr_zzz is not available.*ipr_a, ipr_b/)

  const one = await harness()
  result = await one.run(["setup", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--model/)
  result = await one.run(["setup", "--model", "gwm_gpt", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /gwm_gpt is not a model of/)
  result = await one.run(["setup", "--model", "gwm_main", "--fast-model", "gwm_nope", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--fast-model gwm_nope/)
  result = await one.run(["setup", "--model", "gwm_main"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--yes/)
  await assert.rejects(stat(one.settingsFile))
  result = await one.run(["setup", "--bogus"])
  assert.equal(result.code, 2)
})

test("setup, status, and uninstall round-trip an existing settings file", async () => {
  const h = await harness()
  await mkdir(h.configDir, { recursive: true })
  const original = `{\n    "theme": "dark",\n    "env": {\n        "FOO": "bar"\n    }\n}\n`
  await writeFile(h.settingsFile, original)

  const result = await h.run(["setup", "--model", "gwm_main", "--fast-model", "gwm_fast", "--yes"])
  assert.equal(result.code, 0, result.stderr)
  assertNoSecrets(result.stdout + result.stderr)
  assert.match(result.stdout, /run \/mcp/)
  const settings = JSON.parse(await readFile(h.settingsFile, "utf8"))
  const helper = join(h.stateDir, "token-helper.mjs")
  assert.equal(settings.apiKeyHelper, `"/opt/node js/bin/node" "${helper}"`)
  assert.deepEqual(settings.env, {
    FOO: "bar",
    ANTHROPIC_BASE_URL: `${GATEWAY}/api`,
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gwm_main",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gwm_main",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gwm_fast",
  })
  assert.equal(settings.model, "gwm_main")
  assert.deepEqual(settings.permissions, { deny: ["WebSearch"] })
  assert.match(await readFile(h.settingsFile, "utf8"), /^\{\n {4}"theme"/)
  assert.ok((await stat(helper)).isFile())
  assert.deepEqual(h.commands, [
    ["claude", "mcp", "get", "openwork"],
    ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "openwork", `${DEN}/mcp/agent`],
  ])

  const shown = await h.run(["status"])
  assert.equal(shown.code, 0)
  assertNoSecrets(shown.stdout + shown.stderr)
  assert.match(shown.stdout, /Gateway key:  saved/)
  assert.match(shown.stdout, /Settings:   in place/)
  assert.match(shown.stdout, /"openwork" added by claude-openwork/)

  const again = await h.run(["setup", "--model", "gwm_fast", "--yes"])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(JSON.parse(await readFile(h.settingsFile, "utf8")).model, "gwm_fast")

  const removed = await h.run(["uninstall", "--yes"])
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(await readFile(h.settingsFile, "utf8"), original)
  assert.deepEqual(h.commands.at(-1), ["claude", "mcp", "remove", "--scope", "user", "openwork"])
  await assert.rejects(stat(helper))
  await assert.rejects(stat(join(h.stateDir, "managed-settings.json")))
  assert.ok((await stat(join(h.stateDir, "credentials.json"))).isFile(), "sign-in is kept")
})

test("uninstall removes a settings file setup created and keeps user edits", async () => {
  const h = await harness({ mcpPresent: true })
  assert.equal((await h.run(["setup", "--model", "gwm_main", "--yes"])).code, 0)
  assert.equal(h.commands.length, 1, "existing MCP server is not re-added")
  let removed = await h.run(["uninstall", "--yes"])
  assert.equal(removed.code, 0, removed.stderr)
  await assert.rejects(stat(h.settingsFile))
  assert.equal(h.commands.length, 1, "MCP server we did not add is not removed")

  assert.equal((await h.run(["setup", "--model", "gwm_main", "--yes", "--no-mcp"])).code, 0)
  const edited = JSON.parse(await readFile(h.settingsFile, "utf8"))
  edited.model = "my-choice"
  await writeFile(h.settingsFile, JSON.stringify(edited))
  const drift = await h.run(["status"])
  assert.match(drift.stdout, /changed since setup: model/)
  removed = await h.run(["uninstall", "--yes"])
  assert.equal(removed.code, 0)
  assert.match(removed.stderr, /model was changed after setup/)
  assert.deepEqual(JSON.parse(await readFile(h.settingsFile, "utf8")), { model: "my-choice" })
})

test("setup refuses to clobber another apiKeyHelper unless --force", async () => {
  const h = await harness({ claudeMissing: true })
  await mkdir(h.configDir, { recursive: true })
  const original = JSON.stringify({ apiKeyHelper: "~/bin/key.sh", env: { ANTHROPIC_API_KEY: "sk-ant-mine" } }, null, 2)
  await writeFile(h.settingsFile, original)
  const refused = await h.run(["setup", "--model", "gwm_main", "--yes"])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /apiKeyHelper/)
  assert.match(refused.stderr, /env\.ANTHROPIC_API_KEY/)
  assert.doesNotMatch(refused.stderr, /sk-ant-mine|key\.sh/)
  assert.equal(await readFile(h.settingsFile, "utf8"), original)

  const forced = await h.run(["setup", "--model", "gwm_main", "--yes", "--force"])
  assert.equal(forced.code, 0, forced.stderr)
  assert.match(forced.stderr, /claude mcp add --transport http --scope user openwork/)
  assert.equal((await h.run(["setup", "--model", "gwm_fast", "--yes"])).code, 0, "a consented override is not a conflict on re-run")
  assert.equal((await h.run(["uninstall", "--yes"])).code, 0)
  assert.deepEqual(JSON.parse(await readFile(h.settingsFile, "utf8")), JSON.parse(original))
})

test("setup refuses settings that are not plain JSON", async () => {
  const h = await harness()
  await mkdir(h.configDir, { recursive: true })
  await writeFile(h.settingsFile, '{ // comment\n "a": 1 }')
  const result = await h.run(["setup", "--model", "gwm_main", "--yes"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /not valid JSON/)
})

test("token refuses a terminal unless --reveal; logout deletes the sign-in", async () => {
  const h = await harness()
  const tty = await h.run(["token"], { stdoutTTY: true })
  assert.equal(tty.code, 1)
  assertNoSecrets(tty.stdout + tty.stderr)
  const piped = await h.run(["token"])
  assert.equal(piped.stdout, `${GATEWAY_KEY}\n`)
  const out = await h.run(["logout"])
  assert.equal(out.code, 0)
  assertNoSecrets(out.stdout + out.stderr)
  await assert.rejects(stat(join(h.stateDir, "credentials.json")))
  const status = await h.run(["status"])
  assert.match(status.stdout, /not signed in/)
})

test("models lists Claude-compatible models; --all marks the rest", async () => {
  const h = await harness()
  let result = await h.run(["models"])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /gwm_main/)
  assert.doesNotMatch(result.stdout, /gwm_gpt/)
  result = await h.run(["models", "--all"])
  assert.match(result.stdout, /ipr_o\): not usable in Claude Code/)
})
