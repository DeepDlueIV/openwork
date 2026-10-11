/**
 * The token helper Codex runs as `model_providers.openwork.auth.command`.
 *
 * It is a small standalone script copied into the owner-only state directory,
 * so it keeps working when codex-openwork itself was run once through npx and
 * is no longer installed. It reads `credentials.json` next to itself with the
 * same safety checks as the CLI and prints only the AI Gateway key.
 */
import { ensureStateDir, remove, writeTextFileWithBackup } from "../../agent-gateway-core/src/index.ts"
import { HELPER_FILE, SELF, helperPath } from "./paths.ts"

export const TOKEN_HELPER_SOURCE = [
  "#!/usr/bin/env node",
  "// Managed by codex-openwork. Codex runs this to get your OpenWork AI Gateway key.",
  "// It prints only the key. Remove it with: " + SELF + " uninstall",
  'import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"',
  'import { dirname, join } from "node:path"',
  'import { fileURLToPath } from "node:url"',
  "",
  "const MAX_BYTES = 256 * 1024",
  'const POSIX = process.platform !== "win32"',
  "const dir = dirname(fileURLToPath(import.meta.url))",
  'const file = join(dir, "credentials.json")',
  "const uid = POSIX && typeof process.getuid === \"function\" ? process.getuid() : null",
  "",
  "function fail(message) {",
  '  process.stderr.write("codex-openwork: " + message + "\\n")',
  "  process.exit(1)",
  "}",
  "",
  "const dirInfo = lstatSync(dir)",
  'if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) fail("refusing to use the state directory " + dir)',
  'if (uid !== null && dirInfo.uid !== uid) fail("the state directory is owned by another user (" + dir + ")")',
  'if (POSIX && (dirInfo.mode & 0o077) !== 0) fail("the state directory is accessible by other users; run chmod 700 " + dir)',
  "",
  "let fd",
  "try {",
  "  fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))",
  "} catch (error) {",
  '  const code = error && typeof error === "object" && "code" in error ? error.code : null',
  '  if (code === "ENOENT") fail("not signed in to OpenWork. Run: ' + SELF + ' login")',
  '  if (code === "ELOOP" || code === "EMLINK") fail("refusing to read a symlinked credentials file (" + file + ")")',
  '  fail("cannot read " + file)',
  "}",
  "",
  'let text = ""',
  "try {",
  "  const info = fstatSync(fd)",
  '  if (!info.isFile()) fail("credentials path is not a regular file (" + file + ")")',
  '  if (uid !== null && info.uid !== uid) fail("the credentials file is owned by another user (" + file + ")")',
  '  if (POSIX && (info.mode & 0o077) !== 0) fail("the credentials file is readable by other users; run chmod 600 " + file)',
  '  if (info.size > MAX_BYTES) fail("the credentials file is too large (" + file + ")")',
  "  const buffer = Buffer.alloc(MAX_BYTES + 1)",
  "  const bytes = readSync(fd, buffer, 0, MAX_BYTES + 1, 0)",
  '  if (bytes > MAX_BYTES) fail("the credentials file is too large (" + file + ")")',
  '  text = buffer.subarray(0, bytes).toString("utf8")',
  "} finally {",
  "  closeSync(fd)",
  "}",
  "",
  "let key = null",
  "try {",
  "  const value = JSON.parse(text)",
  '  if (value && typeof value === "object" && typeof value.gatewayKey === "string") key = value.gatewayKey',
  "} catch {",
  '  fail("the saved OpenWork sign-in is not valid. Run: ' + SELF + ' login")',
  "}",
  'if (!key || !key.startsWith("ow_gw_") || /\\s/.test(key)) {',
  '  fail("no OpenWork AI Gateway key is saved. Run: ' + SELF + ' setup")',
  "}",
  "process.stdout.write(key)",
  "",
].join("\n")

/** Writes the helper (0700) into the state directory and returns its absolute path. */
export async function installTokenHelper(dir: string): Promise<string> {
  await ensureStateDir(dir)
  const path = helperPath(dir)
  await writeTextFileWithBackup(path, TOKEN_HELPER_SOURCE, { mode: 0o700, backup: false })
  return path
}

export function removeTokenHelper(dir: string): Promise<boolean> {
  return remove(dir, HELPER_FILE)
}
