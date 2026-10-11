import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { promisify } from "node:util"
import { QuoteError, helperCommand, shellQuote, writeHelper } from "./helper.ts"

const run = promisify(execFile)
const POSIX = process.platform !== "win32"
const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-ow-helper-"))
  roots.push(root)
  const dir = join(root, "state")
  return dir
}

test("quotes paths with spaces and shell metacharacters for sh", async () => {
  assert.equal(shellQuote("/usr/bin/node", "darwin"), '"/usr/bin/node"')
  assert.equal(shellQuote('/a b/"q"/$HOME/`x`/back\\slash', "linux"), '"/a b/\\"q\\"/\\$HOME/\\`x\\`/back\\\\slash"')
  assert.equal(shellQuote("C:\\Program Files\\nodejs\\node.exe", "win32"), '"C:\\Program Files\\nodejs\\node.exe"')
  assert.throws(() => shellQuote('C:\\a"b', "win32"), QuoteError)
  assert.throws(() => shellQuote("/a\nb", "linux"), QuoteError)
  assert.throws(() => shellQuote("", "linux"), QuoteError)
  if (POSIX) {
    const tricky = "/tmp/it's a \"dir\" $USER `id`"
    const { stdout } = await run("/bin/sh", ["-c", `printf %s ${shellQuote(tricky)}`])
    assert.equal(stdout, tricky)
  }
})

test("helper prints only the gateway key, through the apiKeyHelper command", async () => {
  const dir = await stateDir()
  const helper = await writeHelper(dir)
  if (POSIX) assert.equal((await stat(helper)).mode & 0o777, 0o700)
  await writeFile(join(dir, "credentials.json"), JSON.stringify({ token: "den-secret", gatewayKey: "ow_gw_abc123" }), { mode: 0o600 })
  const direct = await run(process.execPath, [helper])
  assert.equal(direct.stdout, "ow_gw_abc123\n")
  assert.equal(direct.stderr, "")
  if (POSIX) {
    const viaShell = await run("/bin/sh", ["-c", helperCommand(process.execPath, helper, process.platform)])
    assert.equal(viaShell.stdout, "ow_gw_abc123\n")
  }
})

async function failure(helper: string): Promise<{ stdout: string; stderr: string }> {
  try {
    await run(process.execPath, [helper])
  } catch (error) {
    assert.ok(error instanceof Error && "stdout" in error && "stderr" in error)
    return { stdout: String(error.stdout), stderr: String(error.stderr) }
  }
  assert.fail("helper should have failed")
}

test("helper refuses missing, malformed, unsafe or loose credential files", async () => {
  const dir = await stateDir()
  const helper = await writeHelper(dir)
  const credentials = join(dir, "credentials.json")

  let result = await failure(helper)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /not signed in/)

  await writeFile(credentials, JSON.stringify({ gatewayKey: "sk-not-ours\nextra" }), { mode: 0o600 })
  result = await failure(helper)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /no AI Gateway key/)

  if (POSIX) {
    await writeFile(credentials, JSON.stringify({ gatewayKey: "ow_gw_abc" }), { mode: 0o600 })
    await chmod(credentials, 0o644)
    result = await failure(helper)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /readable by other users/)
    assert.doesNotMatch(result.stderr, /ow_gw_/)

    await rm(credentials)
    const elsewhere = join(dir, "..", "other.json")
    await writeFile(elsewhere, JSON.stringify({ gatewayKey: "ow_gw_abc" }), { mode: 0o600 })
    await symlink(elsewhere, credentials)
    result = await failure(helper)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /symlink/)
  }
})
