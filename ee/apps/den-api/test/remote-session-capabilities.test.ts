import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { RemoteSessionCommand, RemoteSessionDesktopSession } from "../src/remote-sessions/commands.js"
import type { RemoteSessionRequest } from "../src/remote-sessions/requests.js"
import type { RemoteSessionExecuteDeps, RemoteSessionDesktopRecord } from "../src/mcp/remote-session-capabilities.js"

// These tests exercise the service boundary with injected ports, never a live
// account, Cloud worker, or database query. The module's default adapters still
// need a valid local configuration at import time.
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-remote-session-test-key-000000000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-remote-session-test-secret-000000"
process.env.DEN_BASE_URL ??= "http://127.0.0.1:3005"

const { DEFAULT_REMOTE_SESSION_DEPS, executeRemoteSessionCapability, searchRemoteSessionCapabilities } = await import("../src/mcp/remote-session-capabilities.js")
const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")

function command(): RemoteSessionCommand {
  return {
    id: createDenTypeId("remoteSessionCommand"), organizationId, ownerMemberId, createdByUserId: userId,
    status: "pending", title: "Synthetic native session", prompt: null, model: null, idempotencyKey: null,
    targetComputerId: "synthetic-computer", targetWorkspaceId: "synthetic-workspace", expiresAt: Date.now() + 60_000,
    claimedByRunnerId: null, claimedAt: null, sessionId: null, workspaceId: null, resultSummary: null,
    error: null, session: null, createdAt: Date.now(), updatedAt: Date.now(),
  }
}

function computer(id = "synthetic-computer"): RemoteSessionDesktopRecord {
  return {
    computerId: id, registered: true, platform: "linux", appVersion: "2.0.26", lastSeenAt: Date.now(),
    inventory: {
      computer: { label: "Synthetic OpenCode", platform: "linux", appVersion: "2.0.26" },
      workspaces: [{ workspaceId: "synthetic-workspace", name: "Project", active: true, engine: "v2", defaultModel: null, models: [] }],
    },
  }
}

function deps(overrides: Partial<RemoteSessionExecuteDeps> = {}): RemoteSessionExecuteDeps {
  return {
    ...DEFAULT_REMOTE_SESSION_DEPS,
    getOpenWorkWebAccess: async () => ({ hasAccess: false }),
    desktopTargets: async () => ({ ownerMemberId, computers: [computer()] }),
    cloudAvailable: () => true,
    linkDesktopCommand: undefined,
    ...overrides,
  }
}

async function call(action: "create" | "read" | "send" | "stop" | "targets" | "list", body: unknown, dependencies: RemoteSessionExecuteDeps, hasWriteScope = true) {
  const result = await executeRemoteSessionCapability({ action, organizationId, userId, hasWriteScope, body }, dependencies)
  assert.ok(result.structuredContent)
  return { error: result.isError === true, payload: result.structuredContent }
}

test("registered client creation does not provision Cloud or require Web access", async () => {
  const queued = command()
  let enqueued = 0
  const result = await call("create", { target: "registered", computerId: "synthetic-computer", workspaceId: "synthetic-workspace" }, deps({
    getOpenWorkWebAccess: async () => { throw new Error("Registered creation must not depend on Cloud billing") },
    resolveRuntime: async () => { throw new Error("Registered creation must not provision a worker") },
    commandStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
      latestSettled: async () => null,
      enqueue: async (input) => {
        enqueued++
        assert.equal(input.organizationId, organizationId)
        assert.equal(input.ownerMemberId, ownerMemberId)
        assert.equal(input.targetComputerId, "synthetic-computer")
        assert.equal(input.targetWorkspaceId, "synthetic-workspace")
        return queued
      },
    },
  }))
  assert.equal(result.error, false)
  assert.equal(result.payload.target, "registered")
  assert.equal(result.payload.commandId, queued.id)
  assert.equal(enqueued, 1)
})

test("registered targets are discoverable without Web access but do not claim Cloud availability", async () => {
  const target = computer()
  const result = await call("targets", { includeModels: true }, deps({ desktopTargets: async () => ({ ownerMemberId, computers: [target] }) }))
  assert.deepEqual(result.payload.cloud, { available: false, capabilities: [] })
  assert.ok(Array.isArray(result.payload.computers))
  assert.equal(result.payload.computers.length, 1)
  assert.deepEqual(result.payload.computers[0], {
    computerId: "synthetic-computer", kind: "registered", label: "Synthetic OpenCode", platform: "linux", appVersion: "2.0.26",
    online: true, lastSeenAt: target.lastSeenAt, capabilities: ["create", "read", "send", "stop"],
    workspaces: [{ workspaceId: "synthetic-workspace", name: "Project", active: true, engine: "v2", defaultModel: null, models: [] }],
  })
})

test("multiple connected clients require an explicit choice instead of silently picking a machine", async () => {
  const result = await call("create", { target: "registered" }, deps({
    desktopTargets: async () => ({ ownerMemberId, computers: [computer("one"), computer("two")] }),
  }))
  assert.equal(result.payload.error, "ambiguous_computer")
})

test("a different member's computer cannot be selected", async () => {
  const result = await call("create", { target: "registered", computerId: "another-member-computer" }, deps())
  assert.equal(result.payload.error, "unknown_computer")
})

test("write scope is still required for registered creation", async () => {
  const result = await call("create", { target: "registered" }, deps(), false)
  assert.equal(result.payload.error, "insufficient_mcp_scope")
})

test("the legacy Cloud and desktop paths retain their Web access gate", async () => {
  for (const target of ["cloud", "desktop"]) {
    const result = await call("create", { target }, deps())
    assert.equal(result.payload.error, "openwork_web_access_required")
  }
})

test("registered admission cannot select legacy desktops through explicit, workspace-only, or automatic targeting", async () => {
  const legacy = { ...computer("legacy-computer"), registered: false }
  let enqueued = 0
  const dependencies = deps({
    desktopTargets: async () => ({ ownerMemberId, computers: [legacy] }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, enqueue: async () => { enqueued++; return command() } },
  })
  for (const selection of [{ computerId: legacy.computerId }, { workspaceId: "synthetic-workspace" }, {}]) {
    const result = await call("create", { target: "registered", ...selection }, dependencies)
    assert.equal(result.error, true)
    assert.equal(result.payload.commandId, undefined)
  }
  assert.equal(enqueued, 0)
})

test("registered automatic targeting excludes a newer legacy computer", async () => {
  const selected: string[] = []
  const result = await call("create", { target: "registered" }, deps({
    desktopTargets: async () => ({ ownerMemberId, computers: [{ ...computer("legacy"), registered: false }, computer()] }),
    commandStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
      latestSettled: async () => null,
      enqueue: async (input) => { selected.push(input.targetComputerId ?? ""); return command() },
    },
  }))
  assert.equal(result.error, false)
  assert.deepEqual(selected, ["synthetic-computer"])
})

test("a stable create key is namespaced to the authenticated member and organization", async () => {
  const keys: string[] = []
  const dependencies = deps({ commandStore: {
    ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
    latestSettled: async () => null,
    enqueue: async (input) => { assert.ok(input.idempotencyKey); keys.push(input.idempotencyKey); return command() },
  } })
  for (let attempt = 0; attempt < 2; attempt++) {
    await call("create", { target: "registered", idempotencyKey: "synthetic-client-retry" }, dependencies)
  }
  assert.equal(keys.length, 2)
  assert.equal(keys[0], keys[1])
  assert.match(keys[0] ?? "", /^remote_[a-f0-9]{64}$/)
  assert.notEqual(keys[0], "synthetic-client-retry")
})

test("a create key cannot imply Cloud idempotency that is not implemented", async () => {
  const result = await call("create", { target: "cloud", idempotencyKey: "synthetic-key" }, deps())
  assert.equal(result.payload.error, "invalid_capability_arguments")
})

test("registered offloads preserve trusted Slack result handoff", async () => {
  const queued = command()
  let linked = false
  const result = await executeRemoteSessionCapability({ action: "create", organizationId, userId, hasWriteScope: true,
    headlessRunTokenId: "synthetic-headless-token", body: { target: "registered", prompt: "Summarize my notes" },
  }, deps({
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, latestSettled: async () => null, enqueue: async () => queued },
    linkDesktopCommand: async (input) => { assert.equal(input.commandId, queued.id); assert.equal(input.userId, userId); linked = true; return true },
  }))
  assert.equal(linked, true)
  assert.equal(result.structuredContent?.resultPostedInThread, true)
})

test("MCP discovery describes the harness-neutral offload target", () => {
  const match = searchRemoteSessionCapabilities("offload opencode plugin create session", 20).find((entry) => entry.name === "remote-session:create")
  assert.ok(match)
  assert.match(match.summary, /OpenCode/)
  assert.match(match.summary, /registered/)
})

function desktopSession(): RemoteSessionDesktopSession {
  return {
    commandId: createDenTypeId("remoteSessionCommand"), ownerMemberId, runnerId: "synthetic-runner", sessionId: "ses_synthetic",
    workspaceId: "synthetic-workspace", title: "Synthetic native session", engine: "v2", status: "waiting", updatedAt: Date.now(),
  }
}

const pendingQuestion = {
  id: "que_synthetic",
  questions: [{ header: "Scope", question: "Which path?", options: [{ label: "Local only", description: "No cloud" }], multiple: false, custom: true }],
}

/** A desktop session whose runner answers requests at once with the given outcome. */
function sessionDeps(runner: Awaited<ReturnType<RemoteSessionExecuteDeps["desktopRunner"]>>, outcome: (request: RemoteSessionRequest) => RemoteSessionRequest["outcome"]) {
  const session = desktopSession()
  const enqueued: RemoteSessionRequest[] = []
  const dependencies = deps({
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => session },
    desktopRunner: async () => runner,
    requestWait: { timeoutMs: 50, pollMs: 1 },
    requestStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.requestStore,
      enqueue: async (input) => {
        const now = Date.now()
        const request: RemoteSessionRequest = {
          ...input, id: createDenTypeId("remoteSessionRequest"), status: "done", outcome: null, error: null,
          expiresAt: now + input.ttlMs, claimedAt: now, completedAt: now, createdAt: now, updatedAt: now,
        }
        const done = { ...request, outcome: outcome(request) }
        enqueued.push(done)
        return done
      },
    },
  })
  return { session, enqueued, dependencies }
}

const answerCapable = { connected: true, controlCapable: true, registered: true, answerCapable: true, capabilities: ["create", "read", "send", "stop", "answer"] as const }

async function answerCall(body: unknown, dependencies: RemoteSessionExecuteDeps, answersEnabled = true, action: "answer" | "read" = "answer") {
  const result = await executeRemoteSessionCapability({ action, organizationId, userId, hasWriteScope: true, body, answersEnabled }, dependencies)
  assert.ok(result.structuredContent)
  return { error: result.isError === true, payload: result.structuredContent }
}

test("targets list each client's capabilities: answer only where the runner registered it and the feature is on", async () => {
  const desktop = { ...computer("desktop"), runnerCapabilities: ["model_attention_v1", "remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"] }
  const opencode = { ...computer("opencode"), runnerCapabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"] }
  const released = { ...computer("released"), registered: false, runnerCapabilities: ["model_attention_v1", "remote_session_v1"] }
  const dependencies = deps({ desktopTargets: async () => ({ ownerMemberId, computers: [desktop, opencode, released] }), getOpenWorkWebAccess: async () => ({ hasAccess: true }) })
  const capabilities = async (answersEnabled: boolean) => {
    const result = await executeRemoteSessionCapability({ action: "targets", organizationId, userId, hasWriteScope: false, body: {}, answersEnabled }, dependencies)
    const payload = result.structuredContent
    assert.ok(payload && Array.isArray(payload.computers))
    return { computers: payload.computers.map((entry: { computerId: string; capabilities: string[] }) => [entry.computerId, entry.capabilities]), cloud: payload.cloud }
  }
  assert.deepEqual(await capabilities(true), {
    computers: [["desktop", ["create", "read", "send", "stop", "answer"]], ["opencode", ["create", "read", "send", "stop"]], ["released", ["create"]]],
    cloud: { available: true, capabilities: ["create", "read", "send", "stop"] },
  })
  assert.deepEqual((await capabilities(false)).computers[0], ["desktop", ["create", "read", "send", "stop"]])
})

test("an answer relays the person's choice to the runner that delivered the session", async () => {
  const { session, enqueued, dependencies } = sessionDeps(answerCapable, () => ({ action: "answer", result: { answered: true, reason: null } }))
  const result = await answerCall({ sessionId: session.sessionId, questionId: "que_synthetic", answers: [["Local only"]] }, dependencies)
  assert.equal(result.error, false)
  assert.equal(result.payload.answered, true)
  assert.equal(result.payload.commandId, session.commandId)
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]?.targetRunnerId, session.runnerId)
  assert.deepEqual({ action: enqueued[0]?.action, input: enqueued[0]?.input }, { action: "answer", input: { questionId: "que_synthetic", answers: [["Local only"]] } })
  await answerCall({ sessionId: session.sessionId, questionId: "que_synthetic", dismiss: true }, dependencies)
  assert.deepEqual(enqueued[1]?.input, { questionId: "que_synthetic", answers: null })
})

test("an answer needs exactly one of answers or dismiss", async () => {
  const { dependencies, enqueued } = sessionDeps(answerCapable, () => null)
  for (const body of [{ sessionId: "ses_synthetic", questionId: "q" }, { sessionId: "ses_synthetic", questionId: "q", answers: [["a"]], dismiss: true }]) {
    const result = await answerCall(body, dependencies)
    assert.equal(result.payload.error, "invalid_capability_arguments")
  }
  assert.equal(enqueued.length, 0)
})

test("clients without answers (OpenCode, released desktops) are told apart and never receive the request", async () => {
  const { session, enqueued, dependencies } = sessionDeps(
    { connected: true, controlCapable: true, registered: true, answerCapable: false, capabilities: ["create", "read", "send", "stop"] },
    () => null,
  )
  const result = await answerCall({ sessionId: session.sessionId, questionId: "que_synthetic", answers: [["Local only"]] }, dependencies)
  assert.equal(result.payload.error, "unsupported_by_target")
  assert.deepEqual(result.payload.capabilities, ["create", "read", "send", "stop"])
  assert.equal(enqueued.length, 0)
})

test("with answers off the action is refused and reads look as they always did", async () => {
  const { session, enqueued, dependencies } = sessionDeps(answerCapable, (request) => request.action === "read" ? {
    action: "read",
    result: { title: "Synthetic", status: "waiting", waitingFor: "question", pendingQuestion, lastError: null, messageCount: 0, from: "end", messages: [], nextCursor: null },
  } : null)
  const refused = await answerCall({ sessionId: session.sessionId, questionId: "que_synthetic", answers: [["Local only"]] }, dependencies, false)
  assert.equal(refused.payload.error, "remote_session_answers_unavailable")
  assert.equal(enqueued.length, 0)
  const hidden = await answerCall({ sessionId: session.sessionId }, dependencies, false, "read")
  assert.equal(hidden.payload.waitingFor, "question")
  assert.equal("pendingQuestion" in hidden.payload, false)
  const shown = await answerCall({ sessionId: session.sessionId }, dependencies, true, "read")
  assert.deepEqual(shown.payload.pendingQuestion, pendingQuestion)
})

test("Cloud sessions report that they cannot be answered remotely instead of guessing", async () => {
  const result = await answerCall({ sessionId: "ses_cloud", questionId: "que_synthetic", answers: [["Local only"]] }, deps({
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => null },
    resolveRuntime: async () => { throw new Error("An answer must not reach the Cloud worker") },
  }))
  assert.equal(result.payload.error, "unsupported_by_target")
  assert.equal(result.payload.target, "cloud")
})

test("MCP discovery offers answers only while the feature is on", () => {
  const names = (answers: boolean) => searchRemoteSessionCapabilities("answer remote session question", 20, { answers }).map((entry) => entry.name)
  assert.ok(names(true).includes("remote-session:answer"))
  assert.equal(names(false).includes("remote-session:answer"), false)
  const read = searchRemoteSessionCapabilities("read remote session transcript", 20, { answers: true }).find((entry) => entry.name === "remote-session:read")
  assert.match(read?.summary ?? "", /pendingQuestion/)
})
