import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

test("CLI and installer execute through macOS temporary-path aliases", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "codex-entrypoint-"))
  try {
    for (const [source, arg, expected] of [["../src/cli.mjs", "help", /OpenWork Codex local prototype/], ["../scripts/install.mjs", "--help", /Copies the built local plugin/]]) {
      const alias = join(directory, source.includes("cli") ? "cli.mjs" : "install.mjs")
      await symlink(fileURLToPath(new URL(source, import.meta.url)), alias)
      const result = spawnSync(process.execPath, [alias, arg], { encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, expected)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
