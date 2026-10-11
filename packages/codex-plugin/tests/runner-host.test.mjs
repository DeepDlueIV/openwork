import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRunnerLock, startRunnerHost } from "../src/runner-host.mjs"
import { writeCredentials, writeConfig } from "../src/state.mjs"

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

test("host pins its adapter partition; token renewal is safe but account replacement releases ownership", () => temporary(async directory => {
  const stateDirectory = join(directory, "state")
  const credential = { apiBaseUrl: "https://den.example.test", token: "member-token-a", orgId: "org-a", user: { id: "user-a" }, expiresAt: "2099-01-01T00:00:00.000Z" }
  const config = { remoteSessions: true, nativeProjectScope: true, installationId: "installation-a", directory, project: { projectId: "project-a" }, coordinatorThreadId: "coordinator-a" }
  await writeCredentials(credential, stateDirectory)
  await writeConfig(config, stateDirectory)
  let account, started, closes = 0
  const ready = new Promise(resolve => { started = resolve })
  const host = await startRunnerHost({ stateDirectory, adapterFactory: async () => ({}), runnerFactory: options => {
    account = options.account
    return {
      inspectStatus: () => ({ state: "connected" }),
      run: async signal => { await account(); started(); if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })) },
      close: async () => { closes++ },
    }
  } })
  try {
    await ready
    await writeCredentials({ ...credential, token: "member-token-renewed" }, stateDirectory)
    assert.equal((await account()).token, "member-token-renewed")
    assert.equal(host.owned, true)
    await writeCredentials({ ...credential, user: { id: "user-b" } }, stateDirectory)
    assert.equal(await account(), null)
    await host.close()
    assert.equal(host.owned, false)
    assert.equal(closes, 1)
    const release = await acquireRunnerLock(stateDirectory)
    assert.equal(typeof release, "function")
    await release()
    await host.close()
    assert.equal(closes, 1)
  } finally { await host.close() }
}))
