/**
 * Safe edits of a user's tool config (e.g. ~/.codex/config.toml,
 * ~/.claude/settings.json): atomic replace, a timestamped owner-only backup of
 * the previous file, the existing file mode kept, and symlinks refused.
 */
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { syncDir } from "./state.ts"

const POSIX = process.platform !== "win32"
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024

export class FileSafetyError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`${message} (${path})`)
    this.name = "FileSafetyError"
    this.path = path
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

/** `20261011T121600123Z`: sortable and safe in file names on every platform. */
export function backupTimestamp(time: number): string {
  return new Date(time).toISOString().replace(/[-:.]/g, "")
}

async function existingFile(path: string): Promise<{ mode: number; size: number } | null> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new FileSafetyError("Refusing to edit a symlinked file", path)
    if (!info.isFile()) throw new FileSafetyError("Not a regular file", path)
    return { mode: info.mode & 0o777, size: info.size }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null
    throw error
  }
}

/** Reads a text file; null when missing. Refuses symlinks and oversized files. */
export async function readTextFile(path: string, maxBytes: number = MAX_TEXT_FILE_BYTES): Promise<string | null> {
  const existing = await existingFile(path)
  if (!existing) return null
  if (existing.size > maxBytes) throw new FileSafetyError("File is too large to edit", path)
  return readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })
}

async function writeExclusive(path: string, content: string, mode: number): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode)
  try {
    await handle.writeFile(content, "utf8")
    if (POSIX) await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface WriteTextResult {
  readonly path: string
  /** Where the previous content was saved, or null when there was none or nothing changed. */
  readonly backupPath: string | null
  readonly changed: boolean
}

/**
 * Atomically writes `content` to `path`. When the file exists with different
 * content, its previous content is first copied to
 * `<path>.openwork-backup-<timestamp>` (mode 0600). The new file keeps the
 * old file's mode; new files get `mode` (default 0600).
 */
export async function writeTextFileWithBackup(
  path: string,
  content: string,
  options: { mode?: number; now?: () => number; backup?: boolean } = {},
): Promise<WriteTextResult> {
  const now = options.now ?? Date.now
  const existing = await existingFile(path)
  let backupPath: string | null = null
  if (existing) {
    const previous = await readTextFile(path)
    if (previous === content) return { path, backupPath: null, changed: false }
    if (options.backup !== false && previous !== null) {
      const stem = `${path}.openwork-backup-${backupTimestamp(now())}`
      for (let attempt = 0; ; attempt++) {
        const candidate = attempt === 0 ? stem : `${stem}-${attempt}`
        try {
          await writeExclusive(candidate, previous, 0o600)
          backupPath = candidate
          break
        } catch (error) {
          if (!isErrno(error, "EEXIST") || attempt >= 99) throw error
        }
      }
    }
  } else {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  }
  const mode = existing ? existing.mode : (options.mode ?? 0o600)
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeExclusive(tmp, content, mode)
    // Re-check right before the swap so a symlink planted meanwhile is never replaced.
    await existingFile(path)
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  await syncDir(dir)
  return { path, backupPath, changed: true }
}
