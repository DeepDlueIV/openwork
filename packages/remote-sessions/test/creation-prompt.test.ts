import assert from "node:assert/strict"
import test from "node:test"
import type { Command, Complete, HarnessAdapter, Journal, JournalStore, Progress, Request, Transport } from "../src/types.ts"
import { emptyJournal, SessionRunnerError } from "../src/types.ts"
import { parseJournal, stableMessageId } from "../src/protocol.ts"
import { createSessionRunner } from "../src/runner.ts"

const signal = () => new AbortController().signal
const command: Command = { commandId: "cmd_initial", kind: "remote_session_create", title: "Native creation",
  prompt: "First turn", model: null, workspaceId: "workspace", expiresAt: 10_000 }
const receipt = { sessionId: "native_thread", workspaceId: "workspace" }
const delivered: Complete = { status: "delivered", ...receipt }

function fixture(included = true) {
  const store: JournalStore & { data: Journal; snapshots: Journal[]; failDelivery: boolean } = {
    data: emptyJournal(), snapshots: [], failDelivery: false,
    async load() { return structuredClone(this.data) },
    async save(value) {
      if (this.failDelivery && value.commands[0]?.phase === "delivered") throw new Error("disk unavailable")
      this.data = structuredClone(value)
      this.snapshots.push(structuredClone(value))
    },
  }
  const calls: { create: number; initialPrompts: number; send: number; observe: number; completions: Complete[]; reports: Progress[] }
    = { create: 0, initialPrompts: 0, send: 0, observe: 0, completions: [], reports: [] }
  const hooks: { create?: () => void; complete?: () => void; observe?: () => Progress } = {}
  const adapter: HarnessAdapter = {
    ...(included ? { creationPrompt: "included" } : {}),
    creation: "at_most_once", sendReplay: "at_most_once",
    async create(value) {
      calls.create++
      const entry = store.data.commands[0]
      assert.equal(entry?.phase, "prepared", "intent persisted before combined native effect")
      assert.equal(entry?.receipt, null)
      assert.equal(entry?.creationPrompt, adapter.creationPrompt, "capability pinned before native effect")
      assert.equal(entry?.promptMessageId, stableMessageId(value.commandId))
      if (adapter.creationPrompt === "included") calls.initialPrompts++
      hooks.create?.()
      return receipt
    },
    async send(_receipt, input) {
      calls.send++
      assert.ok(store.data.commands[0]?.receipt, "receipt precedes followup send")
      assert.ok(store.data.commands[0]?.turn?.messageId === input.messageId
        || store.data.requests.some(e => e.turn?.messageId === input.messageId), "turn intent precedes send")
      return { messageId: input.messageId, alreadyPresent: false }
    },
    async observe() {
      calls.observe++
      return hooks.observe?.() ?? { status: "idle", messageCount: 2, finalText: "Initial answer", observedAt: 100 + calls.observe }
    },
    async read() { throw new Error("unexpected read") },
    async stop() { throw new Error("unexpected stop") },
  }
  const transport: Transport = {
    async complete(_id, value) {
      assert.deepEqual(store.data.commands[0]?.completion, value, "receipt and completion precede HTTP ack")
      calls.completions.push(structuredClone(value))
      hooks.complete?.()
    },
    async completeRequest() { assert.ok(store.data.requests[0]?.completion) },
    async report(_id, value) { calls.reports.push(value) },
  }
  const runner = (port = adapter) => createSessionRunner({ adapter: port, store, transport, now: () => 100 })
  return { store, calls, hooks, adapter, runner }
}

test("included create accepts initial prompt once and atomically journals delivery without adapter.send", async () => {
  const f = fixture()
  const runner = f.runner()
  assert.deepEqual(await runner.accept(command, signal()), delivered)
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.initialPrompts, 1)
  assert.equal(f.calls.send, 0)
  assert.equal(f.calls.observe, 0, "combined create needs no pre-send native observation")
  const entry = f.store.snapshots[1]?.commands[0]
  assert.equal(entry?.phase, "delivered")
  assert.deepEqual(entry?.receipt, receipt)
  assert.deepEqual(entry?.completion, delivered)
  assert.deepEqual(entry?.turn, { messageId: stableMessageId(command.commandId), baselineMessageCount: 0, seenActive: true })
  assert.equal(entry?.lastMessageId, stableMessageId(command.commandId))
  assert.equal(entry?.completionAcknowledged, false)
  assert.equal(f.store.snapshots.some(j => j.commands[0]?.phase === "created"), false)
  await runner.accept(command, signal())
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.send, 0)
  assert.equal(f.calls.reports.at(-1)?.finalText, "Initial answer", "instant first turn uses zero baseline")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("lost remote acknowledgement replays only completion, not combined native create", async () => {
  const f = fixture()
  f.hooks.complete = () => { throw new TypeError("remote ack lost") }
  await assert.rejects(f.runner().accept(command, signal()), /remote ack lost/)
  assert.equal(f.store.data.commands[0]?.completionAcknowledged, false)
  f.hooks.complete = undefined
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.completions, [delivered, delivered])
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.initialPrompts, 1)
  assert.equal(f.calls.send, 0)
})

for (const restart of [false, true]) {
  test(`uncertain combined create retains prepared intent and never repeats (${restart ? "reload" : "same runner"})`, async () => {
    const f = fixture()
    f.hooks.create = () => { throw new TypeError("native response lost") }
    const runner = f.runner()
    await assert.rejects(runner.accept(command, signal()), /native response lost/)
    assert.equal(f.store.data.commands[0]?.phase, "prepared")
    assert.equal(f.calls.completions.length, 0)
    const recovered = restart ? f.runner() : runner
    await recovered.reconcile(signal())
    await recovered.accept(command, signal())
    const result = f.calls.completions[0]
    assert.ok(result?.status === "failed")
    assert.equal(result.error.code, "ambiguous_creation")
    assert.equal(f.calls.create, 1)
    assert.equal(f.calls.initialPrompts, 1)
    assert.equal(f.calls.send, 0)
  })
}

test("combined delivery save failure leaves prepared ambiguity and poisons current runner", async () => {
  const f = fixture()
  f.store.failDelivery = true
  const runner = f.runner()
  await assert.rejects(runner.accept(command, signal()), /disk unavailable/)
  assert.equal(f.store.data.commands[0]?.phase, "prepared")
  await assert.rejects(runner.reconcile(signal()), /Reload the runner/)
  f.store.failDelivery = false
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.send, 0)
  const result = f.calls.completions[0]
  assert.ok(result?.status === "failed")
  assert.equal(result.error.code, "ambiguous_creation")
})

test("cancellation after combined acceptance retains delivery but prevents remote ack", async () => {
  const f = fixture()
  const controller = new AbortController()
  const save = f.store.save.bind(f.store)
  f.store.save = async value => { await save(value); if (value.commands[0]?.phase === "delivered") controller.abort() }
  await assert.rejects(f.runner().accept(command, controller.signal), { name: "AbortError" })
  assert.deepEqual(f.store.data.commands[0]?.completion, delivered)
  assert.equal(f.calls.completions.length, 0)
  f.hooks.create = undefined
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.send, 0)
})

for (const prompt of [null, " \n\t"]) {
  test(`included mode definitively rejects ${prompt === null ? "missing" : "blank"} initial prompt before native create`, async () => {
    const f = fixture()
    const result = await f.runner().accept({ ...command, prompt }, signal())
    assert.ok(result.status === "failed")
    assert.equal(result.error.code, "prompt_required")
    assert.equal(f.calls.create, 0)
    assert.equal(f.calls.send, 0)
    await f.runner().reconcile(signal())
    assert.equal(f.calls.create, 0)
  })
}

test("older separate journal stays separate after adapter upgrade", async () => {
  const f = fixture(false)
  const controller = new AbortController()
  const save = f.store.save.bind(f.store)
  f.store.save = async value => { await save(value); if (value.commands[0]?.phase === "created") controller.abort() }
  await assert.rejects(f.runner().accept(command, controller.signal), { name: "AbortError" })
  assert.equal(f.store.data.commands[0]?.phase, "created")
  assert.equal(f.store.data.commands[0]?.creationPrompt, undefined)
  assert.equal(parseJournal(f.store.data).commands[0]?.creationPrompt, undefined)
  const upgraded: HarnessAdapter = { ...f.adapter, creationPrompt: "included" }
  await f.runner(upgraded).reconcile(signal())
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.send, 1, "old receipt still requires its separate initial send")
  assert.deepEqual(f.store.data.commands[0]?.completion, delivered)
})

test("legacy idempotent prepared create cannot be reinterpreted as included after upgrade", async () => {
  const f = fixture(false)
  const legacy: HarnessAdapter = { ...f.adapter, creation: "idempotent" }
  f.hooks.create = () => { throw new TypeError("native response lost") }
  await assert.rejects(f.runner(legacy).accept(command, signal()), /native response lost/)
  await f.runner({ ...legacy, creationPrompt: "included" }).reconcile(signal())
  const result = f.calls.completions[0]
  assert.ok(result?.status === "failed")
  assert.equal(result.error.code, "ambiguous_creation")
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.send, 0)
})

test("journal parser rejects unknown creationPrompt values", async () => {
  const f = fixture()
  await f.runner().accept(command, signal())
  for (const creationPrompt of ["separate", "unknown", null, false]) {
    const value = { ...f.store.data, commands: f.store.data.commands.map(e => ({ ...e, creationPrompt })) }
    assert.throws(() => parseJournal(value), error => error instanceof SessionRunnerError && error.code === "invalid_data")
  }
})

test("included creation leaves followup send on the durable existing request path", async () => {
  const f = fixture()
  const runner = f.runner()
  await runner.accept(command, signal())
  const request: Request = { requestId: "request_followup", kind: "remote_session_request", commandId: command.commandId,
    ...receipt, engine: null, expiresAt: 10_000, action: "send", input: { prompt: "Next turn", messageId: null, model: null } }
  assert.deepEqual(await runner.execute(request, signal()), { status: "done", outcome: { action: "send",
    result: { messageId: stableMessageId(request.requestId), alreadyPresent: false } } })
  assert.equal(f.calls.create, 1)
  assert.equal(f.calls.initialPrompts, 1)
  assert.equal(f.calls.send, 1)
  assert.equal(f.calls.observe, 1, "followup still takes a native baseline")
  assert.deepEqual(f.store.data.commands[0]?.turn, { messageId: stableMessageId(request.requestId), baselineMessageCount: 2, seenActive: false })
  await f.runner().execute(request, signal())
  assert.equal(f.calls.send, 1)
})

for (const status of ["error", "idle"]) {
  for (const restart of [false, true]) {
    test(`included first turn preserves immediate ${status === "error" ? "failure" : "stop"} with only a user message (${restart ? "reload" : "same runner"})`, async () => {
      const f = fixture()
      const progress: Progress = { status: status === "error" ? "error" : "idle", messageCount: 1,
        finalText: "", error: status === "error" ? { code: "nativeUnavailable", message: "Native turn failed." } : null,
        observedAt: 101 }
      f.hooks.observe = () => progress
      const runner = f.runner()
      await runner.accept(command, signal())
      const watching = restart ? f.runner() : runner
      await watching.reconcile(signal())
      assert.deepEqual(f.calls.reports.at(-1), progress, "terminal first turn is not fabricated as running")
      await watching.reconcile(signal())
      assert.equal(f.calls.reports.length, 1, "unchanged terminal observation stays settled")
      assert.equal(f.calls.send, 0)
    })
  }
}

for (const oldStatus of ["error", "idle"]) {
  test(`included followup suppresses the previous turn's ${oldStatus === "error" ? "failure" : "answer"} until new evidence`, async () => {
    const f = fixture()
    let progress: Progress = { status: oldStatus === "error" ? "error" : "idle", messageCount: oldStatus === "error" ? 1 : 2,
      finalText: oldStatus === "error" ? "" : "Old answer", observedAt: 101,
      error: oldStatus === "error" ? { code: "nativeUnavailable", message: "Previous turn failed." } : null }
    f.hooks.observe = () => progress
    const runner = f.runner()
    await runner.accept(command, signal())
    await runner.reconcile(signal())
    const request: Request = { requestId: "request_followup", kind: "remote_session_request", commandId: command.commandId,
      ...receipt, engine: null, expiresAt: 10_000, action: "send", input: { prompt: "Next turn", messageId: null, model: null } }
    await runner.execute(request, signal())
    assert.equal(f.store.data.commands[0]?.turn?.seenActive, false, "fresh-session acceptance evidence is not inherited by followups")
    const restarted = f.runner()
    await restarted.reconcile(signal())
    assert.equal(f.calls.reports.at(-1)?.status, "running")
    assert.equal(f.calls.reports.at(-1)?.finalText, "")
    assert.equal(f.calls.reports.at(-1)?.error, null)
    progress = { status: "idle", messageCount: (progress.messageCount ?? 0) + 2,
      finalText: "New answer", error: null, observedAt: 103 }
    await restarted.reconcile(signal())
    assert.equal(f.calls.reports.at(-1)?.status, "idle")
    assert.equal(f.calls.reports.at(-1)?.finalText, "New answer")
    assert.equal(f.calls.send, 1)
  })
}

test("separate initial send still suppresses an old terminal error without current-turn activity", async () => {
  const f = fixture(false)
  f.hooks.observe = () => ({ status: "error", messageCount: 1, finalText: "Old answer", observedAt: 101,
    error: { code: "nativeUnavailable", message: "Previous turn failed." } })
  const runner = f.runner()
  await runner.accept(command, signal())
  assert.equal(f.store.data.commands[0]?.turn?.seenActive, false)
  await f.runner().reconcile(signal())
  assert.equal(f.calls.reports.at(-1)?.status, "running")
  assert.equal(f.calls.reports.at(-1)?.finalText, "")
  assert.equal(f.calls.reports.at(-1)?.error, null)
})
