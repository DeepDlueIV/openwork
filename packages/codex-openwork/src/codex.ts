/**
 * Talks to the Codex CLI through its own read-only and sign-in commands
 * (`codex mcp list`, `codex mcp login`, `codex --version`). Commands that
 * rewrite config.toml (`codex mcp add/remove`) are never used.
 */
import { spawn } from "node:child_process"
import { isRecord, readString } from "../../agent-gateway-core/src/index.ts"
import type { Env } from "./paths.ts"

export interface RunResult {
  /** Exit code, or null when the process was killed or could not start. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** The command does not exist on PATH. */
  readonly notFound: boolean
}

export interface RunOptions {
  /** Share this terminal (for browser sign-in prompts); output is not captured. */
  readonly interactive: boolean
  readonly timeoutMs?: number
}

export type RunCommand = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>

const DEFAULT_TIMEOUT_MS = 60_000

export const defaultRunCommand: RunCommand = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(command, [...args], {
      // Non-interactive runs get no stdin so a browser sign-in prompt ends at once instead of waiting.
      stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      // Windows installs codex as a .cmd shim, which needs a shell. Arguments here are fixed names and validated URLs.
      shell: process.platform === "win32",
      windowsHide: true,
    })
    const timer = options.interactive
      ? null
      : setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      const notFound = "code" in error && error.code === "ENOENT"
      finish({ code: null, stdout, stderr: notFound ? "" : error.message, notFound })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      finish({ code, stdout, stderr, notFound: false })
    })
  })

export function codexBin(env: Env): string {
  return env.CODEX_OPENWORK_CODEX_BIN?.trim() || "codex"
}

export interface McpServerInfo {
  readonly name: string
  readonly url: string | null
  /** Codex's `auth_status`, e.g. "o_auth" once signed in. */
  readonly authStatus: string | null
}

export type McpLookup =
  | { readonly kind: "no-codex" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly servers: readonly McpServerInfo[] }

function parseServer(value: unknown): McpServerInfo | null {
  if (!isRecord(value)) return null
  const name = readString(value.name)
  if (!name) return null
  const transport = isRecord(value.transport) ? value.transport : {}
  return { name, url: readString(transport.url), authStatus: readString(value.auth_status) }
}

/** Arguments that select a profile (`--profile <name>`), or none for the base config. */
export function profileArgs(profile: string | null): string[] {
  return profile ? ["--profile", profile] : []
}

/** `codex [--profile <name>] mcp list --json`. */
export async function listMcpServers(run: RunCommand, bin: string, profile: string | null = null): Promise<McpLookup> {
  const result = await run(bin, [...profileArgs(profile), "mcp", "list", "--json"], { interactive: false })
  if (result.notFound) return { kind: "no-codex" }
  if (result.code !== 0) return { kind: "error", message: firstLine(result.stderr) || `codex mcp list exited with ${result.code}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { kind: "error", message: "codex mcp list --json did not return JSON" }
  }
  const servers = Array.isArray(parsed) ? parsed.map(parseServer).filter((entry) => entry !== null) : []
  return { kind: "ok", servers }
}

/** Normalized comparison so a trailing slash does not count as a different server. */
export function sameUrl(left: string | null, right: string): boolean {
  if (!left) return false
  const trim = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase()
  return trim(left) === trim(right)
}

/** The configured server named `name`, or one already pointing at `url`. */
export function findOpenWorkServer(servers: readonly McpServerInfo[], name: string, url: string): McpServerInfo | null {
  return servers.find((server) => server.name === name) ?? servers.find((server) => sameUrl(server.url, url)) ?? null
}

export function isSignedIn(server: McpServerInfo): boolean {
  return server.authStatus === "o_auth"
}

/** `codex --version` → [major, minor, patch], or null. */
export async function codexVersion(run: RunCommand, bin: string): Promise<readonly [number, number, number] | null> {
  const result = await run(bin, ["--version"], { interactive: false, timeoutMs: 15_000 })
  if (result.code !== 0) return null
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Profile files (`<name>.config.toml`) need Codex 0.134 or later. */
export function supportsProfileFiles(version: readonly [number, number, number]): boolean {
  const [major, minor] = version
  return major > 0 || minor >= 134
}

export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? ""
}
