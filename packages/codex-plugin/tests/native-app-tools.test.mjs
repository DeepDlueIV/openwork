import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/ipc.mjs"
import { createNativeAppToolsClient, parseNativeTextResult, normalizeLocalProjects } from "../src/native-app-tools.mjs"

const metadata = (callId = "fixture-call") => ({ callId, "x-codex-turn-metadata": { thread_id: "fixture-thread", turn_id: "fixture-turn" } })
const args = { prompt: "Fixture authorized task", title: "Fixture title", target: { type: "project", projectId: "fixture-project", environment: { type: "local" } } }
const textResult = value => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] })
const catalog = { tools: ["create_thread", "list_projects"].map(name => ({ name, namespace: "codex_app", inputSchema: { type: "object" } })) }
const reply = (socket, request, result) => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result }))

async function serverFor(t, handler, listHandler) {
  const directory = await mkdtemp(join(tmpdir(), "ow-native-")), path = join(directory, "app.sock"), sockets = new Set(), requests = []
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    const decode = createFrameDecoder(request => {
      requests.push(request)
      if (request.method === "tools/list") {
        if (listHandler) listHandler(request, socket)
        else reply(socket, request, catalog)
      } else handler(request, socket)
    })
    socket.on("data", decode)
  })
  await new Promise(resolve => server.listen(path, resolve))
  await chmod(path, 0o600)
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { path, requests }
}
function clientFor(t, path, timeoutMs = 1000) {
  const client = createNativeAppToolsClient({ pipePath: path, timeoutMs })
  t.after(() => client.close())
  return client
}
const invoke = (client, overrides = {}) => client.invokeOnce({ tool: "create_thread", args, metadata: metadata(), signal: new AbortController().signal, confirmed: true, ...overrides })

// Only fake owner-private Unix servers are used; never the installed app pipe.
test("catalog reads are claim-free and native invocation preserves authentic IDs", async t => {
  const { path, requests } = await serverFor(t, (request, socket) => reply(socket, request, textResult({ threadId: "fixture-child", hostId: "local" })))
  const client = clientFor(t, path), signal = new AbortController().signal
  assert.deepEqual(await client.listTools(signal), catalog.tools)
  assert.deepEqual(await client.listTools(signal), catalog.tools)
  assert.deepEqual(parseNativeTextResult(await invoke(client)), { threadId: "fixture-child", hostId: "local" })
  const call = requests.find(request => request.method === "tools/call")
  assert.deepEqual(call.params, { arguments: args, callerSource: "codex", callId: "fixture-call", threadId: "fixture-thread", turnId: "fixture-turn", hostId: "local", namespace: "codex_app", tool: "create_thread" })
  assert.equal(typeof call.id, "number")
  assert.notEqual(call.id, call.params.callId)
})

test("metadata supports actual serialized turn metadata and no ID fallbacks", async t => {
  const { path, requests } = await serverFor(t, (request, socket) => reply(socket, request, textResult({ schemaVersion: 2, projects: [] })))
  const client = clientFor(t, path)
  const source = { callId: "serialized-call", "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread", turn_id: "turn" }) }
  await invoke(client, { tool: "list_projects", args: {}, metadata: source, confirmed: false })
  assert.equal(requests.find(request => request.method === "tools/call").params.threadId, "thread")
  for (const value of [undefined, {}, { callId: "x" }, { ...metadata(), callId: undefined }, { callId: "x", "x-codex-turn-metadata": "malformed private data" }, { callId: "x", threadId: "guessed", turnId: "guessed" }]) {
    await assert.rejects(invoke(client, { metadata: value }), error => error.rejection && !error.dispatched && !error.message.includes("private"))
  }
  assert.equal(requests.filter(request => request.method === "tools/call").length, 1)
})

test("same authentic identity is single-use across native tool names and signal objects", async t => {
  const { path, requests } = await serverFor(t, (request, socket) => reply(socket, request, textResult({ schemaVersion: 2, projects: [] })))
  const client = clientFor(t, path)
  await invoke(client, { tool: "list_projects", args: {}, confirmed: false })
  await assert.rejects(invoke(client), { code: "caller_already_used", rejection: true, dispatched: false })
  await invoke(client, { metadata: metadata("next-genuine-call") })
  assert.equal(requests.filter(request => request.method === "tools/call").length, 2)
})

test("create requires explicit confirmation, prompt, local project and no policy overrides", async t => {
  const { path, requests } = await serverFor(t, () => {})
  const client = clientFor(t, path)
  await assert.rejects(invoke(client, { confirmed: false }), { code: "explicit_confirmation_required", dispatched: false })
  for (const value of [{ ...args, prompt: undefined }, { ...args, prompt: "" }, { ...args, cwd: "/private" }, { ...args, model: "override" }, { ...args, target: { type: "projectless" } }, { ...args, target: { ...args.target, environment: { type: "worktree" } } }, { ...args, target: { ...args.target, environment: { type: "local", approvalPolicy: "never" } } }]) {
    await assert.rejects(invoke(client, { args: value }), { code: "invalid_arguments", dispatched: false })
  }
  await assert.rejects(invoke(client, { tool: "send_message_to_thread" }), { code: "unsupported_native_tool" })
  await assert.rejects(invoke(client, { tool: "list_projects", args: { injected: true } }), { code: "invalid_arguments" })
  assert.equal(requests.length, 0)
})

test("invocations require live owner signal and pre-abort never dispatches", async t => {
  const { path, requests } = await serverFor(t, () => {})
  const client = clientFor(t, path), controller = new AbortController()
  controller.abort(new Error("private abort reason"))
  await assert.rejects(invoke(client, { signal: undefined }), { code: "invocation_signal_required" })
  await assert.rejects(invoke(client, { signal: controller.signal }), error => error.code === "aborted" && !error.dispatched && !error.message.includes("private"))
  assert.equal(requests.length, 0)
})

test("cancelled dispatched create is ambiguous; unique caller reconnects without replay or claim reset", async t => {
  const controller = new AbortController()
  let calls = 0
  const { path, requests } = await serverFor(t, (request, socket) => {
    if (request.method !== "tools/call") return
    if (++calls === 1) controller.abort(new Error("private reason"))
    else reply(socket, request, textResult({ threadId: "recovered", hostId: "local" }))
  })
  const client = clientFor(t, path)
  await assert.rejects(invoke(client, { signal: controller.signal }), error => error.code === "aborted" && error.dispatched && error.ambiguous && !error.message.includes("private"))
  assert.deepEqual(parseNativeTextResult(await invoke(client, { metadata: metadata("other") })), { threadId: "recovered", hostId: "local" })
  await assert.rejects(invoke(client), { code: "caller_already_used", dispatched: false })
  assert.deepEqual(requests.filter(request => request.method === "tools/call").map(request => request.params.callId), ["fixture-call", "other"])
})

test("disconnect and timeout are ambiguous; new genuine invocation recovers without replay", async t => {
  for (const mode of ["disconnect", "timeout"]) {
    let calls = 0
    const { path, requests } = await serverFor(t, (request, socket) => {
      if (request.method !== "tools/call") return
      if (++calls > 1) reply(socket, request, textResult({ threadId: "recovered", hostId: "local" }))
      else if (mode === "disconnect") socket.destroy()
    })
    const client = clientFor(t, path, 50)
    await assert.rejects(invoke(client), error => error.dispatched && error.ambiguous && !error.rejection)
    await invoke(client, { metadata: metadata("another") })
    await assert.rejects(invoke(client), { code: "caller_already_used" })
    assert.equal(requests.filter(request => request.method === "tools/call").length, 2)
  }
})

test("definitive JSON-RPC validation rejection differs from uncertain native handler error", async t => {
  for (const code of [-32602, -32000]) {
    const { path } = await serverFor(t, (request, socket) => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, error: { code, message: "private prompt path /secret" } })))
    const client = clientFor(t, path)
    await assert.rejects(invoke(client), error => error.dispatched && error.rejection === (code === -32602) && error.ambiguous === (code === -32000) && !error.message.includes("private") && !error.message.includes("secret"))
  }
})

test("catalog namespace must match, unsupported catalog tools never exposed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ow-catalog-")), path = join(directory, "app.sock")
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {})
    socket.on("data", createFrameDecoder(request => reply(socket, request, { tools: [
      { name: "create_thread", namespace: "untrusted", inputSchema: {} },
      { name: "send_message_to_thread", namespace: "codex_app", inputSchema: {} },
    ] })))
  })
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600)
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  const client = clientFor(t, path)
  assert.deepEqual(await client.listTools(new AbortController().signal), [])
  await assert.rejects(invoke(client), { code: "native_tool_unavailable", dispatched: false })
})

test("native frames handle byte fragmentation, Unicode, and coalesced unrelated replies", async t => {
  const { path } = await serverFor(t, (request, socket) => {
    const bytes = Buffer.concat([encodeFrame({ jsonrpc: "2.0", id: 999999, result: {} }), encodeFrame({ jsonrpc: "2.0", id: request.id, result: textResult({ label: "héllo 🚀" }) })])
    for (const byte of bytes) socket.write(Buffer.from([byte]))
  })
  const client = clientFor(t, path)
  assert.deepEqual(parseNativeTextResult(await invoke(client)), { label: "héllo 🚀" })
})

test("oversize native frame and malformed reply fail safely after dispatch", async t => {
  for (const mode of ["oversize", "json", "envelope"]) {
    const { path } = await serverFor(t, (request, socket) => {
      if (mode === "oversize") { const header = Buffer.alloc(4); header.writeUInt32LE(MAX_FRAME_BYTES + 1); socket.write(header) }
      else if (mode === "json") socket.write(Buffer.from([1, 0, 0, 0, 0xff]))
      else socket.write(encodeFrame({ id: request.id, result: "private" }))
    })
    const client = clientFor(t, path)
    await assert.rejects(invoke(client), error => error.dispatched && error.ambiguous && !error.message.includes("private"))
  }
})

test("missing or unsafe pipe and oversize request are definitively not dispatched", async t => {
  assert.throws(() => createNativeAppToolsClient({ pipePath: undefined }), { code: "missing_native_pipe" })
  assert.throws(() => createNativeAppToolsClient({ pipePath: "relative" }), { code: "missing_native_pipe" })
  const { path, requests } = await serverFor(t, () => {})
  await chmod(path, 0o666)
  const client = clientFor(t, path)
  await assert.rejects(invoke(client), { code: "unsafe_native_pipe", dispatched: false })
  assert.equal(requests.length, 0)
  await chmod(path, 0o600)
  const other = clientFor(t, path)
  await assert.rejects(invoke(other, { args: { ...args, prompt: "x".repeat(MAX_FRAME_BYTES) } }), { code: "invalid_request_frame", dispatched: false })
  assert.equal(requests.filter(request => request.method === "tools/call").length, 0)
})

test("catalog cancellation or malformed catalog never reports a dispatched creation", async t => {
  for (const mode of ["cancel", "malformed", "duplicate", "timeout"]) {
    const controller = new AbortController()
    const { path, requests } = await serverFor(t, () => {}, (request, socket) => {
      if (mode === "cancel") controller.abort()
      else if (mode === "malformed") reply(socket, request, { tools: [{ name: "create_thread", namespace: "codex_app" }] })
      else if (mode === "duplicate") reply(socket, request, { tools: [catalog.tools[0], catalog.tools[0]] })
    })
    const client = clientFor(t, path, 50)
    await assert.rejects(invoke(client, { signal: controller.signal }), error => !error.dispatched && !error.ambiguous)
    assert.equal(requests.filter(request => request.method === "tools/call").length, 0)
  }
})

test("concurrent duplicate invocation cannot race admission", async t => {
  const { path, requests } = await serverFor(t, (request, socket) => reply(socket, request, textResult({ threadId: "fixture", hostId: "local" })))
  const client = clientFor(t, path)
  const first = invoke(client)
  await assert.rejects(invoke(client), { code: "caller_already_used", dispatched: false })
  await first
  assert.equal(requests.filter(request => request.method === "tools/call").length, 1)
})

test("close cancels pending call and destructured methods work", async t => {
  let client
  const { path, requests } = await serverFor(t, request => { if (request.method === "tools/call") client.close() })
  client = clientFor(t, path)
  const { listTools, invokeOnce } = client
  await listTools(new AbortController().signal)
  await assert.rejects(invokeOnce({ tool: "create_thread", args, metadata: metadata(), confirmed: true, signal: new AbortController().signal }), { code: "closed", dispatched: true })
  assert.equal(requests.filter(request => request.method === "tools/call").length, 1)
  await assert.rejects(invoke(client, { metadata: metadata("after-close") }), { code: "closed", dispatched: false })
  await assert.rejects(client.listTools(new AbortController().signal), { code: "closed" })
})

test("cancelled catalog does not poison a fresh caller or reset its consumed identity", async t => {
  const controller = new AbortController()
  let lists = 0
  const { path, requests } = await serverFor(t, (request, socket) => reply(socket, request, textResult({ threadId: "new", hostId: "local" })), (request, socket) => {
    if (++lists === 1) controller.abort()
    else reply(socket, request, catalog)
  })
  const client = clientFor(t, path)
  await assert.rejects(invoke(client, { signal: controller.signal }), { code: "aborted", dispatched: false })
  await invoke(client, { metadata: metadata("fresh-context") })
  await assert.rejects(invoke(client), { code: "caller_already_used" })
  assert.equal(requests.filter(request => request.method === "tools/call").length, 1)
})

test("old socket close/error/data events cannot affect a fresh pending request", async t => {
  const connections = [], original = net.createConnection
  t.mock.method(net, "createConnection", (...values) => {
    const socket = original(...values)
    connections.push(socket)
    return socket
  })
  const controller = new AbortController()
  let calls = 0
  const { path } = await serverFor(t, (request, socket) => {
    if (request.method !== "tools/call") return
    if (++calls === 1) return controller.abort()
    const old = connections[0]
    old.emit("close")
    old.emit("error", new Error("private stale error"))
    // Even a matching fresh request ID from the stale socket is ignored.
    old.emit("data", encodeFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32602 } }))
    reply(socket, request, textResult({ threadId: "fresh", hostId: "local" }))
  })
  const client = clientFor(t, path)
  await assert.rejects(invoke(client, { signal: controller.signal }), { code: "aborted", dispatched: true })
  assert.deepEqual(parseNativeTextResult(await invoke(client, { metadata: metadata("fresh") })), { threadId: "fresh", hostId: "local" })
  assert.equal(connections.length, 2)
  await client.listTools(new AbortController().signal)
  assert.equal(connections.length, 2)
})

test("standalone cancelled listTools recovers and completed signals do not tear down next requests", async t => {
  const controller = new AbortController()
  let lists = 0
  const { path } = await serverFor(t, (request, socket) => reply(socket, request, textResult({ threadId: "next", hostId: "local" })), (request, socket) => {
    if (++lists === 1) controller.abort()
    else reply(socket, request, catalog)
  })
  const client = clientFor(t, path)
  await assert.rejects(client.listTools(controller.signal), { code: "aborted" })
  const completed = new AbortController()
  await client.listTools(completed.signal)
  completed.abort()
  await invoke(client)
})

test("strict private text parser rejects native errors without exposing them", () => {
  assert.deepEqual(parseNativeTextResult(textResult({ threadId: "fixture", hostId: "local" })), { threadId: "fixture", hostId: "local" })
  for (const response of [null, {}, { success: false, contentItems: [{ type: "inputText", text: "private" }] }, textResult([]), textResult(null), { success: true, contentItems: [{ type: "inputText", text: "private malformed JSON" }] }, { success: true, contentItems: [{ type: "inputImage", imageUrl: "private" }] }, { ...textResult({}), contentItems: [...textResult({}).contentItems, ...textResult({}).contentItems] }]) {
    assert.throws(() => parseNativeTextResult(response), error => error.ambiguous && !error.message.includes("private"))
  }
})

test("build 155 project schema returns only safe local project entries", () => {
  const local = { projectId: "local-project", projectKind: "local", label: "Fixture", path: "/approved/fixture", hostId: "local", hostDisplayName: null, isGitRepository: true }
  const remote = { projectId: "remote-project", projectKind: "remote", label: "Remote", path: "/remote", hostId: "remote", hostDisplayName: "Remote", isGitRepository: false }
  const cloud = { projectId: "cloud-project", projectKind: "chatgpt", label: "Cloud", hostId: null, hostDisplayName: null }
  const noPath = { ...local, projectId: "no-path", path: undefined }
  assert.deepEqual(normalizeLocalProjects(textResult({ schemaVersion: 2, projects: [local, remote, cloud, noPath] })), [local])
  for (const value of [{ schemaVersion: 1, projects: [] }, { schemaVersion: 2, projects: [local, local] }, { schemaVersion: 2, projects: [{ ...local, hostId: "remote" }] }, { schemaVersion: 2, projects: [{ ...local, path: "relative" }] }, { schemaVersion: 2, projects: [{ ...local, isGitRepository: undefined }] }]) {
    assert.throws(() => normalizeLocalProjects(textResult(value)), { code: "invalid_project_catalog" })
  }
})
