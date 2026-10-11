import assert from "node:assert/strict"
import { readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { FileSafetyError } from "../../agent-gateway-core/src/index.ts"
import { codexHome, profilePath, validateProfileName } from "./paths.ts"
import { ProfileConflictError, removeProfile, writeProfile } from "./profile.ts"
import { renderProfile } from "./toml.ts"
import { tempDir } from "./test-support.ts"

const POSIX = process.platform !== "win32"

function profile(model: string): string {
  return renderProfile({ profileName: "openwork", model, gatewayBaseUrl: "https://g.example.com", nodePath: "/node", helperPath: "/h.mjs" })
}

test("profile paths follow CODEX_HOME and validate the name", () => {
  assert.equal(codexHome({}, "/home/me"), join("/home/me", ".codex"))
  assert.equal(codexHome({ CODEX_HOME: "/x/codex" }, "/home/me"), "/x/codex")
  assert.equal(profilePath("/x/codex", "openwork"), join("/x/codex", "openwork.config.toml"))
  for (const bad of ["", "../evil", "a/b", "-x", "config", "a b"]) assert.throws(() => validateProfileName(bad))
})

test("creates, rewrites its own untouched file without a backup, and leaves an identical file alone", async () => {
  const dir = await tempDir()
  try {
    const stateDir = join(dir.path, "state")
    const path = join(dir.path, "codex", "openwork.config.toml")
    const created = await writeProfile(path, profile("gwm_a"), { stateDir, now: () => 0 })
    assert.deepEqual(created, { status: "created", backupPath: null })
    if (POSIX) assert.equal((await stat(path)).mode & 0o777, 0o600)

    assert.deepEqual(await writeProfile(path, profile("gwm_a"), { stateDir }), { status: "unchanged", backupPath: null })

    const updated = await writeProfile(path, profile("gwm_b"), { stateDir, now: () => 0 })
    assert.deepEqual(updated, { status: "updated", backupPath: null })
    assert.equal(await readFile(path, "utf8"), profile("gwm_b"))
    assert.deepEqual(await readdir(join(dir.path, "codex")), ["openwork.config.toml"])
  } finally {
    await dir.cleanup()
  }
})

test("keeps a backup when rewriting a managed profile the user edited", async () => {
  const dir = await tempDir()
  try {
    const stateDir = join(dir.path, "state")
    const path = join(dir.path, "openwork.config.toml")
    await writeProfile(path, profile("gwm_a"), { stateDir })
    const edited = `${profile("gwm_a")}# my note\n`
    await writeFile(path, edited)

    const updated = await writeProfile(path, profile("gwm_b"), { stateDir, now: () => 0 })
    assert.equal(updated.status, "updated")
    assert.ok(updated.backupPath)
    assert.equal(await readFile(updated.backupPath, "utf8"), edited)
    assert.equal(await readFile(path, "utf8"), profile("gwm_b"))
  } finally {
    await dir.cleanup()
  }
})

test("a managed profile with no record (state dir lost) is backed up before rewriting", async () => {
  const dir = await tempDir()
  try {
    const path = join(dir.path, "openwork.config.toml")
    await writeFile(path, profile("gwm_a"))
    const updated = await writeProfile(path, profile("gwm_b"), { stateDir: join(dir.path, "state"), now: () => 0 })
    assert.ok(updated.backupPath)
    assert.equal(await readFile(updated.backupPath, "utf8"), profile("gwm_a"))
  } finally {
    await dir.cleanup()
  }
})

test("refuses to replace a profile file it did not create unless forced", async () => {
  const dir = await tempDir()
  try {
    const stateDir = join(dir.path, "state")
    const path = join(dir.path, "openwork.config.toml")
    await writeFile(path, 'model = "o3"\n')
    await assert.rejects(writeProfile(path, profile("gwm_a"), { stateDir }), ProfileConflictError)
    assert.equal(await readFile(path, "utf8"), 'model = "o3"\n')

    const forced = await writeProfile(path, profile("gwm_a"), { stateDir, force: true })
    assert.equal(forced.status, "updated")
    assert.ok(forced.backupPath)
    assert.equal(await readFile(forced.backupPath, "utf8"), 'model = "o3"\n')
  } finally {
    await dir.cleanup()
  }
})

test("refuses to write through a symlink", { skip: !POSIX }, async () => {
  const dir = await tempDir()
  try {
    const target = join(dir.path, "target.toml")
    await writeFile(target, profile("gwm_a"))
    const path = join(dir.path, "openwork.config.toml")
    await symlink(target, path)
    await assert.rejects(writeProfile(path, profile("gwm_b"), { stateDir: join(dir.path, "state") }), FileSafetyError)
    assert.equal(await readFile(target, "utf8"), profile("gwm_a"))
  } finally {
    await dir.cleanup()
  }
})

test("removeProfile removes only our file, without a backup when untouched", async () => {
  const dir = await tempDir()
  try {
    const stateDir = join(dir.path, "state")
    const ours = join(dir.path, "openwork.config.toml")
    await writeProfile(ours, profile("gwm_a"), { stateDir })
    assert.deepEqual(await removeProfile(ours, { stateDir, now: () => 0 }), { status: "removed", backupPath: null })
    assert.deepEqual(await removeProfile(ours, { stateDir }), { status: "missing" })
    assert.ok(!(await readdir(dir.path)).some((name) => name.includes("openwork-backup")))
    assert.ok(!(await readdir(stateDir).catch((): string[] => [])).includes("written-profiles.json"))

    const theirs = join(dir.path, "mine.config.toml")
    await writeFile(theirs, 'model = "o3"\n')
    assert.deepEqual(await removeProfile(theirs, { stateDir }), { status: "foreign" })
    assert.ok((await readdir(dir.path)).includes("mine.config.toml"))
  } finally {
    await dir.cleanup()
  }
})

test("removeProfile keeps a backup of a managed profile the user edited", async () => {
  const dir = await tempDir()
  try {
    const stateDir = join(dir.path, "state")
    const ours = join(dir.path, "openwork.config.toml")
    await writeProfile(ours, profile("gwm_a"), { stateDir })
    const edited = `${profile("gwm_a")}# my note\n`
    await writeFile(ours, edited)
    const removed = await removeProfile(ours, { stateDir, now: () => 0 })
    assert.equal(removed.status, "removed")
    assert.ok(removed.status === "removed" && removed.backupPath)
    assert.equal(await readFile(removed.backupPath, "utf8"), edited)
    assert.ok(!(await readdir(dir.path)).includes("openwork.config.toml"))
  } finally {
    await dir.cleanup()
  }
})
