/** What setup changed, kept in the state directory so uninstall can undo exactly that. */
import { isRecord, readJson, readString, remove, writeJson } from "../../agent-gateway-core/src/index.ts"
import { parseChanges, type SettingsChanges } from "./settings.ts"

export const MANAGED_FILE = "managed-settings.json"

export interface ManagedState {
  readonly version: 1
  readonly settingsPath: string
  readonly providerId: string
  readonly providerName: string
  readonly model: string
  readonly fastModel: string
  readonly baseUrl: string
  readonly helperPath: string
  readonly apiKeyHelper: string
  /** setup ran `claude mcp add` for the `openwork` server (uninstall removes it). */
  readonly mcpAdded: boolean
  readonly mcpUrl: string | null
  readonly updatedAt: number
  readonly changes: SettingsChanges
}

export function parseManaged(value: unknown): ManagedState | null {
  if (!isRecord(value) || value.version !== 1) return null
  const settingsPath = readString(value.settingsPath)
  const providerId = readString(value.providerId)
  const model = readString(value.model)
  const fastModel = readString(value.fastModel)
  const baseUrl = readString(value.baseUrl)
  const helperPath = readString(value.helperPath)
  const apiKeyHelper = readString(value.apiKeyHelper)
  const changes = parseChanges(value.changes)
  if (!settingsPath || !providerId || !model || !fastModel || !baseUrl || !helperPath || !apiKeyHelper || !changes) return null
  return {
    version: 1,
    settingsPath,
    providerId,
    providerName: readString(value.providerName) ?? providerId,
    model,
    fastModel,
    baseUrl,
    helperPath,
    apiKeyHelper,
    mcpAdded: value.mcpAdded === true,
    mcpUrl: readString(value.mcpUrl),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    changes,
  }
}

export class ManagedStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManagedStateError"
  }
}

export async function readManaged(stateDir: string): Promise<ManagedState | null> {
  const raw = await readJson(stateDir, MANAGED_FILE)
  if (raw === null) return null
  const managed = parseManaged(raw)
  if (!managed) {
    throw new ManagedStateError(
      `The record of what setup changed (${MANAGED_FILE}) is damaged. Check your Claude Code settings by hand, then delete that file.`,
    )
  }
  return managed
}

export function writeManaged(stateDir: string, managed: ManagedState): Promise<void> {
  return writeJson(stateDir, MANAGED_FILE, managed)
}

export function removeManaged(stateDir: string): Promise<boolean> {
  return remove(stateDir, MANAGED_FILE)
}
