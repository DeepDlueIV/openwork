import { isAbsolute, join, resolve } from "node:path"
import { resolveStateDir } from "../../agent-gateway-core/src/index.ts"

export const APP_NAME = "codex-openwork"
export const STATE_DIR_ENV = "CODEX_OPENWORK_STATE_DIR"
export const DEFAULT_PROFILE = "openwork"
export const MCP_SERVER_NAME = "openwork"
export const HELPER_FILE = "token-helper.mjs"
/** How users run this tool in printed instructions; works with or without a global install. */
export const SELF = "npx codex-openwork"

export type Env = Readonly<Record<string, string | undefined>>

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function stateDir(env: Env, home: string): string {
  return resolveStateDir({ app: APP_NAME, envVar: STATE_DIR_ENV, env, home })
}

/** `$CODEX_HOME`, defaulting to `~/.codex` like Codex itself. */
export function codexHome(env: Env, home: string): string {
  const override = env.CODEX_HOME?.trim()
  if (override) return isAbsolute(override) ? override : resolve(override)
  return join(home, ".codex")
}

export function validateProfileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || name.toLowerCase() === "config") {
    throw new UsageError(`"${name}" is not a valid profile name. Use letters, numbers, "-" or "_" (for example: openwork).`)
  }
  return name
}

export function profilePath(home: string, name: string): string {
  return join(home, `${validateProfileName(name)}.config.toml`)
}

export function helperPath(dir: string): string {
  return join(dir, HELPER_FILE)
}

/** The OpenWork MCP gateway for an OpenWork API base URL. */
export function mcpUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl}/mcp/agent`
}
