import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, stat } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { writeCredential, writeJson } from "../../agent-gateway-core/src/index.ts"
import { installTokenHelper, removeTokenHelper } from "./helper.ts"
import { DEN_TOKEN, GATEWAY_KEY, credential, tempDir } from "./test-support.ts"

const POSIX = process.platform !== "win32"

function runHelper(path: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path], { encoding: "utf8", env: {} })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test("the helper prints only the gateway key", async () => {
  const dir = await tempDir()
  try {
    const state = join(dir.path, "state")
    await writeCredential(state, credential({ gatewayKey: GATEWAY_KEY, gatewayBaseUrl: "https://gateway.example.com" }))
    const helper = await installTokenHelper(state)
    if (POSIX) assert.equal((await stat(helper)).mode & 0o777, 0o700)
    const result = runHelper(helper)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, GATEWAY_KEY)
    assert.equal(result.stderr, "")
    assert.ok(!result.stdout.includes(DEN_TOKEN))
    assert.equal(await removeTokenHelper(state), true)
  } finally {
    await dir.cleanup()
  }
})

test("the helper fails clearly without a key or sign-in", async () => {
  const dir = await tempDir()
  try {
    const state = join(dir.path, "state")
    const helper = await installTokenHelper(state)
    const missing = runHelper(helper)
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, "")
    assert.match(missing.stderr, /not signed in/)

    await writeCredential(state, credential())
    const noKey = runHelper(helper)
    assert.equal(noKey.status, 1)
    assert.equal(noKey.stdout, "")
    assert.match(noKey.stderr, /no OpenWork AI Gateway key/)
    assert.ok(!noKey.stderr.includes(DEN_TOKEN))
  } finally {
    await dir.cleanup()
  }
})

test("the helper refuses a credentials file other users can read", { skip: !POSIX }, async () => {
  const dir = await tempDir()
  try {
    const state = join(dir.path, "state")
    await writeJson(state, "credentials.json", { gatewayKey: GATEWAY_KEY })
    const helper = await installTokenHelper(state)
    await chmod(join(state, "credentials.json"), 0o644)
    const result = runHelper(helper)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /readable by other users/)
  } finally {
    await dir.cleanup()
  }
})
