import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIpcClient, createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/ipc.mjs"

async function serverFor(t, onMessage) {
  const directory = await mkdtemp(join(tmpdir(), "ow-ipc-")), path = join(directory, "ipc.sock"), sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {})
    const decode = createFrameDecoder(message => onMessage(message, socket))
    socket.on("data", decode)
  })
  await new Promise(resolve => server.listen(path, resolve))
  await chmod(path, 0o600)
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return { path, directory }
}
function success(socket, request, result, owner = "owner") {
  socket.write(encodeFrame({ type: "response", requestId: request.requestId, resultType: "success", method: request.method, handledByClientId: owner, result }))
}

test("LE32 decoder handles byte splits, multibyte Unicode and concatenated frames", () => {
  const values = [{ text: "héllo 🚀" }, { id: 2 }], received = []
  const bytes = Buffer.concat(values.map(value => encodeFrame(value))), decode = createFrameDecoder(value => received.push(value))
  for (const byte of bytes) decode(Buffer.from([byte]))
  assert.deepEqual(received, values)
})
test("decoder rejects zero, oversize, malformed JSON and invalid UTF-8", () => {
  for (const size of [0, MAX_FRAME_BYTES + 1]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(size)
    assert.throws(() => createFrameDecoder(() => {})(header), { code: "invalid_frame_length" })
  }
  const malformed = Buffer.from([1, 0, 0, 0, 0xff])
  assert.throws(() => createFrameDecoder(() => {})(malformed), { code: "invalid_frame_json" })
  assert.throws(() => encodeFrame({ text: "x".repeat(MAX_FRAME_BYTES) }), { code: "frame_too_large" })
})
test("router handshake, targeted versions, decline discovery and no arbitrary methods", async t => {
  const seen = []
  const { path } = await serverFor(t, (request, socket) => {
    seen.push(request)
    if (request.method === "initialize") success(socket, request, { clientId: "client" })
    else if (request.method === "thread-owner-discovery") {
      socket.write(encodeFrame({ type: "client-discovery-request", requestId: "probe", request }))
      success(socket, request, { supportsUntrustedAppInput: true })
    } else if (request.method === "thread-follower-read-model-settings") success(socket, request, { settings: {} })
  })
  const client = createIpcClient({ socketPath: path }); t.after(() => client.close())
  await client.request("thread-owner-discovery", { hostId: "local", conversationId: "fixture" })
  await client.request("thread-follower-read-model-settings", { conversationId: "fixture" }, { targetClientId: "owner" })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(seen[0].version, 0)
  const read = seen.find(request => request.method === "thread-follower-read-model-settings")
  assert.equal(read.version, 1); assert.equal(read.targetClientId, "owner"); assert.equal(read.sourceClientId, "client"); assert.equal(read.hostId, undefined)
  assert.deepEqual(seen.find(request => request.type === "client-discovery-response").response, { canHandle: false })
  await assert.rejects(client.request("thread/start", {}), { code: "unsupported_method" })
})
test("unsafe socket permissions are rejected without connection", async t => {
  let connected = false
  const { path } = await serverFor(t, () => { connected = true })
  await chmod(path, 0o666)
  const client = createIpcClient({ socketPath: path }); t.after(() => client.close())
  await assert.rejects(client.connect(), { code: "unsafe_socket_permissions" })
  assert.equal(connected, false)
})
test("route rejections are distinguished from dispatched handler errors and timeout", async t => {
  let mode = "reject"
  const { path } = await serverFor(t, (request, socket) => {
    if (request.method === "initialize") return success(socket, request, { clientId: "client" })
    if (mode === "timeout") return
    socket.write(encodeFrame({ type: "response", requestId: request.requestId, resultType: "error", error: mode === "reject" ? "no-client-found" : "private handler error" }))
  })
  const client = createIpcClient({ socketPath: path, timeoutMs: 40 }); t.after(() => client.close())
  await assert.rejects(client.request("thread-follower-start-turn", {}), error => error.rejection && error.dispatched)
  mode = "handler"
  await assert.rejects(client.request("thread-follower-start-turn", {}), error => !error.rejection && error.dispatched && !error.message.includes("private"))
  mode = "timeout"
  await assert.rejects(client.request("thread-follower-start-turn", {}), { code: "request_timeout", dispatched: true })
})
test("disconnect never replays a dispatched mutation", async t => {
  let sends = 0
  const { path } = await serverFor(t, (request, socket) => {
    if (request.method === "initialize") return success(socket, request, { clientId: "client" })
    sends++; socket.destroy()
  })
  const client = createIpcClient({ socketPath: path }); t.after(() => client.close())
  await assert.rejects(client.request("thread-follower-start-turn", {}), { dispatched: true })
  assert.equal(sends, 1)
})
