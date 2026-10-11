import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findCodexBinary, installIntoCodex, runCodexJson } from "../scripts/native-install.mjs"

const installed = { pluginId: "openwork-local@local-personal", name: "openwork-local", marketplaceName: "local-personal", version: "0.2.0-local", installedPath: "/fixture/cache/receiver" }

test("native installation uses official add/list and verifies exact installed enabled identity", async () => {
  const calls = []
  const result = await installIntoCodex({ executable: "/fixture/codex", pluginName: "openwork-local", marketplaceName: "local-personal", version: installed.version, run: async (executable, args) => {
    calls.push({ executable, args })
    return args[1] === "add" ? installed : { installed: [{ ...installed, installed: true, enabled: true }] }
  } })
  assert.equal(result.installed, true)
  assert.equal(result.enabled, true)
  assert.deepEqual(calls.map(call => call.args), [["plugin", "add", installed.pluginId, "--json"], ["plugin", "list", "--marketplace", "local-personal", "--json"]])
  assert.equal(calls.some(call => call.args.includes("--enable")), false)
  assert.match(result.message, /remain yours to approve/)
})

test("catalogued-only, disabled or wrong-version entries can never be reported installed and ready", async () => {
  for (const list of [{ installed: [] }, { installed: [{ ...installed, installed: true, enabled: false }] }, { installed: [{ ...installed, installed: true, enabled: true, version: "older" }] }]) {
    await assert.rejects(installIntoCodex({ executable: "/fixture/codex", pluginName: "openwork-local", marketplaceName: "local-personal", version: installed.version, run: async (_executable, args) => args[1] === "add" ? installed : list }), /not installed and enabled/)
  }
  await assert.rejects(installIntoCodex({ executable: "/fixture/codex", pluginName: "openwork-local", marketplaceName: "local-personal", version: installed.version, run: async () => ({ ...installed, pluginId: "different-cloud-plugin" }) }), /requested receiver/)
})

test("explicit executable is preferred without a shell or permission override", async () => {
  assert.equal(await findCodexBinary({ executable: process.execPath, environment: {} }), process.execPath)
})

test("native command errors are bounded and never echo credential/configuration stderr", async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "codex-native-install-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const good = join(directory, "good.mjs")
  await writeFile(good, "console.log(JSON.stringify({ok:true}))\n")
  assert.deepEqual(await runCodexJson(process.execPath, [good]), { ok: true })
  const bad = join(directory, "bad.mjs")
  await writeFile(bad, "console.error('fixture-only-secret');process.exit(1)\n")
  await assert.rejects(runCodexJson(process.execPath, [bad]), error => /not verified/.test(error.message) && !error.message.includes("fixture-only-secret"))
})
