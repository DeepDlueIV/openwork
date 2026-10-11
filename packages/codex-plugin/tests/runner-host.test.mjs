import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRunnerLock } from "../src/runner-host.mjs"

async function temporary(fn) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "codex-runner-lock-"))
  try { await fn(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("multiple Codex MCP instances cannot own the same runner", () => temporary(async directory => {
  const release = await acquireRunnerLock(directory)
  assert.equal(typeof release, "function")
  assert.equal(await acquireRunnerLock(directory), null)
  await release()
  const again = await acquireRunnerLock(directory)
  assert.equal(typeof again, "function")
  await again()
}))
test("unknown lock owners cannot be evicted by missed heartbeat", () => temporary(async directory => {
  await writeFile(join(directory, "runner.lock"), "unknown-owner", { mode: 0o600 })
  assert.equal(await acquireRunnerLock(directory), null)
}))
