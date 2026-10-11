/**
 * Owner-only local state for the agent CLIs (`~/.openwork/<app>` by default).
 *
 * The directory is 0700 and files are 0600. Writes are atomic (temp file,
 * fsync, rename). Symlinks, files owned by someone else, group/world-readable
 * files, and oversized files are refused rather than trusted.
 */
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { isAllowedApiBaseUrl, isRecord, readString } from "./den.ts"

export const MAX_STATE_FILE_BYTES = 256 * 1024
export const CREDENTIALS_FILE = "credentials.json"

const POSIX = process.platform !== "win32"

export class StateError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`${message} (${path})`)
    this.name = "StateError"
    this.path = path
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function ownerUid(): number | null {
  return POSIX && typeof process.getuid === "function" ? process.getuid() : null
}

/**
 * `~/.openwork/<app>`, or the directory named by `env[envVar]` when set.
 * `app` is a short lowercase name such as "codex" or "claude".
 */
export function resolveStateDir(input: {
  app: string
  envVar?: string
  env?: Readonly<Record<string, string | undefined>>
  home?: string
}): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.app)) throw new StateError("Invalid app name", input.app)
  const env = input.env ?? process.env
  const override = input.envVar ? env[input.envVar]?.trim() : undefined
  if (override) return resolve(override)
  return join(input.home ?? homedir(), ".openwork", input.app)
}

function assertFileName(name: string): void {
  if (!name || name !== basename(name) || name === "." || name === ".." || name.startsWith(".")) {
    throw new StateError("Invalid state file name", name)
  }
}

/** Creates the directory (0700) if needed and checks that only this user can reach it. */
export async function ensureStateDir(dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new StateError("State directory must be an absolute path", dir)
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
  try {
    await mkdir(dir, { mode: 0o700 })
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error
  }
  const info = await lstat(dir)
  if (info.isSymbolicLink()) throw new StateError("Refusing to use a symlinked state directory", dir)
  if (!info.isDirectory()) throw new StateError("State path is not a directory", dir)
  const uid = ownerUid()
  if (uid !== null && info.uid !== uid) throw new StateError("State directory is owned by another user", dir)
  if (POSIX && (info.mode & 0o077) !== 0) {
    throw new StateError("State directory is accessible by other users; run chmod 700 on it", dir)
  }
  return dir
}

/** Reads and parses a JSON state file. Returns null when it does not exist. */
export async function readJson(dir: string, name: string, maxBytes: number = MAX_STATE_FILE_BYTES): Promise<unknown> {
  assertFileName(name)
  const path = join(dir, name)
  let handle: FileHandle
  try {
    // O_NOFOLLOW makes open fail on a symlink instead of reading its target.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null
    if (isErrno(error, "ELOOP") || isErrno(error, "EMLINK")) throw new StateError("Refusing to read a symlinked state file", path)
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new StateError("State path is not a regular file", path)
    const uid = ownerUid()
    if (uid !== null && info.uid !== uid) throw new StateError("State file is owned by another user", path)
    if (POSIX && (info.mode & 0o077) !== 0) throw new StateError("State file is readable by other users; run chmod 600 on it", path)
    if (info.size > maxBytes) throw new StateError("State file is too large", path)
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0)
    if (bytesRead > maxBytes) throw new StateError("State file is too large", path)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    try {
      return JSON.parse(text)
    } catch {
      throw new StateError("State file is not valid JSON", path)
    }
  } finally {
    await handle.close()
  }
}

/** Atomically writes `value` as JSON (0600) into the owner-only state directory. */
export async function writeJson(dir: string, name: string, value: unknown, maxBytes: number = MAX_STATE_FILE_BYTES): Promise<void> {
  assertFileName(name)
  await ensureStateDir(dir)
  const text = `${JSON.stringify(value, null, 2)}\n`
  const path = join(dir, name)
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new StateError("State file would be too large", path)
  try {
    const existing = await lstat(path)
    if (existing.isSymbolicLink()) throw new StateError("Refusing to replace a symlinked state file", path)
    if (!existing.isFile()) throw new StateError("State path is not a regular file", path)
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
  }
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    try {
      await handle.writeFile(text, "utf8")
      if (POSIX) await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  await syncDir(dir)
}

/** fsync the directory so the rename survives a crash (best effort; unsupported on some platforms). */
export async function syncDir(dir: string): Promise<void> {
  if (!POSIX) return
  try {
    const handle = await open(dir, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is an extra guarantee, not a requirement.
  }
}

/** Removes a state file (a symlink is removed itself, never its target). Returns whether it existed. */
export async function remove(dir: string, name: string): Promise<boolean> {
  assertFileName(name)
  try {
    await unlink(join(dir, name))
    return true
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false
    throw error
  }
}

export interface StoredCredential {
  readonly apiBaseUrl: string
  /** The Den session bearer. */
  readonly token: string
  readonly orgId: string
  readonly orgName?: string
  readonly user: { readonly id: string; readonly email: string }
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
  /** The member's `ow_gw_` AI Gateway key for `orgId`. */
  readonly gatewayKey?: string
  readonly gatewayBaseUrl?: string
}

/** Validates an untrusted value as a credential; null when anything is off. */
export function parseCredential(value: unknown): StoredCredential | null {
  if (!isRecord(value) || !isRecord(value.user)) return null
  const apiBaseUrl = readString(value.apiBaseUrl)
  const token = readString(value.token)
  const orgId = readString(value.orgId)
  const userId = readString(value.user.id)
  const email = typeof value.user.email === "string" ? value.user.email : null
  const expiresAt = value.expiresAt
  if (!apiBaseUrl || !isAllowedApiBaseUrl(apiBaseUrl) || !token || !orgId || !userId || email === null) return null
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null
  if (value.orgName !== undefined && typeof value.orgName !== "string") return null
  let gatewayKey: string | undefined
  if (value.gatewayKey !== undefined) {
    if (typeof value.gatewayKey !== "string" || !value.gatewayKey.startsWith("ow_gw_")) return null
    gatewayKey = value.gatewayKey
  }
  let gatewayBaseUrl: string | undefined
  if (value.gatewayBaseUrl !== undefined) {
    if (typeof value.gatewayBaseUrl !== "string" || !isAllowedApiBaseUrl(value.gatewayBaseUrl)) return null
    gatewayBaseUrl = value.gatewayBaseUrl
  }
  return {
    apiBaseUrl,
    token,
    orgId,
    ...(typeof value.orgName === "string" ? { orgName: value.orgName } : {}),
    user: { id: userId, email },
    expiresAt,
    ...(gatewayKey ? { gatewayKey } : {}),
    ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}),
  }
}

/** Reads `credentials.json`; null when missing. Throws StateError when present but invalid or unsafe. */
export async function readCredential(dir: string): Promise<StoredCredential | null> {
  const raw = await readJson(dir, CREDENTIALS_FILE)
  if (raw === null) return null
  const credential = parseCredential(raw)
  if (!credential) throw new StateError("Saved OpenWork sign-in is invalid; sign in again", join(dir, CREDENTIALS_FILE))
  return credential
}

export async function writeCredential(dir: string, credential: StoredCredential): Promise<void> {
  const valid = parseCredential(credential)
  if (!valid) throw new StateError("Refusing to save an invalid OpenWork sign-in", join(dir, CREDENTIALS_FILE))
  await writeJson(dir, CREDENTIALS_FILE, valid)
}

export function removeCredential(dir: string): Promise<boolean> {
  return remove(dir, CREDENTIALS_FILE)
}
