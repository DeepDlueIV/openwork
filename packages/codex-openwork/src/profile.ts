import { createHash } from "node:crypto"
import { unlink } from "node:fs/promises"
import { readJson, readTextFile, remove, writeJson, writeTextFileWithBackup } from "../../agent-gateway-core/src/index.ts"
import { isManagedProfile } from "./toml.ts"

export class ProfileConflictError extends Error {
  readonly path: string
  constructor(path: string) {
    super(
      `${path} already exists and was not created by codex-openwork. `
        + "Choose another name with --profile, or pass --force to replace it (a backup is kept).",
    )
    this.name = "ProfileConflictError"
    this.path = path
  }
}

export type ProfileState = { readonly kind: "missing" } | { readonly kind: "managed"; readonly text: string } | { readonly kind: "foreign" }

export async function inspectProfile(path: string): Promise<ProfileState> {
  const text = await readTextFile(path)
  if (text === null) return { kind: "missing" }
  return isManagedProfile(text) ? { kind: "managed", text } : { kind: "foreign" }
}

// The state dir remembers a hash of each profile exactly as we last wrote it.
// While the file still matches, it holds nothing of the user's, so rewriting
// or removing it needs no backup and repeated setups leave no extra files.
const WRITTEN_FILE = "written-profiles.json"

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function readWritten(stateDir: string): Promise<Record<string, string>> {
  const value = await readJson(stateDir, WRITTEN_FILE).catch(() => null)
  const out: Record<string, string> = {}
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, hash] of Object.entries(value)) if (typeof hash === "string") out[key] = hash
  }
  return out
}

async function recordWritten(stateDir: string, path: string, text: string | null): Promise<void> {
  const written = await readWritten(stateDir)
  if (text === null) delete written[path]
  else written[path] = digest(text)
  if (Object.keys(written).length === 0) await remove(stateDir, WRITTEN_FILE)
  else await writeJson(stateDir, WRITTEN_FILE, written)
}

async function untouchedSinceWritten(stateDir: string, path: string, text: string): Promise<boolean> {
  return (await readWritten(stateDir))[path] === digest(text)
}

export interface ProfileWriteResult {
  readonly status: "created" | "updated" | "unchanged"
  readonly backupPath: string | null
}

/** Writes the profile file; refuses to replace a file we did not create unless `force`. */
export async function writeProfile(
  path: string,
  content: string,
  options: { stateDir: string; force?: boolean; now?: () => number },
): Promise<ProfileWriteResult> {
  const state = await inspectProfile(path)
  if (state.kind === "foreign" && !options.force) throw new ProfileConflictError(path)
  const backup = state.kind === "foreign" || (state.kind === "managed" && !(await untouchedSinceWritten(options.stateDir, path, state.text)))
  const result = await writeTextFileWithBackup(path, content, { mode: 0o600, now: options.now, backup })
  await recordWritten(options.stateDir, path, content)
  if (!result.changed) return { status: "unchanged", backupPath: null }
  return { status: state.kind === "missing" ? "created" : "updated", backupPath: result.backupPath }
}

export type ProfileRemoveResult =
  | { readonly status: "removed"; readonly backupPath: string | null }
  | { readonly status: "missing" }
  | { readonly status: "foreign" }

/**
 * Removes the profile file only when it carries our marker. A backup copy is
 * kept only when the file was edited after we wrote it.
 */
export async function removeProfile(path: string, options: { stateDir: string; now?: () => number }): Promise<ProfileRemoveResult> {
  const state = await inspectProfile(path)
  if (state.kind === "missing") {
    await recordWritten(options.stateDir, path, null)
    return { status: "missing" }
  }
  if (state.kind === "foreign") return { status: "foreign" }
  let backupPath: string | null = null
  if (!(await untouchedSinceWritten(options.stateDir, path, state.text))) {
    // Emptying the file through the safe writer saves the edited text as a timestamped backup first.
    const saved = await writeTextFileWithBackup(path, "", { mode: 0o600, now: options.now, backup: true })
    backupPath = saved.backupPath
  }
  await unlink(path)
  await recordWritten(options.stateDir, path, null)
  return { status: "removed", backupPath }
}
