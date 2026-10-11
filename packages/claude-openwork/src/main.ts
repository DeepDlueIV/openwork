/**
 * claude-openwork: point Claude Code (CLI and IDE extensions) at an OpenWork
 * organization's AI Gateway and add the OpenWork MCP server, using only
 * Claude Code's supported settings (`apiKeyHelper`, `env`, `model`,
 * `permissions.deny`) and `claude mcp add`.
 *
 * Nothing here prints the Den session token or the gateway key, except the
 * `token` command, whose purpose is to print the key.
 */
import { dirname, basename } from "node:path"
import {
  DEFAULT_API_BASE_URL,
  DenAuthError,
  DenRequestError,
  DenUrlError,
  DeviceFlowError,
  FileSafetyError,
  GatewayError,
  PromptError,
  StateError,
  confirm,
  deviceLogin,
  fetchGatewayInventory,
  fetchGatewayKey,
  readCredential,
  readTextFile,
  remove,
  removeCredential,
  resolveStateDir,
  signOut,
  validateApiBaseUrl,
  writeCredential,
  writeTextFileWithBackup,
  type DenSession,
  type Fetch,
  type GatewayInventory,
  type GatewayProviderSummary,
  type PromptStreams,
  type Sleep,
  type StoredCredential,
} from "../../agent-gateway-core/src/index.ts"
import { HELPER_FILE, QuoteError, helperCommand, helperPath, writeHelper } from "./helper.ts"
import { ManagedStateError, readManaged, removeManaged, writeManaged, type ManagedState } from "./managed.ts"
import { SelectionError, chooseModel, chooseProvider, claudeProviders, findModel, modelLabel } from "./select.ts"
import {
  COMPETING_ENV_KEYS,
  SettingsConflictError,
  SettingsError,
  WEB_SEARCH_TOOL,
  applySetup,
  detectIndent,
  formatPath,
  getSlot,
  deepEqual,
  parseSettings,
  revertSettings,
  serializeSettings,
  settingsPath,
  type Settings,
} from "./settings.ts"

export const APP = "claude-openwork"
export const STATE_ENV = "CLAUDE_OPENWORK_STATE_DIR"
export const MCP_NAME = "openwork"

export interface RunResult {
  /** Exit code, or null when the command could not be started or was killed. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** The executable was not found. */
  readonly notFound: boolean
}

export type RunCommand = (command: string, args: readonly string[]) => Promise<RunResult>

type Input = NodeJS.ReadableStream & { readonly isTTY?: boolean }
type Output = NodeJS.WritableStream & { readonly isTTY?: boolean }

export interface CliDeps {
  readonly fetch: Fetch
  readonly runCommand: RunCommand
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly stdin: Input
  readonly stdout: Output
  readonly stderr: Output
  readonly now: () => number
  /** Absolute path of the Node executable the token helper runs with. */
  readonly nodePath: string
  readonly platform: NodeJS.Platform
  readonly sleep?: Sleep
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliError"
  }
}

export const HELP = `claude-openwork: use your OpenWork organization's AI Gateway models and
MCP connections in Claude Code (the CLI and the IDE extensions).

Usage: claude-openwork <command> [options]

Commands:
  login [--api URL] [--org ID] [--open]
      Sign in to OpenWork in your browser and save your AI Gateway key.
  setup [--provider ipr_...] [--model gwm_...] [--fast-model gwm_...]
        [--no-mcp] [--no-deny-websearch] [--force] [--yes]
      Configure Claude Code to use the gateway and add the OpenWork MCP server.
  status
      Show the sign-in and what setup changed. Never prints secrets.
  models [--all]
      List the gateway models Claude Code can use (--all: every model).
  token [--reveal]
      Print your AI Gateway key (for scripts; --reveal to print to a terminal).
  uninstall [--yes]
      Restore the Claude Code settings setup changed. Keeps your sign-in.
  logout
      Sign out and delete the saved sign-in and gateway key.
  help
      Show this help.

Claude Desktop does not read these settings and is not affected.
`

type FlagKind = "string" | "boolean"
type Flags = Readonly<Record<string, string | boolean>>

export function parseArgs(args: readonly string[], spec: Readonly<Record<string, FlagKind>>): Flags {
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`)
    const eq = arg.indexOf("=")
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    const kind = spec[name]
    if (!kind) throw new UsageError(`Unknown option: --${name}`)
    if (kind === "boolean") {
      if (eq >= 0) throw new UsageError(`--${name} does not take a value`)
      flags[name] = true
      continue
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++index]
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name]
  return typeof value === "string" ? value : undefined
}

function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true
}

class Context {
  readonly deps: CliDeps
  readonly stateDir: string
  readonly settingsFile: string
  constructor(deps: CliDeps) {
    this.deps = deps
    this.stateDir = resolveStateDir({ app: APP, envVar: STATE_ENV, env: deps.env, home: deps.home })
    this.settingsFile = settingsPath(deps.env, deps.home)
  }
  out(line: string = ""): void {
    this.deps.stdout.write(`${line}\n`)
  }
  err(line: string): void {
    this.deps.stderr.write(`${line}\n`)
  }
  get prompts(): PromptStreams {
    return { input: this.deps.stdin, output: this.deps.stderr.isTTY ? this.deps.stderr : this.deps.stdout }
  }
  async requireCredential(): Promise<StoredCredential> {
    const credential = await readCredential(this.stateDir)
    if (!credential) throw new CliError(`Not signed in. Run: ${APP} login`)
    return credential
  }
  session(credential: StoredCredential): DenSession {
    return { apiBaseUrl: credential.apiBaseUrl, token: credential.token, orgId: credential.orgId }
  }
  requireLiveSession(credential: StoredCredential): void {
    if (credential.expiresAt <= this.deps.now()) throw new CliError(`Your OpenWork sign-in has expired. Run: ${APP} login`)
  }
}

function mcpUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl}/mcp/agent`
}

// Claude Code appends `/v1/messages` to ANTHROPIC_BASE_URL. The gateway's
// provider-less `/api/v1/messages` routes by the gwm_ model id; the
// per-provider path does not accept the extra `/v1` for Anthropic upstreams.
function claudeBaseUrl(gatewayBaseUrl: string): string {
  return `${gatewayBaseUrl}/api`
}

/** Shell variables that would make Claude Code bypass the apiKeyHelper or the gateway. */
function shellOverrides(env: Readonly<Record<string, string | undefined>>): string[] {
  return COMPETING_ENV_KEYS.filter((name) => Boolean(env[name]?.trim()))
}

function warnShellOverrides(ctx: Context): void {
  for (const name of shellOverrides(ctx.deps.env)) {
    ctx.err(`Warning: ${name} is set in your shell environment and takes precedence over the OpenWork gateway. Unset it before starting Claude Code.`)
  }
}

async function openBrowser(ctx: Context, url: string): Promise<void> {
  const { platform, runCommand } = ctx.deps
  const result = platform === "darwin"
    ? await runCommand("open", [url])
    : platform === "win32"
      ? await runCommand("rundll32", ["url.dll,FileProtocolHandler", url])
      : await runCommand("xdg-open", [url])
  if (result.code !== 0) ctx.err("Could not open a browser; open the link above yourself.")
}

/** The member's `ow_gw_` key and the gateway origin, from Den. Null key when no Claude-compatible provider exists. */
async function fetchGatewayAccess(
  ctx: Context,
  session: DenSession,
  inventory: GatewayInventory,
  preferredProvider?: GatewayProviderSummary,
): Promise<string | null> {
  const provider = preferredProvider ?? claudeProviders(inventory)[0]
  if (!provider) return null
  return fetchGatewayKey(session, provider.id, { fetch: ctx.deps.fetch })
}

async function login(ctx: Context, args: readonly string[]): Promise<void> {
  const flags = parseArgs(args, { api: "string", org: "string", open: "boolean" })
  const apiBaseUrl = validateApiBaseUrl(flagString(flags, "api") ?? DEFAULT_API_BASE_URL)
  const result = await deviceLogin({
    apiBaseUrl,
    orgId: flagString(flags, "org"),
    fetch: ctx.deps.fetch,
    now: ctx.deps.now,
    sleep: ctx.deps.sleep,
    onAuthorization: async (prompt) => {
      ctx.out("To sign in to OpenWork, open this page and confirm the code:")
      ctx.out(`  ${prompt.verificationUriComplete}`)
      ctx.out(`  Code: ${prompt.userCode}`)
      if (flagBool(flags, "open")) await openBrowser(ctx, prompt.verificationUriComplete)
      ctx.out("Waiting for approval...")
    },
  })
  let credential: StoredCredential = {
    apiBaseUrl: result.apiBaseUrl,
    token: result.token,
    orgId: result.orgId,
    orgName: result.orgName,
    user: result.user,
    expiresAt: result.expiresAt,
  }
  const session = ctx.session(credential)
  let gatewayNote: string
  try {
    const inventory = await fetchGatewayInventory(session, { fetch: ctx.deps.fetch })
    const key = await fetchGatewayAccess(ctx, session, inventory)
    if (key && inventory.gatewayBaseUrl) {
      credential = { ...credential, gatewayKey: key, gatewayBaseUrl: inventory.gatewayBaseUrl }
      gatewayNote = "AI Gateway key saved."
    } else {
      gatewayNote = "Your organization has no AI Gateway models Claude Code can use yet (it needs an Anthropic Messages provider)."
    }
  } catch (error) {
    gatewayNote = `Could not get your AI Gateway key yet (${errorMessage(error)}); setup will try again.`
  }
  await writeCredential(ctx.stateDir, credential)
  ctx.out(`Signed in as ${result.user.email || result.user.id} (${result.orgName}).`)
  ctx.out(gatewayNote)
  ctx.out(`Next: ${APP} setup`)
}

interface MirrorResult {
  readonly status: "added" | "present" | "missing_cli" | "failed" | "skipped"
  readonly detail?: string
}

async function ensureMcp(ctx: Context, url: string): Promise<MirrorResult> {
  const existing = await ctx.deps.runCommand("claude", ["mcp", "get", MCP_NAME])
  if (existing.notFound) return { status: "missing_cli" }
  if (existing.code === 0) {
    return existing.stdout.includes(url) ? { status: "present" } : { status: "present", detail: "with a different address" }
  }
  const added = await ctx.deps.runCommand("claude", ["mcp", "add", "--transport", "http", "--scope", "user", MCP_NAME, url])
  if (added.code === 0) return { status: "added" }
  return { status: "failed", detail: (added.stderr || added.stdout).trim().slice(0, 500) }
}

function manualMcpCommand(url: string): string {
  return `claude mcp add --transport http --scope user ${MCP_NAME} ${url}`
}

async function readSettings(path: string): Promise<{ settings: Settings; text: string | null }> {
  const text = await readTextFile(path)
  return { settings: parseSettings(text, path), text }
}

async function setup(ctx: Context, args: readonly string[]): Promise<void> {
  const flags = parseArgs(args, {
    provider: "string",
    model: "string",
    "fast-model": "string",
    "no-mcp": "boolean",
    "no-deny-websearch": "boolean",
    force: "boolean",
    yes: "boolean",
  })
  let credential = await ctx.requireCredential()
  ctx.requireLiveSession(credential)
  const previous = await readManaged(ctx.stateDir)
  if (previous && previous.settingsPath !== ctx.settingsFile) {
    throw new CliError(
      `claude-openwork is set up for ${previous.settingsPath}, but CLAUDE_CONFIG_DIR now points to ${ctx.settingsFile}. Run "${APP} uninstall" with the earlier CLAUDE_CONFIG_DIR first.`,
    )
  }

  const session = ctx.session(credential)
  const inventory = await fetchGatewayInventory(session, { fetch: ctx.deps.fetch })
  const providers = claudeProviders(inventory)
  const provider = await chooseProvider(providers, flagString(flags, "provider"), ctx.prompts)
  const model = await chooseModel(provider, flagString(flags, "model"), ctx.prompts)
  const fastModelId = flagString(flags, "fast-model")
  const fastModel = fastModelId ? findModel(provider, fastModelId, "--fast-model") : model

  const gatewayBaseUrl = inventory.gatewayBaseUrl ?? credential.gatewayBaseUrl ?? null
  if (!gatewayBaseUrl) throw new CliError("OpenWork did not report an AI Gateway address for your organization. Ask an admin to check the AI Gateway.")
  const gatewayKey = credential.gatewayKey ?? (await fetchGatewayAccess(ctx, session, inventory, provider))
  if (!gatewayKey) throw new CliError("OpenWork did not return an AI Gateway key.")

  const helper = helperPath(ctx.stateDir)
  const apiKeyHelper = helperCommand(ctx.deps.nodePath, helper, ctx.deps.platform)
  const baseUrl = claudeBaseUrl(gatewayBaseUrl)
  const denyWebSearch = !flagBool(flags, "no-deny-websearch")
  const wantMcp = !flagBool(flags, "no-mcp")
  const mcpAddress = mcpUrl(credential.apiBaseUrl)

  const { settings: current, text } = await readSettings(ctx.settingsFile)
  const reverted = previous ? revertSettings(current, previous.changes) : null
  const base = reverted ? reverted.settings : current
  const { settings: next, changes } = applySetup(
    base,
    {
      apiKeyHelper,
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model.id,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model.id,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fastModel.id,
      },
      model: model.id,
      denyWebSearch,
    },
    {
      force: flagBool(flags, "force"),
      createdFile: previous ? previous.changes.createdFile : text === null,
      acknowledged: previous?.changes.entries,
    },
  )

  ctx.out("Claude Code (CLI and IDE extensions) will use your OpenWork AI Gateway:")
  ctx.out(`  Settings file:  ${ctx.settingsFile}`)
  ctx.out(`  Provider:       ${provider.name} (${provider.id})`)
  ctx.out(`  Model:          ${modelLabel(model)}  [default; opus and sonnet aliases]`)
  ctx.out(`  Fast model:     ${modelLabel(fastModel)}  [haiku alias, background tasks]`)
  ctx.out(`  Endpoint:       ${baseUrl}`)
  ctx.out(`  Credential:     apiKeyHelper runs ${helper}`)
  ctx.out(`  WebSearch:      ${denyWebSearch ? "denied (the gateway does not support Anthropic's server-side web search)" : "left as is (searches will fail through the gateway)"}`)
  ctx.out(`  MCP:            ${wantMcp ? `add "${MCP_NAME}" (${mcpAddress}) at user scope if missing` : "skipped"}`)
  const replaced = changes.entries.filter((entry) => entry.before.present).map((entry) => formatPath(entry.path))
  if (replaced.length > 0) ctx.out(`  Replaces:       ${replaced.join(", ")} (restored by uninstall)`)
  ctx.out("Requests from Claude Code bill to your organization's gateway, not a claude.ai subscription,")
  ctx.out("and Remote Control and voice dictation are unavailable while this is active.")
  ctx.out("Claude Desktop does not read these settings and is not affected.")
  if (!flagBool(flags, "yes")) {
    const ok = await confirm("Continue?", { ...ctx.prompts, hint: "pass --yes to confirm" })
    if (!ok) {
      ctx.out("Nothing was changed.")
      return
    }
  }

  if (credential.gatewayKey !== gatewayKey || credential.gatewayBaseUrl !== gatewayBaseUrl) {
    credential = { ...credential, gatewayKey, gatewayBaseUrl }
    await writeCredential(ctx.stateDir, credential)
  }
  await writeHelper(ctx.stateDir)
  const managed: ManagedState = {
    version: 1,
    settingsPath: ctx.settingsFile,
    providerId: provider.id,
    providerName: provider.name,
    model: model.id,
    fastModel: fastModel.id,
    baseUrl,
    helperPath: helper,
    apiKeyHelper,
    mcpAdded: previous?.mcpAdded ?? false,
    mcpUrl: previous?.mcpUrl ?? null,
    updatedAt: ctx.deps.now(),
    changes,
  }
  // Record first: if writing settings fails, uninstall still knows what may have changed.
  await writeManaged(ctx.stateDir, managed)
  // Only the first setup backs up the user's own file. Later runs change only
  // keys recorded in managed-settings.json, so more backups would just pile up.
  const written = await writeTextFileWithBackup(ctx.settingsFile, serializeSettings(next, detectIndent(text)), { now: ctx.deps.now, backup: !previous })
  for (const warning of reverted?.warnings ?? []) ctx.err(`Note: ${warning}`)
  ctx.out(written.changed ? `Updated ${ctx.settingsFile}.` : `${ctx.settingsFile} already up to date.`)
  if (written.backupPath) ctx.out(`Previous settings saved to ${written.backupPath}.`)

  if (wantMcp) {
    const mcp = await ensureMcp(ctx, mcpAddress)
    if (mcp.status === "added") {
      await writeManaged(ctx.stateDir, { ...managed, mcpAdded: true, mcpUrl: mcpAddress })
      ctx.out(`Added the "${MCP_NAME}" MCP server. In Claude Code, run /mcp and sign in to "${MCP_NAME}".`)
    } else if (mcp.status === "present") {
      ctx.out(`The "${MCP_NAME}" MCP server is already configured${mcp.detail ? ` ${mcp.detail}; left unchanged` : ""}. Run /mcp in Claude Code to check its sign-in.`)
    } else if (mcp.status === "missing_cli") {
      ctx.err(`Claude Code's "claude" command was not found. To add OpenWork MCP later, run:\n  ${manualMcpCommand(mcpAddress)}`)
    } else {
      ctx.err(`Could not add the "${MCP_NAME}" MCP server${mcp.detail ? `: ${mcp.detail}` : ""}. To add it yourself, run:\n  ${manualMcpCommand(mcpAddress)}`)
    }
  }
  warnShellOverrides(ctx)
  ctx.out("Done. Start a new Claude Code session to use OpenWork.")
}

function formatTime(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z")
}

async function status(ctx: Context, args: readonly string[]): Promise<void> {
  parseArgs(args, {})
  const credential = await readCredential(ctx.stateDir)
  if (!credential) {
    ctx.out(`OpenWork:     not signed in (run: ${APP} login)`)
  } else {
    ctx.out(`OpenWork:     signed in as ${credential.user.email || credential.user.id} (${credential.orgName ?? credential.orgId}) at ${credential.apiBaseUrl}`)
    ctx.out(credential.expiresAt > ctx.deps.now()
      ? `Session:      valid until ${formatTime(credential.expiresAt)}`
      : `Session:      expired (the gateway key keeps working; run ${APP} login to change setup)`)
    ctx.out(`Gateway key:  ${credential.gatewayKey ? "saved" : `missing (run: ${APP} login)`}`)
  }
  const managed = await readManaged(ctx.stateDir)
  if (!managed) {
    ctx.out(`Claude Code:  not set up (run: ${APP} setup)`)
  } else {
    ctx.out(`Claude Code:  set up in ${managed.settingsPath}`)
    ctx.out(`  Provider:   ${managed.providerName} (${managed.providerId})`)
    ctx.out(`  Model:      ${managed.model} (fast: ${managed.fastModel})`)
    ctx.out(`  Endpoint:   ${managed.baseUrl}`)
    try {
      const { settings } = await readSettings(managed.settingsPath)
      const drifted = managed.changes.entries
        .filter((entry) => {
          const slot = getSlot(settings, entry.path)
          return !slot || slot.present !== entry.after.present || (slot.present && !deepEqual(slot.value, entry.after.value))
        })
        .map((entry) => formatPath(entry.path))
      ctx.out(drifted.length === 0 ? "  Settings:   in place" : `  Settings:   changed since setup: ${drifted.join(", ")}`)
    } catch (error) {
      ctx.out(`  Settings:   could not read (${errorMessage(error)})`)
    }
    if (managed.changes.denyAdded.includes(WEB_SEARCH_TOOL)) ctx.out(`  WebSearch:  denied by ${APP}`)
    ctx.out(`  MCP:        ${managed.mcpAdded ? `"${MCP_NAME}" added by ${APP} (${managed.mcpUrl ?? "unknown address"})` : `not added by ${APP}`}`)
  }
  warnShellOverrides(ctx)
}

async function models(ctx: Context, args: readonly string[]): Promise<void> {
  const flags = parseArgs(args, { all: "boolean" })
  const credential = await ctx.requireCredential()
  ctx.requireLiveSession(credential)
  const inventory = await fetchGatewayInventory(ctx.session(credential), { fetch: ctx.deps.fetch })
  const managed = await readManaged(ctx.stateDir)
  const shown = flagBool(flags, "all") ? inventory.providers : claudeProviders(inventory)
  if (shown.length === 0) {
    ctx.out(flagBool(flags, "all")
      ? "Your organization has no AI Gateway models you can use."
      : "No AI Gateway models Claude Code can use (it needs an Anthropic Messages provider). See all with --all.")
    return
  }
  for (const provider of shown) {
    const usable = provider.protocol === "anthropic_messages"
    ctx.out(`${provider.name} (${provider.id})${usable ? "" : `: not usable in Claude Code (${provider.protocol})`}`)
    for (const model of provider.models) {
      const marks: string[] = []
      if (managed?.model === model.id) marks.push("default")
      if (managed?.fastModel === model.id) marks.push("fast")
      ctx.out(`  ${modelLabel(model)}${marks.length > 0 ? `  [${marks.join(", ")}]` : ""}`)
    }
  }
}

async function token(ctx: Context, args: readonly string[]): Promise<void> {
  const flags = parseArgs(args, { reveal: "boolean" })
  const credential = await ctx.requireCredential()
  if (!credential.gatewayKey) throw new CliError(`No AI Gateway key is saved. Run: ${APP} login`)
  if (ctx.deps.stdout.isTTY && !flagBool(flags, "reveal")) {
    throw new CliError("Refusing to print your AI Gateway key to the terminal. Pipe it to another command, or pass --reveal.")
  }
  ctx.deps.stdout.write(`${credential.gatewayKey}\n`)
}

async function uninstall(ctx: Context, args: readonly string[]): Promise<void> {
  const flags = parseArgs(args, { yes: "boolean" })
  const managed = await readManaged(ctx.stateDir)
  if (!managed) {
    const removed = await remove(ctx.stateDir, HELPER_FILE).catch(() => false)
    ctx.out(`${APP} is not set up; there is nothing to restore.${removed ? " Removed the leftover token helper." : ""}`)
    return
  }
  const { settings, text } = await readSettings(managed.settingsPath)
  const result = revertSettings(settings, managed.changes)
  ctx.out(`This restores the Claude Code settings ${APP} changed in ${managed.settingsPath}`)
  if (managed.mcpAdded) ctx.out(`and removes the "${MCP_NAME}" MCP server it added.`)
  ctx.out("Your OpenWork sign-in is kept.")
  if (!flagBool(flags, "yes")) {
    const ok = await confirm("Continue?", { ...ctx.prompts, hint: "pass --yes to confirm" })
    if (!ok) {
      ctx.out("Nothing was changed.")
      return
    }
  }
  if (result.removeFile) {
    await remove(dirname(managed.settingsPath), basename(managed.settingsPath))
    ctx.out(`Removed ${managed.settingsPath} (setup created it).`)
  } else {
    // Uninstall only reverts recorded keys; the backup from the first setup still holds the original.
    const written = await writeTextFileWithBackup(managed.settingsPath, serializeSettings(result.settings, detectIndent(text)), { now: ctx.deps.now, backup: false })
    ctx.out(written.changed ? `Restored ${managed.settingsPath}.` : `${managed.settingsPath} needed no changes.`)
    if (written.backupPath) ctx.out(`Previous settings saved to ${written.backupPath}.`)
  }
  for (const warning of result.warnings) ctx.err(`Note: ${warning}`)
  if (managed.mcpAdded) {
    const removed = await ctx.deps.runCommand("claude", ["mcp", "remove", "--scope", "user", MCP_NAME])
    if (removed.code === 0) ctx.out(`Removed the "${MCP_NAME}" MCP server.`)
    else ctx.err(`Could not remove the "${MCP_NAME}" MCP server; run: claude mcp remove --scope user ${MCP_NAME}`)
  }
  await remove(ctx.stateDir, HELPER_FILE)
  await removeManaged(ctx.stateDir)
  ctx.out(`Done. Run "${APP} logout" to also delete your saved sign-in.`)
}

async function logout(ctx: Context, args: readonly string[]): Promise<void> {
  parseArgs(args, {})
  const credential = await readCredential(ctx.stateDir).catch(() => null)
  if (credential) await signOut(credential, { fetch: ctx.deps.fetch })
  const removed = await removeCredential(ctx.stateDir)
  ctx.out(removed ? "Signed out; the saved sign-in and gateway key were deleted." : "Not signed in.")
  const managed = await readManaged(ctx.stateDir).catch(() => null)
  if (managed) {
    ctx.err(`Claude Code is still set up to use OpenWork and cannot authenticate now. Run "${APP} uninstall" to restore your settings, or "${APP} login" to sign in again.`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const KNOWN_ERRORS = [
  CliError,
  DenAuthError,
  DenRequestError,
  DenUrlError,
  DeviceFlowError,
  FileSafetyError,
  GatewayError,
  ManagedStateError,
  PromptError,
  QuoteError,
  SelectionError,
  SettingsConflictError,
  SettingsError,
  StateError,
]

/** Runs the CLI and returns the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv
  try {
    const ctx = new Context(deps)
    switch (command) {
      case "login":
        await login(ctx, args)
        break
      case "setup":
        await setup(ctx, args)
        break
      case "status":
        await status(ctx, args)
        break
      case "models":
        await models(ctx, args)
        break
      case "token":
        await token(ctx, args)
        break
      case "uninstall":
        await uninstall(ctx, args)
        break
      case "logout":
        await logout(ctx, args)
        break
      case undefined:
      case "help":
      case "--help":
      case "-h":
        deps.stdout.write(HELP)
        break
      default:
        throw new UsageError(`Unknown command: ${command}`)
    }
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr.write(`${error.message}\nRun "${APP} help" for usage.\n`)
      return 2
    }
    if (KNOWN_ERRORS.some((kind) => error instanceof kind)) {
      deps.stderr.write(`${errorMessage(error)}\n`)
      return 1
    }
    deps.stderr.write(`Unexpected error: ${errorMessage(error)}\n`)
    return 1
  }
}
