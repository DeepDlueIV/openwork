import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { FileSafetyError, backupTimestamp, readTextFile, writeTextFileWithBackup } from "./files.ts"

const POSIX = process.platform !== "win32"
const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agw-files-"))
  roots.push(root)
  return root
}

const NOW = Date.parse("2026-10-11T12:16:00.123Z")

test("creates a new file (0600 by default) without a backup", async () => {
  const path = join(await tempRoot(), "nested", "config.toml")
  const result = await writeTextFileWithBackup(path, "a = 1\n", { now: () => NOW })
  assert.deepEqual(result, { path, backupPath: null, changed: true })
  assert.equal(await readFile(path, "utf8"), "a = 1\n")
  if (POSIX) assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test("backs up the previous content (0600), keeps the file mode, and leaves no temp files", async () => {
  const root = await tempRoot()
  const path = join(root, "settings.json")
  await writeFile(path, "old", { mode: 0o644 })
  if (POSIX) await chmod(path, 0o644)
  const result = await writeTextFileWithBackup(path, "new", { now: () => NOW })
  assert.equal(result.changed, true)
  assert.equal(result.backupPath, `${path}.openwork-backup-${backupTimestamp(NOW)}`)
  assert.equal(backupTimestamp(NOW), "20261011T121600123Z")
  assert.equal(await readFile(path, "utf8"), "new")
  assert.equal(await readFile(result.backupPath ?? "", "utf8"), "old")
  if (POSIX) {
    assert.equal((await stat(path)).mode & 0o777, 0o644)
    assert.equal((await stat(result.backupPath ?? "")).mode & 0o777, 0o600)
  }
  // A second write in the same millisecond does not overwrite the first backup.
  const again = await writeTextFileWithBackup(path, "newer", { now: () => NOW })
  assert.equal(again.backupPath, `${path}.openwork-backup-${backupTimestamp(NOW)}-1`)
  assert.equal(await readFile(again.backupPath ?? "", "utf8"), "new")
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".tmp")).length, 0)
})

test("identical content is a no-op", async () => {
  const path = join(await tempRoot(), "same.txt")
  await writeFile(path, "same")
  assert.deepEqual(await writeTextFileWithBackup(path, "same"), { path, backupPath: null, changed: false })
})

test("refuses symlink targets", { skip: !POSIX }, async () => {
  const root = await tempRoot()
  const target = join(root, "real.toml")
  await writeFile(target, "real")
  const link = join(root, "link.toml")
  await symlink(target, link)
  await assert.rejects(writeTextFileWithBackup(link, "evil"), FileSafetyError)
  await assert.rejects(readTextFile(link), FileSafetyError)
  assert.equal(await readFile(target, "utf8"), "real")
})

test("readTextFile returns null when missing", async () => {
  assert.equal(await readTextFile(join(await tempRoot(), "none")), null)
})
