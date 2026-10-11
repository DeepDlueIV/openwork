import { homedir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { normalizeApiBaseUrl } from "./auth.mjs"

const MAX_STATE_BYTES = 1024 * 1024
const stateLimit = name => /^journal-[a-f0-9]{32}\.json$/.test(name) ? 32 * 1024 * 1024 : MAX_STATE_BYTES
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

export function defaultStateDirectory() {
  return resolve(process.env.OPENWORK_CODEX_STATE_DIR || join(homedir(), ".openwork", "codex-plugin"))
}

async function optionalStat(path) {
  try { return await lstat(path) } catch (error) { if (error.code === "ENOENT") return null; throw error }
}

/** Refuse symlinks and repo-local secrets, including linked git worktrees. */
async function assertStatePath(directory) {
  const root = resolve(directory)
  let current = root
  while (true) {
    const info = await optionalStat(current)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("OpenWork state path must use real directories, not symlinks.")
    if (await optionalStat(join(current, ".git"))) throw new Error("OpenWork credentials must be stored outside a Git repository.")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (root === parse(root).root) throw new Error("OpenWork state cannot use the filesystem root.")
  return root
}

function assertOwner(info) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("OpenWork state must be owned by the current user.")
}

async function secureDirectory(directory, create) {
  const path = await assertStatePath(directory)
  let info = await optionalStat(path)
  if (!info && create) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    info = await lstat(path)
  }
  if (info) {
    assertOwner(info)
    if (process.platform !== "win32" && (info.mode & 0o077)) {
      if (!create) throw new Error("OpenWork state directory permissions must be owner-only (0700).")
      await chmod(path, 0o700)
    }
  }
  return { path, exists: Boolean(info) }
}

function assertFileName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name)) throw new Error("Invalid OpenWork state file name.")
}

async function readState(name, directory = defaultStateDirectory()) {
  assertFileName(name)
  const { path, exists } = await secureDirectory(directory, false)
  if (!exists) return null
  const file = join(path, name)
  const info = await optionalStat(file)
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("OpenWork state must be a regular file, not a symlink.")
  assertOwner(info)
  if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("OpenWork state file permissions must be owner-only (0600).")
  const handle = await open(file, "r")
  try {
    const opened = await handle.stat()
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > stateLimit(name)) throw new Error("OpenWork state file changed or exceeded the size limit.")
    const text = await handle.readFile("utf8")
    if (Buffer.byteLength(text) > stateLimit(name)) throw new Error("OpenWork state exceeded the size limit.")
    try { return JSON.parse(text) } catch { throw new Error("OpenWork state contains invalid JSON.") }
  } finally { await handle.close() }
}

async function writeState(name, value, directory = defaultStateDirectory()) {
  assertFileName(name)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > stateLimit(name)) throw new Error("OpenWork state exceeded the size limit.")
  const { path } = await secureDirectory(directory, true)
  const destination = join(path, name)
  const existing = await optionalStat(destination)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Refusing to replace non-file OpenWork state.")
    assertOwner(existing)
  }
  const temporary = join(path, `.${name}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(text, "utf8"); await handle.sync() } finally { await handle.close() }
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
  return destination
}

function validateCredentials(value) {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token.trim() || typeof value.orgId !== "string" || !value.orgId.trim() || typeof value.apiBaseUrl !== "string") {
    throw new Error("Invalid OpenWork credentials. Sign in with the setup command.")
  }
  normalizeApiBaseUrl(value.apiBaseUrl)
  if (value.expiresAt !== undefined && value.expiresAt !== null && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) {
    throw new Error("Invalid OpenWork credential expiry.")
  }
  return value
}

export async function readCredentials(stateDirectory = defaultStateDirectory()) {
  const value = await readState("credentials.json", stateDirectory)
  if (value === null) return null
  validateCredentials(value)
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) return null
  return value
}

export async function writeCredentials(credentials, stateDirectory = defaultStateDirectory()) {
  return writeState("credentials.json", validateCredentials(credentials), stateDirectory)
}

export async function deleteCredentials(stateDirectory = defaultStateDirectory()) {
  const { path } = await secureDirectory(stateDirectory, false)
  await rm(join(path, "credentials.json"), { force: true })
}

/** Empty config means unenrolled: callers must require explicit user consent. */
export async function readConfig(stateDirectory = defaultStateDirectory()) {
  const value = await readState("config.json", stateDirectory)
  if (value === null) return {}
  if (!isRecord(value)) throw new Error("Invalid OpenWork configuration.")
  return value
}

export async function writeConfig(config, stateDirectory = defaultStateDirectory()) {
  if (!isRecord(config)) throw new Error("Invalid OpenWork configuration.")
  return writeState("config.json", config, stateDirectory)
}

export { writeState as writeStateFile, readState as readStateFile }
