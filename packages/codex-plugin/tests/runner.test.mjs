import test from "node:test"
import assert from "node:assert/strict"
import { createCodexRunner, joinFlight, sessionRunnerIdentity } from "../src/runner.mjs"

function fixture(overrides = {}, runnerOptions = {}) {
  const now = 1_800_000_000_000
  let config = { apiBaseUrl: "https://den.example.test", token: "member-token", orgId: "org_test", userId: "usr_test", enabled: true, directory: "/approved", installationId: "install-test", expiresAt: now + 1000000, ...overrides }
  const calls = []; const native = []; const journals = new Map()
  const command = { commandId: "rsc_test", kind: "remote_session_create", title: "Test", prompt: "Say hello", model: null, expiresAt: now + 100000, workspaceId: null }
  let hasWork = true
  const adapter = {
    creation: "at_most_once", sendReplay: "at_most_once",
    async diagnose() { native.push("diagnose") },
    async create() { native.push("create"); return { sessionId: "native_test", workspaceId: "codex-local" } },
    async send(_receipt, input) { native.push("send"); return { messageId: input.messageId, alreadyPresent: false } },
    async observe() { return { status: "running", messageCount: 1, observedAt: now } },
  }
  const fetcher = async (input, init) => {
    const path = new URL(input).pathname
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, body, authorization: init.headers.authorization })
    let result
    if (path === "/v1/me") result = { user: { id: "usr_test" } }
    else if (path === "/v1/session-runners/token") result = { token: "runner-token-xxxxxxxxxxxxxxxxxxxxxxxx", expiresAt: now + 1000000 }
    else if (path === "/v1/session-runners/inventory") result = { ok: true, updatedAt: now }
    else if (path === "/v1/session-runners/work") { result = { items: hasWork ? [{ kind: "remote_session_create", commandId: command.commandId }] : [] }; hasWork = false }
    else if (path.endsWith("/claim")) result = { assignment: command }
    else if (path.endsWith("/complete")) result = { command: { id: command.commandId, ...body } }
    else if (path.endsWith("/session")) result = { ok: true }
    else throw new Error(`Unexpected path: ${path}`)
    return Response.json(result)
  }
  const runner = createCodexRunner({ ...runnerOptions, account: async () => config, adapter, now: () => now, fetcher, journal: async identity => ({ load: async () => journals.get(identity), save: async value => journals.set(identity, structuredClone(value)) }) })
  return { runner, adapter, calls, native, journals, setConfig: value => { config = { ...config, ...value } } }
}

test("joining a shared poll is cancellable without cancelling the original flight", async () => {
  let finish
  const flight = new Promise(resolve => { finish = resolve })
  const controller = new AbortController()
  const joined = joinFlight(flight, controller.signal)
  controller.abort()
  await assert.rejects(joined)
  finish("original-poll-completed")
  assert.equal(await flight, "original-poll-completed")
})

test("account, project and installation are independent ownership partitions", () => {
  const base = { apiBaseUrl: "https://den.example.test", orgId: "org-a", userId: "user-a", installationId: "install-a", directory: "/approved", projectId: "project-a" }
  const original = sessionRunnerIdentity(base)
  for (const change of [{ userId: "user-b" }, { orgId: "org-b" }, { projectId: "project-b" }, { installationId: "install-b" }]) assert.notEqual(sessionRunnerIdentity({ ...base, ...change }), original)
  assert.equal(sessionRunnerIdentity({ ...base, token: "rotated-token" }), original)
})

test("sign-in alone never registers or controls Codex", async () => {
  const f = fixture({ enabled: false })
  await f.runner.poll()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.native, [])
  assert.equal(f.runner.inspectStatus().phase, "opt_in")
})
test("expired member credentials cannot register or use Codex", async () => {
  const f = fixture({ expiresAt: 0 })
  await f.runner.poll()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.native, [])
})
test("uses durable existing create protocol and advertises no fabricated OpenCode engine", async () => {
  const f = fixture()
  await f.runner.poll()
  assert.deepEqual(f.native, ["diagnose", "create", "send"])
  const inventory = f.calls.find(call => call.path.endsWith("/inventory"))
  assert.deepEqual(inventory.body.workspaces, [])
  assert.match(inventory.body.computer.label, /^Codex/)
  const register = f.calls.find(call => call.path.endsWith("/token"))
  assert.ok(register.body.capabilities.includes("remote_session_only_v1"))
  assert.ok(register.body.capabilities.includes("remote_session_recovery_v1"))
  assert.equal(f.journals.size, 1)
  const journal = [...f.journals.values()][0]
  assert.equal(journal.commands[0].completion.status, "delivered")
  assert.equal(JSON.stringify(journal).includes("member-token"), false)
  await f.runner.poll()
  assert.equal(f.native.filter(value => value === "create").length, 1)
  assert.equal(f.native.filter(value => value === "send").length, 1)
})
test("manual native creation only dispatches an offered command and includes its first prompt once", async () => {
  const f = fixture({}, { creationDispatch: "manual" })
  f.adapter.creationPrompt = "included"
  await f.runner.poll()
  assert.deepEqual(f.native, ["diagnose"])
  assert.deepEqual(f.runner.pendingCreations(), ["rsc_test"])
  assert.equal(f.calls.some(call => call.path.endsWith("/claim")), false)
  await assert.rejects(f.runner.dispatchCreation("not-offered"), /creation_not_offered/)
  const result = await f.runner.dispatchCreation("rsc_test")
  assert.equal(result.status, "delivered")
  assert.deepEqual(f.native, ["diagnose", "create"])
  assert.deepEqual(f.runner.pendingCreations(), [])
  assert.equal([...f.journals.values()][0].commands[0].creationPrompt, "included")
})

test("without an active coordinator, register control only and do not claim creates", async () => {
  const f = fixture({}, { creationDispatch: "manual", canAcceptCreations: () => false })
  await f.runner.poll()
  const register = f.calls.find(call => call.path.endsWith("/token"))
  assert.equal(register.body.capabilities.includes("remote_session_v1"), false)
  assert.equal(register.body.capabilities.includes("remote_session_control_v1"), true)
  assert.deepEqual(f.runner.pendingCreations(), [])
  assert.equal(f.calls.some(call => call.path.endsWith("/claim")), false)
  assert.deepEqual(f.native, ["diagnose"])
})

test("native creation unavailability does not poison a manual receiver's existing control capability", async () => {
  const f = fixture({}, { creationDispatch: "manual" })
  f.adapter.diagnose = async () => ({ connected: true, nativeCreation: false, requiresCoordinator: true })
  await f.runner.poll()
  const register = f.calls.find(call => call.path.endsWith("/token"))
  assert.equal(register.body.capabilities.includes("remote_session_v1"), false)
  assert.equal(register.body.capabilities.includes("remote_session_control_v1"), true)
  assert.equal(f.calls.some(call => call.path.endsWith("/work")), true)
  assert.equal(f.runner.inspectStatus().nativeCreationReady, false)
  assert.deepEqual(f.runner.pendingCreations(), [])
})

test("changed member identity fails before native discovery and registration", async () => {
  const f = fixture({ userId: "usr_other" })
  await assert.rejects(f.runner.poll(), /identity_changed/)
  assert.deepEqual(f.native, [])
  assert.equal(f.calls.length, 1)
})
test("unverified native GUI creation cannot advertise or claim a remote target", async () => {
  const f = fixture()
  f.adapter.diagnose = async () => ({ connected: true, nativeCreation: false })
  await assert.rejects(f.runner.poll(), /native_creation_unavailable/)
  assert.deepEqual(f.native, [])
  assert.deepEqual(f.calls.map(call => call.path), ["/v1/me"])
  assert.equal(f.runner.inspectStatus().error, "native_creation_unavailable")
})

test("unsafe API URL cannot receive credentials", async () => {
  const f = fixture({ apiBaseUrl: "http://untrusted.example.test" })
  await assert.rejects(f.runner.poll(), /unsafe_api_url/)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.native, [])
})
