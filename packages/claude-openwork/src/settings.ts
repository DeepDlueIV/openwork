/**
 * Edits of Claude Code's user settings (`~/.claude/settings.json`).
 *
 * Every key this tool sets is recorded with the value it had before
 * (`ManagedSettings`), so uninstall can restore exactly what was there, and
 * leave alone anything the user changed afterwards.
 */
import { join } from "node:path"
import { isRecord } from "../../agent-gateway-core/src/index.ts"

export type Settings = Record<string, unknown>

/** A key's state: absent, or present with a JSON value. */
export interface Slot {
  readonly present: boolean
  readonly value?: unknown
}

/** `["apiKeyHelper"]`, `["model"]` or `["env", "<NAME>"]`. */
export type SettingPath = readonly [string] | readonly [string, string]

export interface ManagedEntry {
  readonly path: SettingPath
  readonly before: Slot
  readonly after: Slot
}

export interface SettingsChanges {
  readonly entries: readonly ManagedEntry[]
  /** The `env` object did not exist and was created. */
  readonly createdEnv: boolean
  readonly createdPermissions: boolean
  readonly createdDeny: boolean
  /** Entries this tool appended to `permissions.deny`. */
  readonly denyAdded: readonly string[]
  /** settings.json did not exist before setup. */
  readonly createdFile: boolean
}

export interface DesiredSettings {
  readonly apiKeyHelper: string
  readonly env: Readonly<Record<string, string>>
  readonly model: string
  readonly denyWebSearch: boolean
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsError"
  }
}

export interface Conflict {
  readonly path: SettingPath
  readonly reason: string
}

export class SettingsConflictError extends Error {
  readonly conflicts: readonly Conflict[]
  constructor(conflicts: readonly Conflict[]) {
    super(
      [
        "Claude Code is already configured to use other credentials or another endpoint:",
        ...conflicts.map((conflict) => `  - ${formatPath(conflict.path)}: ${conflict.reason}`),
        "Pass --force to replace these (the previous values are saved and restored by uninstall).",
      ].join("\n"),
    )
    this.name = "SettingsConflictError"
    this.conflicts = conflicts
  }
}

export const WEB_SEARCH_TOOL = "WebSearch"

/** Keys whose presence means Claude Code would authenticate or route somewhere else. */
export const COMPETING_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function settingsPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return join(override || join(home, ".claude"), "settings.json")
}

export function formatPath(path: SettingPath): string {
  return path.join(".")
}

/** Parses settings.json text. Missing or blank files are `{}`; anything other than a JSON object is refused. */
export function parseSettings(text: string | null, path: string): Settings {
  if (text === null || !text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SettingsError(
      `${path} is not valid JSON (comments and trailing commas are not supported). Fix it, then run this again.`,
    )
  }
  if (!isRecord(parsed)) throw new SettingsError(`${path} must contain a JSON object.`)
  return parsed
}

/** Indentation of an existing file (2 spaces when it cannot tell). */
export function detectIndent(text: string | null): string {
  const match = text ? /^\{\r?\n([ \t]+)\S/.exec(text) : null
  return match?.[1] ?? "  "
}

export function serializeSettings(settings: Settings, indent: string): string {
  return `${JSON.stringify(settings, null, indent)}\n`
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  }
  return false
}

function slotEqual(left: Slot, right: Slot): boolean {
  return left.present === right.present && (!left.present || deepEqual(left.value, right.value))
}

/** The key's slot, or null when its parent exists but is not an object. */
export function getSlot(settings: Settings, path: SettingPath): Slot | null {
  if (path.length === 1) {
    return Object.hasOwn(settings, path[0]) ? { present: true, value: settings[path[0]] } : { present: false }
  }
  if (!Object.hasOwn(settings, path[0])) return { present: false }
  const parent = settings[path[0]]
  if (!isRecord(parent)) return null
  return Object.hasOwn(parent, path[1]) ? { present: true, value: parent[path[1]] } : { present: false }
}

function setSlot(settings: Settings, path: SettingPath, slot: Slot): void {
  if (path.length === 1) {
    if (slot.present) settings[path[0]] = slot.value
    else delete settings[path[0]]
    return
  }
  let parent = settings[path[0]]
  if (!isRecord(parent)) {
    if (!slot.present) return
    parent = {}
    settings[path[0]] = parent
  }
  if (!isRecord(parent)) return
  if (slot.present) parent[path[1]] = slot.value
  else delete parent[path[1]]
}

function cloneSettings(settings: Settings): Settings {
  const copy: unknown = structuredClone(settings)
  if (!isRecord(copy)) throw new SettingsError("Could not copy the settings.")
  return copy
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

export interface RevertResult {
  readonly settings: Settings
  /** Keys left alone because they changed after setup. */
  readonly warnings: readonly string[]
  /** Whether the result is empty and the file only exists because of setup. */
  readonly removeFile: boolean
}

/**
 * Undoes `changes`: each key still holding the value setup wrote gets its
 * previous value back (or is removed if it did not exist). Keys changed since
 * are left as they are and reported.
 */
export function revertSettings(current: Settings, changes: SettingsChanges): RevertResult {
  const settings = cloneSettings(current)
  const warnings: string[] = []
  for (const entry of [...changes.entries].reverse()) {
    const slot = getSlot(settings, entry.path)
    if (slot && slotEqual(slot, entry.after)) {
      setSlot(settings, entry.path, entry.before)
    } else {
      warnings.push(`${formatPath(entry.path)} was changed after setup, so it was left as it is.`)
    }
  }
  if (changes.createdEnv && isEmptyObject(settings.env)) delete settings.env
  const permissions = settings.permissions
  if (changes.denyAdded.length > 0 && isRecord(permissions) && Array.isArray(permissions.deny)) {
    const deny: unknown[] = permissions.deny
    for (const rule of changes.denyAdded) {
      const index = deny.indexOf(rule)
      if (index >= 0) deny.splice(index, 1)
    }
    if (changes.createdDeny && deny.length === 0) delete permissions.deny
  }
  if (changes.createdPermissions && isEmptyObject(settings.permissions)) delete settings.permissions
  return { settings, warnings, removeFile: changes.createdFile && Object.keys(settings).length === 0 }
}

export interface ApplyResult {
  readonly settings: Settings
  readonly changes: SettingsChanges
}

/**
 * Applies the gateway configuration to `current`. `acknowledged` holds the
 * previous values a former setup already replaced with the user's consent;
 * they do not count as conflicts again. Without `force`, an existing
 * different apiKeyHelper or ANTHROPIC_BASE_URL, or any competing credential
 * or cloud-provider switch in `env`, is refused. With `force`, those are
 * replaced or removed (and restored by uninstall).
 */
export function applySetup(
  current: Settings,
  desired: DesiredSettings,
  options: { force: boolean; createdFile: boolean; acknowledged?: readonly ManagedEntry[] },
): ApplyResult {
  const settings = cloneSettings(current)
  const env = settings.env
  if (env !== undefined && !isRecord(env)) throw new SettingsError('"env" in settings.json is not an object; fix it, then run this again.')
  const permissions = settings.permissions
  if (desired.denyWebSearch) {
    if (permissions !== undefined && !isRecord(permissions)) {
      throw new SettingsError('"permissions" in settings.json is not an object; fix it, or pass --no-deny-websearch.')
    }
    if (isRecord(permissions) && permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
      throw new SettingsError('"permissions.deny" in settings.json is not a list; fix it, or pass --no-deny-websearch.')
    }
  }

  const targets: { path: SettingPath; after: Slot; guarded: boolean }[] = [
    { path: ["apiKeyHelper"], after: { present: true, value: desired.apiKeyHelper }, guarded: true },
  ]
  for (const [name, value] of Object.entries(desired.env)) {
    targets.push({ path: ["env", name], after: { present: true, value }, guarded: name === "ANTHROPIC_BASE_URL" })
  }
  for (const name of COMPETING_ENV_KEYS) {
    if (Object.hasOwn(desired.env, name)) continue
    targets.push({ path: ["env", name], after: { present: false }, guarded: true })
  }
  targets.push({ path: ["model"], after: { present: true, value: desired.model }, guarded: false })

  const conflicts: Conflict[] = []
  const entries: ManagedEntry[] = []
  for (const target of targets) {
    const before = getSlot(settings, target.path) ?? { present: false }
    if (slotEqual(before, target.after)) continue
    if (target.guarded && before.present) {
      const acknowledged = options.acknowledged?.some(
        (entry) => deepEqual(entry.path, target.path) && slotEqual(entry.before, before),
      )
      if (!acknowledged) {
        conflicts.push({
          path: target.path,
          reason: target.after.present ? "already set to a different value" : "set, and would take precedence over the OpenWork gateway",
        })
      }
    }
    entries.push({ path: target.path, before, after: target.after })
  }
  if (conflicts.length > 0 && !options.force) throw new SettingsConflictError(conflicts)

  const createdEnv = entries.some((entry) => entry.path[0] === "env" && entry.after.present) && env === undefined
  for (const entry of entries) setSlot(settings, entry.path, entry.after)

  let createdPermissions = false
  let createdDeny = false
  const denyAdded: string[] = []
  if (desired.denyWebSearch) {
    let perms = settings.permissions
    if (!isRecord(perms)) {
      perms = {}
      settings.permissions = perms
      createdPermissions = true
    }
    if (isRecord(perms)) {
      let deny = perms.deny
      if (!Array.isArray(deny)) {
        deny = []
        perms.deny = deny
        createdDeny = true
      }
      if (Array.isArray(deny) && !deny.includes(WEB_SEARCH_TOOL)) {
        deny.push(WEB_SEARCH_TOOL)
        denyAdded.push(WEB_SEARCH_TOOL)
      }
    }
  }

  return {
    settings,
    changes: { entries, createdEnv, createdPermissions, createdDeny, denyAdded, createdFile: options.createdFile },
  }
}

function parseSlot(value: unknown): Slot | null {
  if (!isRecord(value) || typeof value.present !== "boolean") return null
  return value.present ? { present: true, value: value.value } : { present: false }
}

function parsePath(value: unknown): SettingPath | null {
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string" && part.length > 0)) return null
  const [first, second] = value
  if (typeof first !== "string") return null
  if (value.length === 1) return [first]
  if (value.length === 2 && typeof second === "string") return [first, second]
  return null
}

/** Validates the recorded changes read back from the state directory. */
export function parseChanges(value: unknown): SettingsChanges | null {
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.denyAdded)) return null
  const entries: ManagedEntry[] = []
  for (const raw of value.entries) {
    if (!isRecord(raw)) return null
    const path = parsePath(raw.path)
    const before = parseSlot(raw.before)
    const after = parseSlot(raw.after)
    if (!path || !before || !after) return null
    entries.push({ path, before, after })
  }
  const denyAdded: string[] = []
  for (const rule of value.denyAdded) {
    if (typeof rule !== "string") return null
    denyAdded.push(rule)
  }
  return {
    entries,
    createdEnv: value.createdEnv === true,
    createdPermissions: value.createdPermissions === true,
    createdDeny: value.createdDeny === true,
    denyAdded,
    createdFile: value.createdFile === true,
  }
}
