import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import {
  StateError,
  ensureStateDir,
  parseCredential,
  readCredential,
  readJson,
  remove,
  removeCredential,
  resolveStateDir,
  writeCredential,
  writeJson,
  type StoredCredential,
} from "./state.ts"

const POSIX = process.platform !== "win32"
const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agw-state-"))
  roots.push(root)
  return root
}

const credential: StoredCredential = {
  apiBaseUrl: "https://api.openworklabs.com",
  token: "den-token",
  orgId: "org_1",
  orgName: "Acme",
  user: { id: "u1", email: "a@example.com" },
  expiresAt: 1_800_000_000_000,
  gatewayKey: "ow_gw_abc",
  gatewayBaseUrl: "https://gateway.example.com",
}

test("state dir defaults to ~/.openwork/<app> and honours the env override", () => {
  assert.equal(resolveStateDir({ app: "codex", home: "/home/me", env: {} }), "/home/me/.openwork/codex")
  assert.equal(
    resolveStateDir({ app: "claude", home: "/home/me", envVar: "CLAUDE_OPENWORK_HOME", env: { CLAUDE_OPENWORK_HOME: "/tmp/x" } }),
    "/tmp/x",
  )
  assert.equal(resolveStateDir({ app: "claude", home: "/home/me", envVar: "CLAUDE_OPENWORK_HOME", env: { CLAUDE_OPENWORK_HOME: " " } }), "/home/me/.openwork/claude")
  assert.throws(() => resolveStateDir({ app: "../etc", env: {} }), StateError)
})

test("writes atomically with owner-only permissions and reads back", async () => {
  const dir = join(await tempRoot(), ".openwork", "codex")
  await writeJson(dir, "state.json", { a: 1 })
  await writeJson(dir, "state.json", { a: 2 })
  assert.deepEqual(await readJson(dir, "state.json"), { a: 2 })
  assert.deepEqual(await readdir(dir), ["state.json"])
  if (POSIX) {
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(join(dir, "state.json"))).mode & 0o777, 0o600)
  }
  assert.equal(await readJson(dir, "missing.json"), null)
  assert.equal(await remove(dir, "state.json"), true)
  assert.equal(await remove(dir, "state.json"), false)
})

test("refuses path tricks in file names", async () => {
  const dir = join(await tempRoot(), "s")
  await assert.rejects(writeJson(dir, "../escape.json", {}), StateError)
  await assert.rejects(readJson(dir, ".hidden"), StateError)
})

test("refuses symlinked files and directories", { skip: !POSIX }, async () => {
  const root = await tempRoot()
  const dir = join(root, "s")
  await ensureStateDir(dir)
  const target = join(root, "target.json")
  await writeFile(target, "{}", { mode: 0o600 })
  await symlink(target, join(dir, "linked.json"))
  await assert.rejects(readJson(dir, "linked.json"), /symlink/)
  await assert.rejects(writeJson(dir, "linked.json", { a: 1 }), /symlink/)
  const realDir = join(root, "real")
  await mkdir(realDir, { mode: 0o700 })
  await symlink(realDir, join(root, "linkdir"))
  await assert.rejects(ensureStateDir(join(root, "linkdir")), /symlink/)
  // remove() unlinks the link itself, never the target.
  assert.equal(await remove(dir, "linked.json"), true)
  assert.equal((await stat(target)).isFile(), true)
})

test("refuses group/world-accessible state", { skip: !POSIX }, async () => {
  const root = await tempRoot()
  const dir = join(root, "s")
  await writeJson(dir, "state.json", {})
  await chmod(join(dir, "state.json"), 0o644)
  await assert.rejects(readJson(dir, "state.json"), /readable by other users/)
  await chmod(dir, 0o755)
  await assert.rejects(writeJson(dir, "other.json", {}), /accessible by other users/)
})

test("refuses oversized and invalid files", async () => {
  const dir = join(await tempRoot(), "s")
  await ensureStateDir(dir)
  await writeFile(join(dir, "big.json"), JSON.stringify({ x: "y".repeat(2_000) }), { mode: 0o600 })
  await assert.rejects(readJson(dir, "big.json", 1_000), /too large/)
  await assert.rejects(writeJson(dir, "big.json", { x: "y".repeat(2_000) }, 1_000), /too large/)
  await writeFile(join(dir, "bad.json"), "{nope", { mode: 0o600 })
  await assert.rejects(readJson(dir, "bad.json"), /not valid JSON/)
})

test("credential schema round-trips and rejects unsafe values", async () => {
  const dir = join(await tempRoot(), "s")
  assert.equal(await readCredential(dir), null)
  await writeCredential(dir, credential)
  assert.deepEqual(await readCredential(dir), credential)
  assert.equal(parseCredential({ ...credential, apiBaseUrl: "http://den.example.com" }), null)
  assert.equal(parseCredential({ ...credential, gatewayKey: "sk-other" }), null)
  assert.equal(parseCredential({ ...credential, gatewayBaseUrl: "http://gateway.example.com" }), null)
  assert.equal(parseCredential({ ...credential, expiresAt: "soon" }), null)
  assert.equal(parseCredential({ ...credential, orgId: "" }), null)
  const { gatewayKey: _key, gatewayBaseUrl: _base, orgName: _name, ...minimal } = credential
  assert.deepEqual(parseCredential(minimal), minimal)
  await assert.rejects(writeCredential(dir, { ...credential, token: "" }), StateError)
  await writeJson(dir, "credentials.json", { token: "x" })
  await assert.rejects(readCredential(dir), /invalid/)
  assert.equal(await removeCredential(dir), true)
})
