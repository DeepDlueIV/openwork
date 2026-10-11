import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNativeCodexAdapter } from "../src/native-codex.mjs"
import { stableMessageId } from "../lib/index.mjs"
import { NativeAppToolsError } from "../src/native-app-tools.mjs"
import { IpcError } from "../src/ipc.mjs"

const THREAD = "00000000-0000-4000-8000-000000000010"
const command = { commandId: "native-create-command", workspaceId: "codex-local", prompt: "Native child initial prompt", model: null }
const receipt = { sessionId: THREAD, workspaceId: "codex-local" }
const initialTurn = () => ({ turnId: "actual-native-first-turn", status: "inProgress", params: {
  input: [{ type: "text", text: command.prompt }],
}, items: [] })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ow-native-creation-"))
  let state = { id: THREAD, cwd: directory, workspaceKind: "project", environments: [{ environmentId: "local" }],
    resumeState: "resumed", threadRuntimeStatus: { type: "active" }, turns: [initialTurn()] }
  const listeners = new Set(), calls = [], events = [], saved = [], childStates = new Map()
  let ready = true, result = { threadId: THREAD, hostId: "local" }, createError, saveError, ownerError, snapshotMissing = false, snapshotVersion = 11
  const ipcClient = {
    async connect() {}, close() {},
    onBroadcast(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async request(method, params, options) {
      calls.push({ method, params, options })
      if (method === "thread-owner-discovery") {
        if (ownerError) throw ownerError
        return { handledByClientId: "native-owner" }
      }
      if (method === "thread-follower-interrupt-turn") return { result: { ok: true, interruptedTurnId: params.expectedTurnId } }
      throw new Error(`Unexpected native method ${method}`)
    },
    async broadcast(method, params, options) {
      events.push("snapshot")
      calls.push({ method, params, options })
      if (snapshotMissing) return
      for (const listener of listeners) listener({ method: "thread-stream-state-changed", version: snapshotVersion,
        sourceClientId: "native-owner", params: { hostId: "local", conversationId: params.conversationId,
          change: { type: "snapshot", conversationState: childStates.get(params.conversationId) ?? state } } })
    },
  }
  const nativeCreation = {
    async ready() { return ready },
    async create(value, signal) {
      events.push("create")
      calls.push({ method: "native-create", command: value, signal })
      if (createError) throw createError
      return result
    },
    async saveEnrollment(record) {
      events.push("persist")
      if (saveError) throw saveError
      saved.push(record)
    },
  }
  const options = { directory, workspaceId: "codex-local", ipcClient, nativeCreation, timeoutMs: 100 }
  const adapters = []
  const make = (extra = {}) => { const adapter = createNativeCodexAdapter({ ...options, ...extra }); adapters.push(adapter); return adapter }
  const adapter = make()
  t.after(async () => { for (const value of adapters) value.close(); await rm(directory, { recursive: true, force: true }) })
  return { adapter, make, directory, calls, events, saved, childStates,
    get state() { return state }, set state(value) { state = value },
    set ready(value) { ready = value }, set result(value) { result = value },
    set createError(value) { createError = value }, set saveError(value) { saveError = value },
    set ownerError(value) { ownerError = value }, set snapshotMissing(value) { snapshotMissing = value },
    set snapshotVersion(value) { snapshotVersion = value } }
}

test("native creation includes the prompt exactly once and persists actual local ownership before return", async t => {
  const f = await fixture(t)
  assert.equal(f.adapter.creationPrompt, "included")
  assert.deepEqual(await f.adapter.create(command), receipt)
  f.events.push("ack")
  assert.deepEqual(f.events, ["create", "persist", "snapshot", "persist", "ack"])
  assert.deepEqual(f.saved, [
    { sessionId: THREAD, directory: f.directory, confirmed: true, verificationPending: true,
      initialMessageId: stableMessageId(command.commandId), initialPrompt: command.prompt },
    { sessionId: THREAD, directory: f.directory, confirmed: true, verificationPending: false,
      initialMessageId: stableMessageId(command.commandId), initialTurnId: "actual-native-first-turn" },
  ])
  assert.equal(f.calls.findIndex(call => call.method === "thread-owner-discovery") > f.calls.findIndex(call => call.method === "native-create"), true)
  const creates = f.calls.filter(call => call.method === "native-create")
  assert.equal(creates.length, 1)
  assert.equal(creates[0].command, command)
  assert.equal(creates[0].command.prompt, command.prompt)
  assert.equal(f.calls.some(call => call.method === "thread-follower-start-turn"), false)
  assert.equal((await f.adapter.observe(receipt)).status, "running")
  assert.equal((await f.adapter.read(receipt, { from: "start", limit: 10 })).messages[0].text, command.prompt)
  await assert.rejects(f.adapter.create(command), { code: "ambiguous_creation" })
  assert.equal(f.calls.filter(call => call.method === "native-create").length, 1)
})

test("approved native project creation verifies and persists its changed actual root without changing permissions", async t => {
  const f = await fixture(t)
  const actualRoot = await mkdtemp(join(f.directory, "updated-project-root-"))
  f.state.cwd = actualRoot
  const projectScope = { projectId: "saved-local-project", confirmed: true }
  const adapter = f.make({ projectScope })
  assert.deepEqual(await adapter.create(command), receipt)
  assert.deepEqual(f.events, ["create", "persist", "snapshot", "persist"])
  assert.equal(f.saved[0].projectId, projectScope.projectId)
  assert.equal(f.saved[0].directory, f.directory)
  assert.equal(f.saved[0].verificationPending, true)
  assert.equal(f.saved[1].projectId, projectScope.projectId)
  assert.equal(f.saved[1].directory, await realpath(actualRoot))
  assert.equal(f.saved[1].verificationPending, false)
  assert.equal((await adapter.observe(receipt)).status, "running")
  const create = f.calls.find(call => call.method === "native-create")
  assert.equal(create.command, command)
  assert.equal(f.calls.some(call => call.method === "thread-follower-start-turn"), false)
  const restored = f.make({ projectScope, enrollments: [f.saved[1]], directory: join(f.directory, "obsolete-configured-root") })
  assert.equal((await restored.observe(receipt)).status, "running")
  f.state.cwd = f.directory
  const changed = await adapter.observe(receipt)
  assert.equal(changed.status, "error")
  assert.equal(changed.error.code, "native_scope_changed")
  assert.equal(changed.finalText, undefined)
  assert.equal(changed.messageCount, undefined)
  await assert.rejects(adapter.read(receipt, { from: "start", limit: 10 }), { code: "directory_mismatch" })
  await assert.rejects(adapter.send(receipt, { prompt: "followup", messageId: "followup" }), { code: "directory_mismatch" })
  await assert.rejects(adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "directory_mismatch" })
  assert.equal(f.calls.some(call => call.method === "thread-follower-interrupt-turn"), false)
})

test("a renamed initial project root permits a new child while old changed-root child progress stays scoped", async t => {
  const f = await fixture(t)
  const initialDirectory = await mkdtemp(join(f.directory, "initial-project-root-"))
  const projectScope = { projectId: "saved-local-project", confirmed: true }
  const adapter = f.make({ projectScope, directory: initialDirectory })
  f.state.cwd = initialDirectory
  assert.deepEqual(await adapter.create(command), receipt)
  const originalPin = f.saved[1].directory
  const currentRoot = `${initialDirectory}-renamed`
  await rename(initialDirectory, currentRoot)
  f.state.cwd = currentRoot
  const otherThread = "00000000-0000-4000-8000-000000000011"
  f.childStates.set(otherThread, { ...f.state, id: otherThread })
  f.result = { threadId: otherThread, hostId: "local" }
  const otherReceipt = { ...receipt, sessionId: otherThread }
  const restarted = f.make({ projectScope, directory: initialDirectory, enrollments: [f.saved[1]] })
  assert.deepEqual(await restarted.create({ ...command, commandId: "new-child-after-root-rename" }), otherReceipt)
  assert.equal(f.saved[3].directory, await realpath(currentRoot))
  assert.equal(f.saved[3].verificationPending, false)
  const progress = await Promise.all([restarted.observe(receipt), restarted.observe(otherReceipt)])
  assert.equal(progress[0].status, "error")
  assert.equal(progress[0].error.code, "native_scope_changed")
  assert.equal(progress[0].finalText, undefined)
  assert.equal(progress[0].messageCount, undefined)
  assert.equal(progress[1].status, "running")
  assert.equal(f.saved[1].directory, originalPin)
  assert.equal(f.saved.filter(entry => entry.sessionId === THREAD).length, 2)
  await assert.rejects(restarted.read(receipt, { from: "start", limit: 10 }), { code: "directory_mismatch" })
  await assert.rejects(restarted.send(receipt, { prompt: "followup", messageId: "followup" }), { code: "directory_mismatch" })
  await assert.rejects(restarted.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "directory_mismatch" })
  assert.equal((await restarted.read(otherReceipt, { from: "start", limit: 10 })).messages[0].text, command.prompt)
  assert.equal(f.calls.some(call => ["thread-follower-start-turn", "thread-follower-interrupt-turn"].includes(call.method)), false)
  const legacy = f.make({ nativeCreation: undefined, directory: initialDirectory,
    enrollments: [{ sessionId: THREAD, directory: initialDirectory, confirmed: true, commandId: "manual-bound" }] })
  await assert.rejects(legacy.create({ commandId: "manual-bound" }), { code: "directory_unavailable" })
})

test("project-scoped pending restoration discovers the new native root without requiring the obsolete configured folder", async t => {
  const f = await fixture(t)
  const projectScope = { projectId: "saved-local-project", confirmed: true }
  const oldDirectory = join(f.directory, "no-longer-present-root")
  const adapter = f.make({ projectScope, directory: oldDirectory })
  f.state.turns = []
  assert.deepEqual(await adapter.create(command), receipt)
  assert.equal(f.saved.length, 1)
  assert.equal(f.saved[0].directory, oldDirectory)
  const actualRoot = await mkdtemp(join(f.directory, "current-project-root-"))
  f.state.cwd = actualRoot
  f.state.turns = [initialTurn()]
  const restored = f.make({ projectScope, directory: oldDirectory, enrollments: [f.saved[0]] })
  assert.equal((await restored.observe(receipt)).status, "running")
  assert.equal(f.saved[1].directory, await realpath(actualRoot))
  assert.equal(f.saved[1].initialTurnId, "actual-native-first-turn")
  assert.equal(f.calls.filter(call => call.method === "native-create").length, 1)
})

test("project consent cannot authorize foreign receipts, wrong-project records or manual folder widening", async t => {
  const f = await fixture(t)
  const projectScope = { projectId: "saved-local-project", confirmed: true }
  const adapter = f.make({ projectScope })
  await adapter.create(command)
  const wrongProject = f.make({ projectScope, enrollments: [{ ...f.saved[1], projectId: "other-project" }] })
  const before = f.calls.length
  await assert.rejects(wrongProject.observe(receipt), { code: "project_scope_mismatch" })
  assert.equal(f.calls.length, before)
  const unapproved = f.make({ enrollments: [f.saved[1]] })
  await assert.rejects(unapproved.observe(receipt), { code: "project_scope_mismatch" })
  await assert.rejects(adapter.observe({ ...receipt, sessionId: "00000000-0000-4000-8000-000000000099" }), { code: "native_thread_not_enrolled" })
  const foreignRoot = await mkdtemp(join(f.directory, "foreign-manual-root-"))
  const manual = f.make({ projectScope, nativeCreation: undefined,
    enrollments: [{ sessionId: THREAD, directory: foreignRoot, confirmed: true, commandId: "manual-binding" }] })
  await assert.rejects(manual.create({ commandId: "manual-binding" }), { code: "directory_mismatch" })
  await assert.rejects(adapter.enroll({ sessionId: "00000000-0000-4000-8000-000000000099", directory: foreignRoot,
    confirmed: true, projectId: projectScope.projectId }), { code: "directory_mismatch" })
  assert.throws(() => f.make({ projectScope, enrollments: [{ sessionId: THREAD, directory: foreignRoot,
    confirmed: true, projectId: projectScope.projectId }] }), { code: "invalid_configuration" })
  for (const invalid of [{ confirmed: false, projectId: "saved-local-project" }, { confirmed: true, projectId: "" }]) {
    assert.throws(() => f.make({ projectScope: invalid }), { code: "invalid_configuration" })
  }
})

test("project scope still rejects foreign-host receipts and denies projectless or remote native snapshots", async t => {
  const f = await fixture(t)
  const projectScope = { projectId: "saved-local-project", confirmed: true }
  f.result = { hostId: "remote", threadId: THREAD }
  await assert.rejects(f.make({ projectScope }).create(command), { code: "ambiguous_creation" })
  assert.equal(f.saved.length, 0)
  f.result = { hostId: "local", threadId: THREAD }
  for (const invalid of [{ workspaceKind: "projectless" }, { environments: [{ environmentId: "remote" }] }]) {
    const previous = f.state
    f.state = { ...f.state, ...invalid }
    const adapter = f.make({ projectScope })
    assert.deepEqual(await adapter.create(command), receipt)
    assert.equal(f.saved.at(-1).verificationPending, true)
    assert.equal((await adapter.observe(receipt)).error.code, "native_verification_pending")
    await assert.rejects(adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "directory_mismatch" })
    f.state = previous
  }
  assert.equal(f.calls.some(call => ["thread-follower-start-turn", "thread-follower-interrupt-turn"].includes(call.method)), false)
})

test("structurally unknown native scope snapshots still throw instead of becoming child scope-change progress", async t => {
  const f = await fixture(t)
  const adapter = f.make({ projectScope: { projectId: "saved-local-project", confirmed: true } })
  await adapter.create(command)
  for (const invalid of [{ cwd: undefined }, { cwd: "relative-root" }, { workspaceKind: undefined },
    { environments: {} }, { environments: [{}] }]) {
    const previous = f.state
    f.state = { ...f.state, ...invalid }
    await assert.rejects(adapter.observe(receipt), { code: "native_schema_mismatch" })
    f.state = previous
  }
})

test("concurrent calls for one command dispatch native creation at most once", async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([f.adapter.create(command), f.adapter.create(command)])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  const rejected = results.find(result => result.status === "rejected")
  assert.equal(rejected.reason.code, "ambiguous_creation")
  assert.equal(f.calls.filter(call => call.method === "native-create").length, 1)
})

test("initial logical message aliases only the verified native first turn, never a newer manual turn", async t => {
  const f = await fixture(t)
  await f.adapter.create(command)
  const messageId = stableMessageId(command.commandId)
  assert.deepEqual(await f.adapter.stop(receipt, { messageId }), { stopped: true, reason: null })
  const interrupt = f.calls.find(call => call.method === "thread-follower-interrupt-turn")
  assert.equal(interrupt.params.expectedTurnId, "actual-native-first-turn")
  assert.equal(interrupt.options.targetClientId, "native-owner")
  f.state.turns.push({ ...initialTurn(), turnId: "new-manual-turn", params: { clientUserMessageId: messageId, input: [] } })
  assert.deepEqual(await f.adapter.stop(receipt, { messageId }), { stopped: false, reason: "different_turn" })
  assert.equal(f.calls.filter(call => call.method === "thread-follower-interrupt-turn").length, 1)
})

test("creation validates nonempty prompt, workspace and model before invoking the native creator", async t => {
  const f = await fixture(t)
  for (const prompt of [null, "", "   "]) await assert.rejects(f.adapter.create({ ...command, prompt }), { code: "invalid_input" })
  await assert.rejects(f.adapter.create({ ...command, commandId: " " }), { code: "invalid_input" })
  await assert.rejects(f.adapter.create({ ...command, workspaceId: "foreign" }), { code: "workspace_unavailable" })
  await assert.rejects(f.adapter.create({ ...command, model: "override" }), { code: "model_override_unavailable" })
  assert.equal(f.events.length, 0)
})

test("nonlocal, client-only and malformed native creation receipts fail uncertain without enrollment", async t => {
  const f = await fixture(t)
  for (const [index, result] of [
    { threadId: THREAD, hostId: "remote" },
    { clientThreadId: THREAD, hostId: "local" },
    { threadId: THREAD, clientThreadId: THREAD, hostId: "local" },
    { threadId: "invented-child-id", hostId: "local" },
  ].entries()) {
    f.result = result
    await assert.rejects(f.adapter.create({ ...command, commandId: `invalid-receipt-${index}` }), { code: "ambiguous_creation" })
  }
  assert.equal(f.saved.length, 0)
  await assert.rejects(f.adapter.observe(receipt), { code: "native_thread_not_enrolled" })
})

test("post-create root and environment mismatches preserve accepted receipt but deny controls", async t => {
  const f = await fixture(t)
  f.state.cwd = tmpdir()
  assert.deepEqual(await f.adapter.create(command), receipt)
  assert.equal(f.events.filter(value => value === "create").length, 1)
  assert.equal(f.saved[0].verificationPending, true)
  assert.equal((await f.adapter.observe(receipt)).error.code, "native_verification_pending")
  await assert.rejects(f.adapter.send(receipt, { prompt: "followup", messageId: "followup" }), { code: "directory_mismatch" })
  await assert.rejects(f.adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "directory_mismatch" })
  const other = f.make()
  f.state.cwd = f.directory
  f.state.environments = [{ environmentId: "remote" }]
  assert.deepEqual(await other.create(command), receipt)
  assert.equal(f.saved.length, 2)
  assert.equal(f.saved[1].verificationPending, true)
  assert.equal(f.calls.some(call => ["thread-follower-start-turn", "thread-follower-interrupt-turn"].includes(call.method)), false)
})

test("unknown creator lifetime and enrollment persistence failures do not acknowledge or replay creation", async t => {
  const f = await fixture(t)
  f.createError = new Error("response lost after native creation")
  await assert.rejects(f.adapter.create(command), { code: "ambiguous_creation" })
  await assert.rejects(f.adapter.create(command), { code: "ambiguous_creation" })
  assert.equal(f.events.length, 1)
  f.createError = undefined
  f.saveError = new Error("local save failed")
  await assert.rejects(f.make().create(command), { code: "ambiguous_creation" })
  assert.equal(f.saved.length, 0)
})

test("accepted receipt survives snapshot loss and restored pending ownership verifies without creation retry", async t => {
  const f = await fixture(t)
  f.snapshotMissing = true
  assert.deepEqual(await f.adapter.create(command), receipt)
  assert.equal(f.saved.length, 1)
  assert.equal(f.saved[0].verificationPending, true)
  assert.equal((await f.adapter.observe(receipt)).error.code, "native_unavailable")
  const restored = f.make({ enrollments: [f.saved[0]] })
  f.snapshotMissing = false
  const results = await Promise.all([restored.observe(receipt), restored.read(receipt, { from: "start", limit: 10 })])
  assert.equal(results[0].status, "running")
  assert.equal(results[1].messages[0].text, command.prompt)
  assert.equal(f.saved.length, 2)
  assert.equal(f.saved[1].verificationPending, false)
  assert.equal(f.saved[1].initialPrompt, undefined)
  assert.equal(f.calls.filter(call => call.method === "native-create").length, 1)
  await restored.observe(receipt)
  assert.equal(f.saved.length, 2)
  f.state.turns.push({ ...initialTurn(), turnId: "new-manual-turn" })
  assert.deepEqual(await restored.stop(receipt, { messageId: stableMessageId(command.commandId) }), { stopped: false, reason: "different_turn" })
})

test("cancellation after native acceptance cannot discard its durable pending receipt", async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const saved = []
  const adapter = f.make({ nativeCreation: {
    async ready() { return true },
    async create() { controller.abort(); return { threadId: THREAD, hostId: "local" } },
    async saveEnrollment(value) { saved.push(value) },
  } })
  assert.deepEqual(await adapter.create(command, controller.signal), receipt)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].verificationPending, true)
  assert.equal((await adapter.observe(receipt)).status, "running")
  assert.equal(saved.length, 2)
})

test("failed verification upsert keeps a durable pending child and mutation disabled until proof is saved", async t => {
  const f = await fixture(t)
  const saved = []
  let allowVerificationSave = false
  const adapter = f.make({ nativeCreation: {
    async ready() { return true },
    async create() { return { threadId: THREAD, hostId: "local" } },
    async saveEnrollment(value) {
      if (!value.verificationPending && !allowVerificationSave) throw new Error("private enrollment save unavailable")
      saved.push(value)
    },
  } })
  assert.deepEqual(await adapter.create(command), receipt)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].verificationPending, true)
  assert.equal((await adapter.observe(receipt)).error.code, "native_verification_pending")
  await assert.rejects(adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "native_verification_pending" })
  assert.equal(f.calls.some(call => call.method === "thread-follower-interrupt-turn"), false)
  allowVerificationSave = true
  assert.deepEqual(await adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { stopped: true, reason: null })
  assert.equal(saved.length, 2)
  assert.equal(saved[1].initialPrompt, undefined)
})

test("pending records require private bounded correlation state and cannot be promoted through enrollment alone", async t => {
  const f = await fixture(t)
  const pending = { sessionId: THREAD, directory: f.directory, confirmed: true, verificationPending: true,
    initialMessageId: stableMessageId(command.commandId), initialPrompt: command.prompt }
  for (const invalid of [{ initialPrompt: undefined }, { initialPrompt: "" }, { initialMessageId: undefined },
    { initialTurnId: "unverified-turn" }, { verificationPending: "true" }]) {
    assert.throws(() => f.make({ enrollments: [{ ...pending, ...invalid }] }), { code: "invalid_configuration" })
  }
  const restored = f.make({ enrollments: [pending] })
  await assert.rejects(restored.enroll({ sessionId: THREAD, directory: f.directory, confirmed: true }), { code: "native_verification_pending" })
  f.state.turns = []
  assert.equal((await restored.observe(receipt)).error.code, "native_verification_pending")
})

test("one unavailable historical child yields scoped progress without swallowing authority or schema errors", async t => {
  const f = await fixture(t)
  await f.adapter.create(command)
  f.ownerError = new IpcError("connection_closed")
  const progress = await f.adapter.observe(receipt)
  assert.equal(progress.status, "error")
  assert.equal(progress.error.code, "native_unavailable")
  assert.equal(typeof progress.observedAt, "number")
  await assert.rejects(f.adapter.observe({ ...receipt, workspaceId: "foreign" }), { code: "native_thread_not_enrolled" })
  f.ownerError = new IpcError("invalid_response")
  await assert.rejects(f.adapter.observe(receipt), { code: "invalid_response" })
  f.ownerError = undefined
  f.state.turns = undefined
  await assert.rejects(f.adapter.observe(receipt), { code: "native_schema_mismatch" })
  f.state.turns = [initialTurn()]
  assert.equal((await f.adapter.observe(receipt)).status, "running")
  f.snapshotVersion = 12
  await assert.rejects(f.adapter.observe(receipt), { code: "native_schema_mismatch" })
})

test("proven pre-dispatch native creation failure is definitive; post-dispatch failure remains ambiguous", async t => {
  const f = await fixture(t)
  f.createError = new NativeAppToolsError("invocation_missing", { dispatched: false })
  await assert.rejects(f.adapter.create(command), { code: "native_rejected" })
  f.createError = new NativeAppToolsError("response_lost", { dispatched: true })
  await assert.rejects(f.make().create(command), { code: "ambiguous_creation" })
  assert.equal(f.saved.length, 0)
})

test("creation readiness must be exactly verified and diagnostics require a coordinator", async t => {
  const f = await fixture(t)
  assert.equal((await f.adapter.diagnose()).nativeCreation, true)
  assert.equal((await f.adapter.diagnose()).requiresCoordinator, true)
  for (const value of [false, undefined, "true"]) {
    f.ready = value
    assert.equal((await f.adapter.diagnose()).nativeCreation, false)
    await assert.rejects(f.adapter.create(command), { code: "native_create_unavailable" })
  }
  assert.equal(f.events.length, 0)
  const existing = f.make({ nativeCreation: undefined })
  assert.equal(existing.creationPrompt, undefined)
  assert.equal((await existing.diagnose()).nativeCreation, false)
})

test("constructor and runtime enrollment restore strict initial-turn mappings for guarded stop", async t => {
  const f = await fixture(t)
  const enrollment = { sessionId: THREAD, directory: f.directory, confirmed: true,
    initialMessageId: stableMessageId(command.commandId), initialTurnId: "actual-native-first-turn" }
  const restored = f.make({ nativeCreation: undefined, enrollments: [enrollment] })
  assert.deepEqual(await restored.stop(receipt, { messageId: enrollment.initialMessageId }), { stopped: true, reason: null })
  const enrolled = f.make({ nativeCreation: undefined })
  await enrolled.enroll(enrollment)
  assert.deepEqual(await enrolled.stop(receipt, { messageId: enrollment.initialMessageId }), { stopped: true, reason: null })
  for (const invalid of [
    { initialMessageId: "" }, { initialMessageId: 123 }, { initialTurnId: "" },
    { initialTurnId: 123 }, { initialMessageId: undefined },
  ]) assert.throws(() => f.make({ enrollments: [{ ...enrollment, ...invalid }] }), { code: "invalid_configuration" })
  f.state.turns.push({ ...initialTurn(), turnId: "manual-newer" })
  assert.deepEqual(await restored.stop(receipt, { messageId: enrollment.initialMessageId }), { stopped: false, reason: "different_turn" })
})

test("an initially empty snapshot establishes its first-turn alias later and persists it once", async t => {
  const f = await fixture(t)
  f.state.turns = []
  assert.deepEqual(await f.adapter.create(command), receipt)
  assert.equal(f.saved[0].verificationPending, true)
  assert.equal((await f.adapter.observe(receipt)).error.code, "native_verification_pending")
  await assert.rejects(f.adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "native_verification_pending" })
  f.state.turns = [initialTurn()]
  assert.equal((await f.adapter.observe(receipt)).status, "running")
  assert.equal(f.saved.length, 2)
  assert.equal(f.saved[1].initialTurnId, "actual-native-first-turn")
  assert.deepEqual(await f.adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { stopped: true, reason: null })
  await f.adapter.observe(receipt)
  assert.equal(f.saved.length, 2)
  assert.equal(f.calls.filter(call => call.method === "native-create").length, 1)
})

test("a mismatched first prompt cannot authorize control or alias even when a later prompt matches", async t => {
  const f = await fixture(t)
  f.state.turns[0].params.input[0].text = "unrelated manual prompt"
  assert.deepEqual(await f.adapter.create(command), receipt)
  assert.equal(f.saved.length, 1)
  f.state.turns.push({ ...initialTurn(), turnId: "later-native-turn" })
  assert.equal((await f.adapter.observe(receipt)).error.code, "native_verification_pending")
  await assert.rejects(f.adapter.stop(receipt, { messageId: stableMessageId(command.commandId) }), { code: "native_verification_pending" })
  await assert.rejects(f.adapter.send(receipt, { prompt: "followup", messageId: "followup" }), { code: "native_verification_pending" })
  await assert.rejects(f.adapter.read(receipt, { from: "start", limit: 10 }), { code: "native_verification_pending" })
  assert.equal(f.calls.some(call => ["thread-follower-start-turn", "thread-follower-interrupt-turn"].includes(call.method)), false)
})
