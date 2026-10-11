/**
 * The `apiKeyHelper` Claude Code runs to get the gateway key.
 *
 * It is a small self-contained script written into the owner-only state
 * directory, next to `credentials.json`, so it keeps working after `npx`
 * clears its cache. It prints the member's `ow_gw_` key and nothing else, and
 * refuses to read a credential file that is a symlink, owned by someone else,
 * or readable by other users.
 */
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { ensureStateDir, writeTextFileWithBackup } from "../../agent-gateway-core/src/index.ts"

export const HELPER_FILE = "token-helper.mjs"

export class QuoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QuoteError"
  }
}

/**
 * Double-quotes one argument for the shell Claude Code runs apiKeyHelper with
 * (`sh` on macOS/Linux; on Windows, quoting is limited to paths without `"`
 * or `%`).
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (!value || /[\0\r\n]/.test(value)) throw new QuoteError("Cannot use an empty path or one with line breaks.")
  if (platform === "win32") {
    if (/["%]/.test(value)) throw new QuoteError(`Cannot safely quote a path containing " or %: ${value}`)
    return `"${value}"`
  }
  return `"${value.replace(/["\\$`]/g, (char) => `\\${char}`)}"`
}

export function helperCommand(nodePath: string, helperPath: string, platform: NodeJS.Platform = process.platform): string {
  return `${shellQuote(nodePath, platform)} ${shellQuote(helperPath, platform)}`
}

export function helperPath(stateDir: string): string {
  return join(stateDir, HELPER_FILE)
}

export const HELPER_SOURCE = `// Written by claude-openwork. Claude Code runs this as its apiKeyHelper.
// Prints the OpenWork AI Gateway key saved next to it, and nothing else.
import { constants } from "node:fs"
import { lstatSync, closeSync, fstatSync, openSync, readSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BYTES = 256 * 1024
const posix = process.platform !== "win32"
const uid = posix && typeof process.getuid === "function" ? process.getuid() : null

function fail(message) {
  process.stderr.write("claude-openwork: " + message + "\\n")
  process.exit(1)
}

const dir = dirname(fileURLToPath(import.meta.url))
const file = join(dir, "credentials.json")
let text
try {
  const dirInfo = lstatSync(dir)
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) fail("the state directory is not a plain directory.")
  if (uid !== null && dirInfo.uid !== uid) fail("the state directory is owned by another user.")
  if (posix && (dirInfo.mode & 0o077) !== 0) fail("the state directory is accessible by other users; run chmod 700 on it.")
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  } catch (error) {
    if (error && error.code === "ENOENT") fail("not signed in. Run: npx claude-openwork login")
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) fail("refusing to read a symlinked credential file.")
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) fail("the credential file is not a regular file.")
    if (uid !== null && info.uid !== uid) fail("the credential file is owned by another user.")
    if (posix && (info.mode & 0o077) !== 0) fail("the credential file is readable by other users; run chmod 600 on it.")
    if (info.size > MAX_BYTES) fail("the credential file is too large.")
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const read = readSync(fd, buffer, 0, MAX_BYTES + 1, 0)
    if (read > MAX_BYTES) fail("the credential file is too large.")
    text = buffer.subarray(0, read).toString("utf8")
  } finally {
    closeSync(fd)
  }
} catch (error) {
  fail("could not read the saved sign-in" + (error && error.code ? " (" + error.code + ")" : "") + ".")
}
let key
try {
  const parsed = JSON.parse(text)
  key = parsed && typeof parsed === "object" ? parsed.gatewayKey : undefined
} catch {
  fail("the saved sign-in is not valid. Run: npx claude-openwork login")
}
if (typeof key !== "string" || !/^ow_gw_[A-Za-z0-9_-]+$/.test(key)) {
  fail("no AI Gateway key is saved. Run: npx claude-openwork login")
}
process.stdout.write(key + "\\n")
`

/** Writes the helper (0700) into the state directory and returns its path. */
export async function writeHelper(stateDir: string): Promise<string> {
  await ensureStateDir(stateDir)
  const path = helperPath(stateDir)
  await writeTextFileWithBackup(path, HELPER_SOURCE, { mode: 0o700, backup: false })
  if (process.platform !== "win32") await chmod(path, 0o700)
  return path
}
