import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createCoordinator } from "../src/coordinator.mjs"

const context = callId => ({ callId, "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-coordinator-thread", turn_id: "native-coordinator-turn" }) })
const nativeReply = object => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(object) }] })
async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "codex-coordinator-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = { directory, remoteSessions: true, nativeProjectScope: true, coordinatorThreadId: "native-coordinator-thread", project: { projectId: "project-local", path: directory, projectKind: "local", hostId: "local" } }
  const files = new Map(), calls = [], leases = [], lifecycle = []
  const command = { commandId: "command-offered", title: "Test task", prompt: "Reply with the test phrase only", model: null }
  let pending = [command.commandId], adapter, pollGate = null
  const coordinator = createCoordinator({
    readConfiguration: async () => config,
    readState: async name => structuredClone(files.get(name) ?? null),
    writeState: async (name, value) => { files.set(name, structuredClone(value)) },
    clientFactory: () => ({
      listTools: async () => [{ name: "create_thread", namespace: "codex_app" }, { name: "list_projects", namespace: "codex_app" }],
      invokeOnce: async request => {
        calls.push(request)
        if (request.tool === "list_projects") return nativeReply({ schemaVersion: 2, projects: [{ ...config.project, label: "Test project", hostDisplayName: null, isGitRepository: false }] })
        assert.equal(request.confirmed, true)
        return nativeReply({ hostId: "local", threadId: "00000000-0000-4000-8000-000000000001" })
      },
      close: () => { lifecycle.push("client-close") },
    }),
    adapterFactory: options => { adapter = options; return options },
    hostFactory: async options => {
      adapter = await options.adapterFactory(config, { partition: "test-partition" })
      return {
        owned: true, status: () => ({ state: "connected" }),
        poll: async () => { leases.push(options.canAcceptCreations()); if (pollGate) await pollGate },
        pendingCreations: () => [...pending],
        dispatchCreation: async (id, signal) => {
          if (!pending.includes(id)) throw new Error("creation_not_offered")
          const receipt = await adapter.nativeCreation.create(command, signal)
          await adapter.nativeCreation.saveEnrollment({ sessionId: receipt.threadId, directory, confirmed: true })
          pending = pending.filter(value => value !== id)
          return { status: "delivered", sessionId: receipt.threadId, workspaceId: "codex-local" }
        },
        close: async () => { lifecycle.push("host-close") },
      }
    },
    enable: async input => ({ enabled: input.confirm, projectId: input.project.projectId }),
  })
  t.after(() => coordinator.close())
  return { coordinator, config, files, calls, leases, lifecycle, command, setPending: value => { pending = value }, setPollGate: value => { pollGate = value }, adapter: () => adapter }
}

test("project discovery uses its genuine invocation and is separate from explicit enrollment", async t => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const result = await f.coordinator.listProjects(context("call-projects"), signal)
  assert.equal(result.projects[0].projectId, "project-local")
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].tool, "list_projects")
  assert.equal(f.calls[0].metadata.callId, "call-projects")
  await assert.rejects(f.coordinator.enable({ directory: f.config.directory, projectId: "unknown", confirm: true, confirmNativeProjectScope: true }, context("call-enable"), signal), /selected discovered project/)
  const enabled = await f.coordinator.enable({ directory: f.config.directory, projectId: "project-local", confirm: true, confirmNativeProjectScope: true }, context("call-enable"), signal)
  assert.equal(enabled.enabled, true)
  assert.equal(f.calls.length, 1, "enrollment does not create any native chat")
})

test("wait never consumes native creation identity; dispatch uses a separate authentic call", async t => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const task = await f.coordinator.waitForTask(context("call-wait"), signal)
  assert.deepEqual(f.calls, [])
  assert.equal(task.commandId, f.command.commandId)
  assert.equal(task.prompt, undefined, "task content must not instruct the coordinator")
  const result = await f.coordinator.createTask(task.commandId, context("call-create"), signal)
  assert.equal(result.status, "delivered")
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].metadata.callId, "call-create")
  assert.equal(f.calls[0].args.prompt, f.command.prompt)
  assert.deepEqual(f.calls[0].args.target, { type: "project", projectId: "project-local", environment: { type: "local" } })
  assert.ok(f.files.has("native-bindings-test-partition.json"))
  assert.ok(f.leases.every(Boolean))
  await assert.rejects(f.adapter().nativeCreation.create(f.command, signal), /genuine_invocation_required/)
  assert.equal(f.calls.length, 1, "no metadata reuse after dispatch returns")
})

test("missing caller context and unoffered commands cannot dispatch native creation", async t => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  await assert.rejects(f.coordinator.listProjects({}, signal), /genuine/)
  await assert.rejects(f.coordinator.waitForTask({}, signal), /genuine/)
  await assert.rejects(f.coordinator.createTask("command-offered", {}, signal), /genuine/)
  await assert.rejects(f.coordinator.createTask("not-offered", context("call-unknown"), signal), /creation_not_offered/)
  assert.deepEqual(f.calls, [])
})

test("another GUI chat and missing native-project consent cannot take over the receiver", async t => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const other = { callId: "other-chat", "x-codex-turn-metadata": JSON.stringify({ thread_id: "other-thread", turn_id: "other-turn" }) }
  await assert.rejects(f.coordinator.waitForTask(other, signal), /chat that explicitly enrolled/)
  await assert.rejects(f.coordinator.createTask(f.command.commandId, other, signal), /enrolled GUI coordinator/)
  await assert.rejects(f.coordinator.enable({ directory: f.config.directory, projectId: "project-local", confirm: true }, context("call-consent"), signal), /current\/future roots/)
  assert.deepEqual(f.calls, [])
})

test("the wait deadline bounds an uncooperative shared poll", async t => {
  const f = await fixture(t)
  f.setPending([])
  f.setPollGate(new Promise(() => {}))
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const result = await f.coordinator.waitForTask(context("call-deadline"), new AbortController().signal, 10)
    assert.equal(result.state, "waiting")
    assert.deepEqual(f.calls, [])
  } finally { clearTimeout(keepAlive) }
})

test("cancellation releases the wait lease without claiming or creating", async t => {
  const f = await fixture(t)
  f.setPending([])
  const controller = new AbortController()
  const waiting = f.coordinator.waitForTask(context("call-cancel"), controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(waiting)
  assert.deepEqual(f.calls, [])
  const next = await f.coordinator.waitForTask(context("call-timeout"), new AbortController().signal, 5)
  assert.equal(next.state, "waiting")
  assert.deepEqual(f.calls, [])
})
