/**
 * The Codex profile file this tool writes (`$CODEX_HOME/<profile>.config.toml`).
 *
 * Codex (>= 0.134) overlays a profile file's top-level keys onto config.toml
 * when it runs as `codex --profile <name>`. Only documented keys are written.
 */

/** First line of every profile file we write; anything without it is not ours. */
export const PROFILE_MARKER = "# Managed by codex-openwork"
/** Custom provider id. Codex reserves openai, ollama, and lmstudio. */
export const PROVIDER_ID = "openwork"
export const PROVIDER_NAME = "OpenWork AI Gateway"
export const AUTH_TIMEOUT_MS = 5000
export const AUTH_REFRESH_INTERVAL_MS = 300_000

/** A TOML basic string: quotes, backslashes, and every control character escaped. */
export function tomlString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"') out += '\\"'
    else if (char === "\\") out += "\\\\"
    else if (char === "\b") out += "\\b"
    else if (char === "\t") out += "\\t"
    else if (char === "\n") out += "\\n"
    else if (char === "\f") out += "\\f"
    else if (char === "\r") out += "\\r"
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
    else out += char
  }
  return `${out}"`
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`
}

export interface ProfileInput {
  readonly profileName: string
  /** `gwm_*` */
  readonly model: string
  /** Gateway origin (+ path prefix), without `/api/v1`. */
  readonly gatewayBaseUrl: string
  /** Absolute path of the Node binary that runs the token helper. */
  readonly nodePath: string
  /** Absolute path of the token helper script. */
  readonly helperPath: string
  /** Model catalog file giving Codex real metadata for the gwm ids, or null. */
  readonly modelCatalogPath?: string | null
  /** Default reasoning effort for the model, from the catalog. */
  readonly reasoningEffort?: string | null
  /** OpenWork MCP gateway URL to add for this profile only, or null to leave MCP alone. */
  readonly mcp?: { readonly name: string; readonly url: string } | null
}

export function renderProfile(input: ProfileInput): string {
  return [
    `${PROFILE_MARKER}. \`npx codex-openwork setup\` rewrites this file and \`npx codex-openwork uninstall\` removes it.`,
    `# Use it with: codex --profile ${input.profileName}`,
    `model_provider = ${tomlString(PROVIDER_ID)}`,
    `model = ${tomlString(input.model)}`,
    ...(input.modelCatalogPath ? [
      "# Context window, reasoning levels and tools for the gateway's models, copied from Codex's own model list.",
      `model_catalog_json = ${tomlString(input.modelCatalogPath)}`,
    ] : []),
    ...(input.reasoningEffort ? [`model_reasoning_effort = ${tomlString(input.reasoningEffort)}`] : []),
    "# The OpenWork AI Gateway does not run OpenAI-hosted tools such as web search.",
    `web_search = ${tomlString("disabled")}`,
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${tomlString(PROVIDER_NAME)}`,
    `base_url = ${tomlString(`${input.gatewayBaseUrl}/api/v1`)}`,
    `wire_api = ${tomlString("responses")}`,
    "",
    "# Codex runs this command to get your OpenWork AI Gateway key; the key itself is not stored here.",
    `[model_providers.${PROVIDER_ID}.auth]`,
    `command = ${tomlString(input.nodePath)}`,
    `args = ${tomlStringArray([input.helperPath])}`,
    `timeout_ms = ${AUTH_TIMEOUT_MS}`,
    `refresh_interval_ms = ${AUTH_REFRESH_INTERVAL_MS}`,
    "",
    ...(input.mcp ? [
      "# OpenWork MCP gateway for this profile only; config.toml is not changed. Sign in once with:",
      `#   codex --profile ${input.profileName} mcp login ${input.mcp.name}`,
      `[mcp_servers.${input.mcp.name}]`,
      `url = ${tomlString(input.mcp.url)}`,
      "",
    ] : []),
  ].join("\n")
}

/** True when the file starts with our marker comment. */
export function isManagedProfile(text: string): boolean {
  return text.replace(/^\uFEFF/, "").trimStart().startsWith(PROFILE_MARKER)
}

/** The top-level `model = "…"` of a profile we wrote, or null. */
export function readProfileModel(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) return null
    const match = /^model\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line)
    if (!match?.[1]) continue
    try {
      const value: unknown = JSON.parse(match[1])
      return typeof value === "string" ? value : null
    } catch {
      return null
    }
  }
  return null
}
