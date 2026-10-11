import {
  DEFAULT_API_BASE_URL,
  confirm,
  deviceLogin,
  fetchGatewayInventory,
  fetchGatewayKey,
  isInteractive,
  listGatewayModels,
  pick,
  readCredential,
  readTextFile,
  removeCredential,
  signOut,
  validateApiBaseUrl,
  writeCredential,
  type Fetch,
  type GatewayInventory,
  type GatewayModelEntry,
  type Sleep,
  type StoredCredential,
} from "../../agent-gateway-core/src/index.ts"
import type { ParsedArgs } from "./args.ts"
import {
  codexBin,
  codexVersion,
  findOpenWorkServer,
  isSignedIn,
  listMcpServers,
  profileArgs,
  sameUrl,
  supportsProfileFiles,
  type McpLookup,
  type RunCommand,
} from "./codex.ts"
import { installTokenHelper, removeTokenHelper } from "./helper.ts"
import { compatibleModels, incompatibleModels, keyProvider, modelLabel } from "./models.ts"
import {
  DEFAULT_PROFILE,
  MCP_SERVER_NAME,
  SELF,
  UsageError,
  codexHome,
  helperPath,
  mcpUrl,
  profilePath,
  stateDir,
  validateProfileName,
  type Env,
} from "./paths.ts"
import { ProfileConflictError, inspectProfile, removeProfile, writeProfile } from "./profile.ts"
import { readProfileModel, renderProfile } from "./toml.ts"

export interface Deps {
  readonly fetch: Fetch
  readonly run: RunCommand
  readonly env: Env
  readonly home: string
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean }
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean }
  readonly stderr: NodeJS.WritableStream
  readonly now: () => number
  /** Absolute path of the Node binary Codex should use to run the token helper. */
  readonly nodePath: string
  readonly platform: NodeJS.Platform
  readonly sleep?: Sleep
  readonly signal?: AbortSignal
}

function say(deps: Deps, line = ""): void {
  deps.stdout.write(`${line}\n`)
}

function warn(deps: Deps, line: string): void {
  deps.stderr.write(`${line}\n`)
}

function interactive(deps: Deps): boolean {
  return isInteractive({ input: deps.stdin, output: deps.stdout })
}

/** Yes/no that never silently says yes without a terminal: `--yes` is required instead. */
async function agree(deps: Deps, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (!interactive(deps)) throw new UsageError(`${question} Run this in a terminal to answer, or pass --yes.`)
  return confirm(question, { input: deps.stdin, output: deps.stdout, defaultValue: true })
}

function requestOptions(deps: Deps): { fetch: Fetch; signal?: AbortSignal } {
  return deps.signal ? { fetch: deps.fetch, signal: deps.signal } : { fetch: deps.fetch }
}

async function requireCredential(dir: string): Promise<StoredCredential> {
  const credential = await readCredential(dir)
  if (!credential) throw new UsageError(`You are not signed in to OpenWork. Run: ${SELF} login`)
  return credential
}

interface GatewayRefresh {
  readonly credential: StoredCredential
  readonly inventory: GatewayInventory
}

/** Reloads the AI Gateway inventory and the member's key from OpenWork, saving any change. */
async function refreshGateway(dir: string, credential: StoredCredential, deps: Deps): Promise<GatewayRefresh> {
  const session = { apiBaseUrl: credential.apiBaseUrl, token: credential.token, orgId: credential.orgId }
  const inventory = await fetchGatewayInventory(session, requestOptions(deps))
  const provider = keyProvider(inventory)
  let next = credential
  if (provider && inventory.gatewayBaseUrl) {
    const gatewayKey = await fetchGatewayKey(session, provider.id, requestOptions(deps))
    next = { ...credential, gatewayKey, gatewayBaseUrl: inventory.gatewayBaseUrl }
  }
  if (next.gatewayKey !== credential.gatewayKey || next.gatewayBaseUrl !== credential.gatewayBaseUrl) {
    await writeCredential(dir, next)
  }
  return { credential: next, inventory }
}

function noModelsMessage(inventory: GatewayInventory): string {
  const others = incompatibleModels(inventory).length
  return [
    "Your OpenWork organization has no AI Gateway models that Codex can use.",
    "Codex needs models from an OpenAI-type provider (OpenAI, Azure OpenAI, or OpenAI-compatible).",
    others > 0 ? `${others} other model(s) are available but use a different format Codex cannot talk to.` : null,
    "Ask an OpenWork admin to add one, then run this again.",
  ].filter((line) => line !== null).join("\n")
}

function openBrowser(deps: Deps, url: string): void {
  const command = deps.platform === "darwin" ? "open" : deps.platform === "win32" ? "explorer" : "xdg-open"
  void deps.run(command, [url], { interactive: false, timeoutMs: 10_000 }).catch(() => undefined)
}

// ---------------------------------------------------------------- login

export async function login(args: ParsedArgs, deps: Deps): Promise<number> {
  const dir = stateDir(deps.env, deps.home)
  const apiBaseUrl = validateApiBaseUrl(args.values.get("api") ?? DEFAULT_API_BASE_URL)
  const orgId = args.values.get("org")
  const result = await deviceLogin({
    apiBaseUrl,
    ...(orgId ? { orgId } : {}),
    ...requestOptions(deps),
    now: deps.now,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onAuthorization: (prompt) => {
      say(deps, "To sign in to OpenWork, open this page in your browser:")
      say(deps, `  ${prompt.verificationUriComplete}`)
      say(deps, `and check that it shows this code: ${prompt.userCode}`)
      say(deps)
      say(deps, "Waiting for you to approve…")
      if (args.switches.has("open")) openBrowser(deps, prompt.verificationUriComplete)
    },
  })
  const credential: StoredCredential = {
    apiBaseUrl: result.apiBaseUrl,
    token: result.token,
    orgId: result.orgId,
    orgName: result.orgName,
    user: result.user,
    expiresAt: result.expiresAt,
  }
  await writeCredential(dir, credential)
  say(deps, `Signed in as ${result.user.email || result.user.id} (${result.orgName}).`)
  try {
    const { credential: saved, inventory } = await refreshGateway(dir, credential, deps)
    const models = compatibleModels(inventory)
    if (!saved.gatewayKey || models.length === 0) {
      say(deps)
      say(deps, noModelsMessage(inventory))
      return 0
    }
    say(deps, `Found ${models.length} AI Gateway model(s) Codex can use.`)
  } catch (error) {
    warn(deps, `Signed in, but could not load your AI Gateway models yet: ${messageOf(error)}`)
  }
  say(deps)
  say(deps, `Next: ${SELF} setup`)
  return 0
}

// ---------------------------------------------------------------- setup

function chooseModel(models: readonly GatewayModelEntry[], requested: string | undefined, inventory: GatewayInventory): string | null {
  if (!requested) return null
  if (models.some((entry) => entry.id === requested)) return requested
  if (incompatibleModels(inventory).some((entry) => entry.id === requested)) {
    throw new UsageError(`${requested} uses a format Codex cannot talk to. Pick one of:\n${listLines(models)}`)
  }
  throw new UsageError(`${requested} is not one of your organization's AI Gateway models. Pick one of:\n${listLines(models)}`)
}

function listLines(models: readonly GatewayModelEntry[]): string {
  return models.map((entry) => `  ${modelLabel(entry)}`).join("\n")
}

async function lookupMcp(deps: Deps, profile: string | null = null): Promise<McpLookup> {
  return listMcpServers(deps.run, codexBin(deps.env), profile)
}

type McpPlan =
  | { readonly kind: "add" }
  | { readonly kind: "inherited"; readonly name: string }
  | { readonly kind: "name-taken" }
  | { readonly kind: "unknown"; readonly reason: string }

/**
 * Whether the profile should declare the OpenWork MCP server. The base config
 * is only read: a server it already has for our URL is inherited by the
 * profile, and a different server named "openwork" is never shadowed.
 */
function planMcp(base: McpLookup, url: string): McpPlan {
  if (base.kind === "no-codex") return { kind: "unknown", reason: "Codex CLI was not found" }
  if (base.kind === "error") return { kind: "unknown", reason: base.message }
  const ours = base.servers.find((server) => sameUrl(server.url, url))
  if (ours) return { kind: "inherited", name: ours.name }
  if (base.servers.some((server) => server.name === MCP_SERVER_NAME)) return { kind: "name-taken" }
  return { kind: "add" }
}

export async function setup(args: ParsedArgs, deps: Deps): Promise<number> {
  const dir = stateDir(deps.env, deps.home)
  const yes = args.switches.has("yes")
  const force = args.switches.has("force")
  const withMcp = !args.switches.has("no-mcp")
  const profileName = validateProfileName(args.values.get("profile") ?? DEFAULT_PROFILE)
  const home = codexHome(deps.env, deps.home)
  const profileFile = profilePath(home, profileName)

  const { credential, inventory } = await refreshGateway(dir, await requireCredential(dir), deps)
  const models = compatibleModels(inventory)
  if (models.length === 0) throw new UsageError(noModelsMessage(inventory))
  const gatewayBaseUrl = credential.gatewayBaseUrl
  if (!credential.gatewayKey || !gatewayBaseUrl) {
    throw new UsageError("OpenWork did not provide an AI Gateway address and key for your account. Ask an OpenWork admin to check the AI Gateway setup.")
  }

  let model = chooseModel(models, args.values.get("model"), inventory)
  if (!model) {
    if (models.length > 1 && !interactive(deps)) {
      throw new UsageError(`Choose a model with --model. Models Codex can use:\n${listLines(models)}`)
    }
    model = await pick(
      "Which model should Codex use?",
      models.map((entry) => ({ label: modelLabel(entry), value: entry.id })),
      { input: deps.stdin, output: deps.stdout, defaultIndex: 0, hint: "pass --model" },
    )
  }

  const existing = await inspectProfile(profileFile)
  if (existing.kind === "foreign" && !force) throw new ProfileConflictError(profileFile)

  const bin = codexBin(deps.env)
  const version = await codexVersion(deps.run, bin)
  if (version && !supportsProfileFiles(version)) {
    warn(deps, `Codex ${version.join(".")} is too old for profile files. Update Codex to 0.134 or later before using this profile.`)
  }

  const url = mcpUrl(credential.apiBaseUrl)
  // Without Codex on PATH the profile still declares the server; Codex reads it once installed.
  const plan = withMcp ? planMcp(await lookupMcp(deps), url) : null
  const addMcp = plan?.kind === "add" || (plan?.kind === "unknown" && version === null)

  const helper = helperPath(dir)
  say(deps, "This will:")
  say(deps, `  • ${existing.kind === "missing" ? "Create" : "Replace"} the Codex profile ${profileFile}`)
  say(deps, `    so \`codex --profile ${profileName}\` uses ${model} through your organization's OpenWork AI Gateway.`)
  if (addMcp) say(deps, `    It also adds the OpenWork MCP server (${url}) to that profile.`)
  say(deps, "    Your normal Codex setup (config.toml) is not changed.")
  say(deps, `  • Save a small helper at ${helper} that gives Codex your gateway key.`)
  if (existing.kind === "foreign") say(deps, "    The existing profile file was not created by codex-openwork; a backup copy is kept.")
  say(deps)
  if (!(await agree(deps, "Continue?", yes))) {
    say(deps, "Nothing was changed.")
    return 1
  }

  const helperFile = await installTokenHelper(dir)
  const written = await writeProfile(
    profileFile,
    renderProfile({
      profileName,
      model,
      gatewayBaseUrl,
      nodePath: deps.nodePath,
      helperPath: helperFile,
      mcp: addMcp ? { name: MCP_SERVER_NAME, url } : null,
    }),
    { stateDir: dir, force, now: deps.now },
  )
  say(deps, `${written.status === "unchanged" ? "Profile already up to date" : written.status === "created" ? "Created" : "Updated"}: ${profileFile}`)
  if (written.backupPath) say(deps, `Previous version saved as ${written.backupPath}`)

  if (plan) await setupMcp(deps, plan, profileName, url, yes)

  say(deps)
  say(deps, "Done. Start Codex with:")
  say(deps, `  codex --profile ${profileName}`)
  return 0
}

async function setupMcp(deps: Deps, plan: McpPlan, profileName: string, url: string, yes: boolean): Promise<void> {
  if (plan.kind === "name-taken") {
    say(deps, `Codex already has an MCP server named "${MCP_SERVER_NAME}" with a different address; it was left alone and the profile does not add OpenWork's.`)
    return
  }
  if (plan.kind === "unknown") {
    say(deps, `Could not check Codex's MCP servers (${plan.reason}). Run ${SELF} status after installing Codex.`)
    return
  }
  if (plan.kind === "inherited") say(deps, `OpenWork MCP server already in your Codex setup as "${plan.name}"; the profile uses it.`)
  const bin = codexBin(deps.env)
  const lookup = await lookupMcp(deps, profileName)
  const server = lookup.kind === "ok" ? findOpenWorkServer(lookup.servers, MCP_SERVER_NAME, url) : null
  if (!server) {
    say(deps, `Codex did not list the OpenWork MCP server for this profile. Check with: codex --profile ${profileName} mcp list`)
    return
  }
  if (isSignedIn(server)) {
    say(deps, "OpenWork MCP server is signed in.")
    return
  }
  const login = `codex ${profileArgs(profileName).join(" ")} mcp login ${server.name}`
  if (!interactive(deps)) {
    say(deps, `To use your OpenWork connections in Codex, sign in once with:\n  ${login}`)
    return
  }
  if (!yes && !(await confirm("Sign in to the OpenWork MCP server in your browser now?", { input: deps.stdin, output: deps.stdout, defaultValue: true }))) {
    say(deps, `You can sign in later with:\n  ${login}`)
    return
  }
  const result = await deps.run(bin, [...profileArgs(profileName), "mcp", "login", server.name], { interactive: true })
  if (result.code !== 0) say(deps, `MCP sign-in did not finish. Try again later with:\n  ${login}`)
}

// ---------------------------------------------------------------- status

export async function status(args: ParsedArgs, deps: Deps): Promise<number> {
  const dir = stateDir(deps.env, deps.home)
  const profileName = validateProfileName(args.values.get("profile") ?? DEFAULT_PROFILE)
  const profileFile = profilePath(codexHome(deps.env, deps.home), profileName)
  let credential: StoredCredential | null = null
  try {
    credential = await readCredential(dir)
  } catch (error) {
    say(deps, `OpenWork sign-in: problem with saved sign-in (${messageOf(error)})`)
  }
  if (credential) {
    const expired = credential.expiresAt <= deps.now()
    say(deps, `OpenWork sign-in: ${credential.user.email || credential.user.id}${expired ? ` (session expired; run ${SELF} login to change settings)` : ""}`)
    say(deps, `Organization: ${credential.orgName ?? credential.orgId}`)
  } else {
    say(deps, `OpenWork sign-in: not signed in (run ${SELF} login)`)
  }

  if (credential?.gatewayKey && credential.gatewayBaseUrl) {
    try {
      const entries = await listGatewayModels(credential.gatewayBaseUrl, credential.gatewayKey, requestOptions(deps))
      const usable = entries.filter((entry) => entry.protocol === "openai_responses").length
      say(deps, `AI Gateway: reachable at ${credential.gatewayBaseUrl} (${usable} Codex model(s))`)
    } catch (error) {
      say(deps, `AI Gateway: not reachable (${messageOf(error)})`)
    }
  } else {
    say(deps, `AI Gateway: no key saved${credential ? ` (run ${SELF} setup)` : ""}`)
  }

  const profile = await inspectProfile(profileFile)
  if (profile.kind === "managed") {
    say(deps, `Codex profile: ${profileFile} (model ${readProfileModel(profile.text) ?? "unknown"})`)
    const helper = await readTextFile(helperPath(dir)).catch(() => null)
    if (helper === null) say(deps, `  The key helper is missing; run ${SELF} setup again.`)
  } else if (profile.kind === "foreign") {
    say(deps, `Codex profile: ${profileFile} exists but was not created by codex-openwork`)
  } else {
    say(deps, `Codex profile: not set up (run ${SELF} setup)`)
  }

  const lookup = await lookupMcp(deps, profile.kind === "managed" ? profileName : null)
  if (lookup.kind === "no-codex") say(deps, "OpenWork MCP: Codex CLI not found")
  else if (lookup.kind === "error") say(deps, `OpenWork MCP: could not check (${lookup.message})`)
  else {
    const url = credential ? mcpUrl(credential.apiBaseUrl) : mcpUrl(DEFAULT_API_BASE_URL)
    const server = findOpenWorkServer(lookup.servers, MCP_SERVER_NAME, url)
    if (!server) say(deps, "OpenWork MCP: not added to Codex")
    else {
      const login = `codex ${[...profileArgs(profile.kind === "managed" ? profileName : null), "mcp", "login", server.name].join(" ")}`
      say(deps, `OpenWork MCP: available as "${server.name}"${isSignedIn(server) ? ", signed in" : ` (sign in with: ${login})`}`)
    }
  }
  return 0
}

// ---------------------------------------------------------------- models

export async function models(args: ParsedArgs, deps: Deps): Promise<number> {
  const dir = stateDir(deps.env, deps.home)
  const { inventory } = await refreshGateway(dir, await requireCredential(dir), deps)
  const usable = compatibleModels(inventory)
  if (usable.length === 0) say(deps, noModelsMessage(inventory))
  else {
    say(deps, "Models Codex can use:")
    for (const entry of usable) say(deps, `  ${modelLabel(entry)}`)
  }
  if (args.switches.has("all")) {
    const others = incompatibleModels(inventory)
    if (others.length > 0) {
      say(deps)
      say(deps, "Other models (not usable from Codex — different format):")
      for (const entry of others) say(deps, `  ${modelLabel(entry)}  [not compatible]`)
    }
  }
  return 0
}

// ---------------------------------------------------------------- token

export async function token(_args: ParsedArgs, deps: Deps): Promise<number> {
  const credential = await readCredential(stateDir(deps.env, deps.home))
  if (!credential?.gatewayKey) {
    warn(deps, `No OpenWork AI Gateway key is saved. Run: ${SELF} login, then ${SELF} setup`)
    return 1
  }
  deps.stdout.write(credential.gatewayKey)
  return 0
}

// ---------------------------------------------------------------- uninstall / logout

export async function uninstall(args: ParsedArgs, deps: Deps): Promise<number> {
  const dir = stateDir(deps.env, deps.home)
  const yes = args.switches.has("yes")
  const profileName = validateProfileName(args.values.get("profile") ?? DEFAULT_PROFILE)
  const profileFile = profilePath(codexHome(deps.env, deps.home), profileName)
  const profile = await inspectProfile(profileFile)

  say(deps, "This will:")
  if (profile.kind === "managed") say(deps, `  • Remove the Codex profile ${profileFile} (and the OpenWork MCP server it declares)`)
  else if (profile.kind === "foreign") say(deps, `  • Leave ${profileFile} alone (not created by codex-openwork)`)
  say(deps, `  • Remove the key helper from ${dir}`)
  say(deps, "Your normal Codex setup (config.toml) is not changed. Your OpenWork sign-in is kept; use logout to remove it.")
  if (!(await agree(deps, "Continue?", yes))) {
    say(deps, "Nothing was changed.")
    return 1
  }

  const removed = await removeProfile(profileFile, { stateDir: dir, now: deps.now })
  if (removed.status === "removed") say(deps, `Removed ${profileFile}${removed.backupPath ? ` (you had edited it; your version is saved as ${removed.backupPath})` : ""}`)
  else if (removed.status === "missing") say(deps, `No profile at ${profileFile}.`)
  else say(deps, `Left ${profileFile} alone: it was not created by codex-openwork.`)
  if (await removeTokenHelper(dir)) say(deps, "Removed the key helper.")
  return 0
}

export async function logout(_args: ParsedArgs, deps: Deps): Promise<number> {
  const dir = stateDir(deps.env, deps.home)
  const credential = await readCredential(dir).catch(() => null)
  if (credential) await signOut(credential, requestOptions(deps))
  const hadCredential = await removeCredential(dir)
  await removeTokenHelper(dir)
  say(deps, hadCredential ? "Signed out of OpenWork and removed the saved sign-in." : "You were not signed in.")
  const profile = await inspectProfile(profilePath(codexHome(deps.env, deps.home), DEFAULT_PROFILE)).catch(() => null)
  if (profile?.kind === "managed") {
    say(deps, `The Codex profile "${DEFAULT_PROFILE}" will not work until you sign in and run setup again. Remove it with: ${SELF} uninstall`)
  }
  return 0
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
