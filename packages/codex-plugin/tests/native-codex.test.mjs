import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNativeCodexAdapter, nativeTurnStart } from "../src/native-codex.mjs"
import { createFrameDecoder, encodeFrame } from "../src/ipc.mjs"
import { SessionRunnerError, parseProgress, parseReadResult } from "../lib/index.mjs"

const THREAD = "00000000-0000-4000-8000-000000000001"
const OTHER = "00000000-0000-4000-8000-000000000002"
const receipt = { sessionId: THREAD, workspaceId: "codex-local" }
const signal = () => AbortSignal.timeout(2000)
const completed = (id = "message-1", text = "mock answer") => ({ turnId: `turn-${id}`, status: "completed", turnStartedAtMs: 100,
  params: { input: [{ type: "text", text: "mock prompt" }], clientUserMessageId: id }, items: [{ id: `assistant-${id}`, type: "agentMessage", text }] })

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ow-codex-")), socketPath = join(directory, "ipc.sock"), sockets = new Set(), calls = []
  let state = { id: THREAD, cwd: directory, workspaceKind: "project", resumeState: "resumed", threadRuntimeStatus: { type: "idle" }, turns: [completed()] }
  let sendMode = "success", stopTurn = "turn-message-2", snapshotVersion = 11
  const reply = (socket, request, result) => socket.write(encodeFrame({ type: "response", requestId: request.requestId, method: request.method, resultType: "success", handledByClientId: "owner", result }))
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {})
    socket.on("data", createFrameDecoder(request => {
      calls.push(request)
      if (request.method === "initialize") return reply(socket, request, { clientId: "fixture-client" })
      if (request.method === "thread-owner-discovery") return reply(socket, request, { supportsUntrustedAppInput: true })
      if (request.method === "thread-follower-read-model-settings") return reply(socket, request, { settings: { model: "private-model", resumeState: "resumed" } })
      if (request.method === "thread-stream-following-changed" && request.params.following) {
        return socket.write(encodeFrame({ type: "broadcast", method: "thread-stream-state-changed", version: snapshotVersion, sourceClientId: "owner", targetClientIds: ["fixture-client"], params: {
          hostId: "local", conversationId: THREAD, change: { type: "snapshot", revision: 1, conversationState: state },
        } }))
      }
      if (request.method === "thread-follower-start-turn") {
        if (sendMode === "disconnect") return socket.destroy()
        if (sendMode === "timeout") return
        if (sendMode === "reject" || sendMode === "handler") return socket.write(encodeFrame({ type: "response", requestId: request.requestId, resultType: "error", error: sendMode === "reject" ? "no-client-found" : "private native failure" }))
        return reply(socket, request, sendMode === "malformed" ? {} : { result: { turn: { id: "native-accepted-turn" } } })
      }
      if (request.method === "thread-follower-interrupt-turn") return reply(socket, request, { ok: true, interruptedTurnId: stopTurn })
    }))
  })
  await new Promise(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600)
  const adapter = createNativeCodexAdapter({ directory, workspaceId: "codex-local", socketPath, timeoutMs: 100,
    sourceThreadId: THREAD, enrollments: options.unenrolled ? [] : [{ sessionId: THREAD, directory, confirmed: true, commandId: "bound-command" }] })
  t.after(async () => { adapter.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  return { adapter, directory, calls, get state() { return state }, set state(value) { state = value },
    set sendMode(value) { sendMode = value }, set stopTurn(value) { stopTurn = value }, set snapshotVersion(value) { snapshotVersion = value } }
}

test("minimal native turn contract preserves all native defaults", () => {
  const turn = nativeTurnStart(THREAD, { prompt: "mock text", messageId: "stable-id", model: null })
  assert.deepEqual(turn, { request: { threadId: THREAD, input: [{ type: "text", text: "mock text", text_elements: [] }], clientUserMessageId: "stable-id" }, context: { inheritThreadSettings: true } })
  assert.throws(() => nativeTurnStart(THREAD, { prompt: "mock", messageId: "id", model: { providerId: "x", modelId: "y" } }), { code: "model_override_unavailable" })
})
test("GUI creation fails closed, explicit command binding uses confirmed receipt", async t => {
  const f = await fixture(t)
  assert.equal(f.adapter.creation, "at_most_once"); assert.equal(f.adapter.sendReplay, "at_most_once")
  await assert.rejects(f.adapter.create({ commandId: "unbound" }, signal()), error => error instanceof SessionRunnerError && error.code === "native_create_unavailable")
  assert.deepEqual(await f.adapter.create({ commandId: "bound-command", model: null }, signal()), receipt)
  assert.equal(f.calls.some(call => call.method === "thread/start"), false)
})
test("diagnostic UUID never enrolls a thread or returns transcript/model values", async t => {
  const f = await fixture(t, { unenrolled: true })
  const report = await f.adapter.diagnose(signal())
  assert.equal(report.ownerFound, true); assert.equal(report.sourceThreadEnrolled, false)
  assert.deepEqual(report.settingsKeys, ["model", "resumeState"])
  assert.equal(JSON.stringify(report).includes("private-model"), false)
  assert.equal(f.calls.some(call => call.type === "broadcast"), false)
  await assert.rejects(f.adapter.read(receipt, { from: "start", cursor: null, limit: 10 }, signal()), { code: "native_thread_not_enrolled" })
})
test("foreign receipts and directories never reach a mutation", async t => {
  const f = await fixture(t)
  await assert.rejects(f.adapter.send({ ...receipt, sessionId: OTHER }, { prompt: "mock", messageId: "message-2" }, signal()), { code: "native_thread_not_enrolled" })
  await assert.rejects(f.adapter.observe({ ...receipt, workspaceId: "foreign" }, signal()), { code: "native_thread_not_enrolled" })
  f.state = { ...f.state, cwd: tmpdir() }
  await assert.rejects(f.adapter.send(receipt, { prompt: "mock", messageId: "message-2" }, signal()), { code: "directory_mismatch" })
  assert.equal(f.calls.some(call => call.method === "thread-follower-start-turn"), false)
})
test("native send targets discovered GUI owner, without fake MCP metadata or policy", async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.adapter.send(receipt, { prompt: "mock second prompt", messageId: "message-2", model: null }, signal()), { messageId: "message-2", alreadyPresent: false })
  const call = f.calls.find(call => call.method === "thread-follower-start-turn")
  assert.equal(call.version, 2); assert.equal(call.targetClientId, "owner"); assert.equal(call.hostId, undefined)
  assert.deepEqual(call.params.turnStart.context, { inheritThreadSettings: true })
  assert.deepEqual(Object.keys(call.params.turnStart.request).sort(), ["clientUserMessageId", "input", "threadId"])
})
test("busy, pending permission, duplicate and uncertain submissions cannot admit sends", async t => {
  const f = await fixture(t)
  for (const partial of [{ threadRuntimeStatus: { type: "active" } }, { requests: [{ method: "item/permissions/requestApproval" }] }, { unconfirmedTurnSubmissions: [{}] }]) {
    const old = f.state; f.state = { ...old, ...partial }
    await assert.rejects(f.adapter.send(receipt, { prompt: "mock", messageId: "message-2" }, signal()), { code: "native_thread_busy" })
    f.state = old
  }
  await assert.rejects(f.adapter.send(receipt, { prompt: "mock", messageId: "message-1" }, signal()), { code: "native_message_already_visible" })
  assert.equal(f.calls.some(call => call.method === "thread-follower-start-turn"), false)
})
test("route rejection is definitive; handler error, timeout and malformed acceptance are ambiguous", async t => {
  const f = await fixture(t)
  f.sendMode = "reject"
  await assert.rejects(f.adapter.send(receipt, { prompt: "mock", messageId: "message-2" }, signal()), { code: "native_rejected" })
  for (const mode of ["handler", "timeout", "malformed"]) {
    f.sendMode = mode
    await assert.rejects(f.adapter.send(receipt, { prompt: "mock", messageId: "message-2" }, signal()), { code: "ambiguous_send" })
  }
})
test("stop is pinned to native current message and exact expected turn, not blanket abort", async t => {
  const f = await fixture(t)
  f.state = { ...f.state, turns: [{ ...completed("message-2"), status: "inProgress" }], threadRuntimeStatus: { type: "active" } }
  assert.deepEqual(await f.adapter.stop(receipt, { messageId: null }, signal()), { stopped: false, reason: null })
  assert.deepEqual(await f.adapter.stop(receipt, { messageId: "different" }, signal()), { stopped: false, reason: "different_turn" })
  assert.deepEqual(await f.adapter.stop(receipt, { messageId: "message-2" }, signal()), { stopped: true, reason: null })
  const call = f.calls.find(call => call.method === "thread-follower-interrupt-turn")
  assert.equal(call.version, 4)
  assert.deepEqual(call.params, { conversationId: THREAD, mode: "user-stop", expectedTurnId: "turn-message-2" })
  f.stopTurn = null
  assert.deepEqual(await f.adapter.stop(receipt, { messageId: "message-2" }, signal()), { stopped: false, reason: "different_turn" })
})
test("read/observe implement core schemas, native waiting and context-scoped paging", async t => {
  const f = await fixture(t)
  f.state = { ...f.state, turns: [completed("message-1"), completed("message-2"), completed("message-3")] }
  const first = parseReadResult(await f.adapter.read(receipt, { from: "end", limit: 2, cursor: null }, signal()))
  assert.deepEqual(first.messages.map(message => message.id), ["message-3", "assistant-message-3"])
  assert.equal(first.historyScope, "context"); assert.ok(first.nextCursor)
  const next = await f.adapter.read(receipt, { from: "end", limit: 2, cursor: first.nextCursor }, signal())
  assert.deepEqual(next.messages.map(message => message.id), ["message-2", "assistant-message-2"])
  const progress = parseProgress(await f.adapter.observe(receipt, signal()))
  assert.equal(progress.status, "idle"); assert.equal(progress.finalText, "mock answer"); assert.equal(progress.engine, undefined)
  f.state.requests = [{ method: "item/tool/requestUserInput" }]
  const waiting = await f.adapter.observe(receipt, signal())
  assert.equal(waiting.status, "waiting"); assert.equal(waiting.waitingFor, "question")
  assert.equal(waiting.finalText, undefined)
})
test("old answer never becomes latest turn finalText; unknown snapshot version fails closed", async t => {
  const f = await fixture(t)
  f.state.turns.push({ ...completed("message-2"), items: [] })
  assert.equal((await f.adapter.observe(receipt, signal())).finalText, undefined)
  f.snapshotVersion = 12
  await assert.rejects(f.adapter.observe(receipt, signal()), { code: "native_schema_mismatch" })
})
test("explicit runtime enrollment requires confirmation and is not persisted by adapter", async t => {
  const f = await fixture(t, { unenrolled: true })
  await assert.rejects(f.adapter.enroll({ sessionId: THREAD, directory: f.directory, confirmed: false }, signal()), { code: "enrollment_confirmation_required" })
  assert.deepEqual(await f.adapter.enroll({ sessionId: THREAD, directory: f.directory, confirmed: true }, signal()), receipt)
  assert.equal((await f.adapter.observe(receipt, signal())).status, "idle")
})
