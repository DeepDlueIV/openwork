/** Test helpers: temp homes, captured output, and a fake `codex` runner. No network. */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import type { Fetch, StoredCredential } from "../../agent-gateway-core/src/index.ts"
import type { RunCommand, RunOptions, RunResult } from "./codex.ts"
import type { Deps } from "./commands.ts"

export const GATEWAY = "https://gateway.example.com"
export const API = "https://den.example.com"
export const GATEWAY_KEY = "ow_gw_secret_member_key"
export const DEN_TOKEN = "den-session-secret-token"

export class Capture extends Writable {
  text = ""
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    callback()
  }
}

export async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "codex-openwork-"))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export interface RunCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunOptions
}

export function ok(stdout = ""): RunResult {
  return { code: 0, stdout, stderr: "", notFound: false }
}

export interface FakeServer {
  name: string
  url: string
  auth_status?: string
}

/** `[mcp_servers.<name>]` tables followed by `url = "…"` in a profile file. */
function profileServers(text: string): FakeServer[] {
  const out: FakeServer[] = []
  const pattern = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*\nurl = ("(?:[^"\\]|\\.)*")$/gm
  for (const match of text.matchAll(pattern)) {
    const url: unknown = JSON.parse(match[2] ?? '""')
    if (match[1] && typeof url === "string") out.push({ name: match[1], url })
  }
  return out
}

/** True when argv runs a config-rewriting `codex mcp add|remove`. */
export function isMcpWrite(args: readonly string[]): boolean {
  const index = args.indexOf("mcp")
  return index >= 0 && args.slice(index + 1).some((arg) => arg === "add" || arg === "remove")
}

/**
 * Fake codex. The base config holds `initial`; `--profile <name>` overlays the
 * `[mcp_servers.*]` tables of `<codexHome>/<name>.config.toml`, like Codex does.
 * `mcp add`/`remove` are refused so tests catch any attempt to rewrite config.toml.
 */
export function fakeCodex(
  initial: FakeServer[] = [],
  options: { codexHome?: string; profileAuth?: string } = {},
): { run: RunCommand; calls: RunCall[] } {
  const servers = [...initial]
  const calls: RunCall[] = []
  const run: RunCommand = async (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions })
    if (args[0] === "--version") return ok("codex-cli 0.157.1\n")
    let rest = args
    let listed: FakeServer[] = servers
    if (rest[0] === "--profile") {
      const name = rest[1] ?? ""
      rest = rest.slice(2)
      const text = options.codexHome ? await readFile(join(options.codexHome, `${name}.config.toml`), "utf8").catch(() => "") : ""
      const overlay = profileServers(text).map((server) => ({ ...server, auth_status: options.profileAuth ?? "not_logged_in" }))
      listed = [...servers.filter((server) => !overlay.some((entry) => entry.name === server.name)), ...overlay]
    }
    const key = rest.slice(0, 2).join(" ")
    if (key === "mcp list") {
      return ok(JSON.stringify(listed.map((server) => ({
        name: server.name,
        enabled: true,
        transport: { type: "streamable_http", url: server.url },
        auth_status: server.auth_status ?? "not_logged_in",
      }))))
    }
    if (key === "mcp login") return ok()
    return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}`, notFound: false }
  }
  return { run, calls }
}

export function makeDeps(root: string, overrides: Partial<Deps> & { fetch: Fetch }): Deps & { stdout: Capture; stderr: Capture } {
  const stdout = new Capture()
  const stderr = new Capture()
  return {
    run: fakeCodex().run,
    env: { CODEX_HOME: join(root, "codex"), CODEX_OPENWORK_STATE_DIR: join(root, "state") },
    home: join(root, "home"),
    stdin: new PassThrough(),
    now: () => 1_800_000_000_000,
    nodePath: "/usr/local/bin/node",
    platform: "darwin",
    ...overrides,
    stdout,
    stderr,
  }
}

export function credential(extra: Partial<StoredCredential> = {}): StoredCredential {
  return {
    apiBaseUrl: API,
    token: DEN_TOKEN,
    orgId: "org_1",
    orgName: "Acme",
    user: { id: "usr_1", email: "member@example.com" },
    expiresAt: 1_900_000_000_000,
    ...extra,
  }
}

export const providersBody = {
  inferenceProviders: [
    {
      id: "ipr_openai",
      providerId: "openai",
      name: "OpenAI",
      providerConfig: { npm: "@ai-sdk/openai", api: `${GATEWAY}/api/v1/providers/ipr_openai` },
      models: [
        { id: "gwm_gpt", name: "GPT-5", upstreamModelId: "gpt-5" },
        { id: "gwm_mini", name: "GPT-5 mini", upstreamModelId: "gpt-5-mini" },
      ],
    },
    {
      id: "ipr_claude",
      providerId: "anthropic",
      name: "Anthropic",
      providerConfig: { npm: "@ai-sdk/anthropic", api: `${GATEWAY}/api/v1/providers/ipr_claude` },
      models: [{ id: "gwm_sonnet", name: "Sonnet" }],
    },
  ],
}
