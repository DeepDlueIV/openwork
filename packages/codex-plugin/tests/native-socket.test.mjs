import test from "node:test"
import assert from "node:assert/strict"
import { validateNativeSocket, recheckNativeSocket } from "../src/native-socket.mjs"

const uid = process.getuid?.() ?? 501
const leaf = "00000000-0000-4000-8000-000000000001.sock"
const logical = `/tmp/codex-browser-use/${leaf}`
const canonical = `/private/tmp/codex-browser-use/${leaf}`
const info = (type, owner, mode, extra = {}) => ({ uid: owner, mode, dev: 1, ino: 2, isDirectory: () => type === "directory", isSocket: () => type === "socket", isSymbolicLink: () => type === "symlink", ...extra })
function filesystem(changes = {}) {
  const entries = {
    [logical]: info("socket", uid, 0o600),
    [canonical]: info("socket", uid, 0o600),
    "/tmp/codex-browser-use": info("directory", uid, 0o1777),
    "/private/tmp/codex-browser-use": info("directory", uid, 0o1777),
    "/tmp": info("symlink", 0, 0o755),
    "/private/tmp": info("directory", 0, 0o1777),
    "/private": info("directory", 0, 0o755),
    "/": info("directory", 0, 0o755), ...changes,
  }
  return { lstat: async path => { if (!entries[path]) throw new Error("missing"); return entries[path] }, realpath: async () => canonical, readlink: async () => "/private/tmp" }
}

test("accepts the actual Codex layout without chmod or bypassing peer authorization", async () => {
  const fs = filesystem()
  const result = await validateNativeSocket(logical, { uid, platform: "darwin", fs })
  assert.deepEqual(result, { path: canonical, dev: 1, ino: 2 })
  await recheckNativeSocket(result, fs)
})

test("shared layout still rejects foreign ownership, nonsticky writes, leaf aliases and broad socket access", async () => {
  const cases = [
    { [logical]: info("socket", uid + 1, 0o600) },
    { [logical]: info("symlink", uid, 0o600) },
    { [canonical]: info("socket", uid, 0o666) },
    { "/private/tmp/codex-browser-use": info("directory", uid, 0o777) },
    { "/private/tmp": info("directory", 0, 0o777) },
    { "/private": info("directory", uid + 1, 0o755) },
    { "/tmp": info("symlink", uid + 1, 0o755) },
  ]
  for (const changes of cases) await assert.rejects(validateNativeSocket(logical, { uid, platform: "darwin", fs: filesystem(changes) }), /unsafe_native_pipe/)
  await assert.rejects(validateNativeSocket(logical, { uid, platform: "linux", fs: filesystem() }), /unsafe_native_pipe/)
})

test("the shared exception cannot admit arbitrary paths or symlink chains", async () => {
  const fs = filesystem()
  fs.readlink = async () => "/untrusted/target"
  await assert.rejects(validateNativeSocket(logical, { uid, platform: "darwin", fs }), /unsafe_native_pipe/)
  const arbitrary = filesystem({ "/other/shared/app.sock": info("socket", uid, 0o600), "/other/shared": info("directory", uid, 0o1777) })
  await assert.rejects(validateNativeSocket("/other/shared/app.sock", { uid, platform: "darwin", fs: arbitrary }), /unsafe_native_pipe/)
})

test("replacement during connection is rejected before requests can be transmitted", async () => {
  const result = await validateNativeSocket(logical, { uid, platform: "darwin", fs: filesystem() })
  await assert.rejects(recheckNativeSocket(result, filesystem({ [canonical]: info("socket", uid, 0o600, { ino: 99 }) })), /unsafe_native_pipe/)
  await assert.rejects(recheckNativeSocket(result, filesystem({ [canonical]: info("socket", uid + 1, 0o600) })), /unsafe_native_pipe/)
})
