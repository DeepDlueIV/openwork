import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { stableNodePath } from "./node-path.ts"

test("prefers a PATH node that resolves to the running binary", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "node-path-"))
  const cellar = join(root, "Cellar", "node", "25.2.1", "bin")
  const bin = join(root, "bin")
  const other = join(root, "other")
  for (const dir of [cellar, bin, other]) mkdirSync(dir, { recursive: true })
  const real = join(cellar, "node")
  writeFileSync(real, "")
  writeFileSync(join(other, "node"), "")
  symlinkSync(real, join(bin, "node"))

  assert.equal(stableNodePath(real, [other, bin].join(":"), "darwin"), join(bin, "node"))
  assert.equal(stableNodePath(real, other, "darwin"), real)
  assert.equal(stableNodePath(real, undefined, "darwin"), real)
  assert.equal(stableNodePath(real, "relative/bin", "darwin"), real)
})
