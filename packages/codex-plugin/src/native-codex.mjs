import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { createHash } from "node:crypto"
import { SessionRunnerError, stableMessageId } from "../lib/index.mjs"
import { createIpcClient, IpcError, MAX_FRAME_BYTES, METHOD_VERSIONS } from "./ipc.mjs"
import { NativeAppToolsError } from "./native-app-tools.mjs"

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const fail = (code, message) => new SessionRunnerError(code, message)
class NativeSnapshotSchemaError extends SessionRunnerError {
  constructor() { super("native_schema_mismatch", "Codex provided an unsupported native snapshot version.") }
}
const READ_LIMIT = 100
const TEXT_LIMIT = 16000
const SOURCES = Object.freeze({
  build: "155",
  runtime: ".vite/build/src-BJv5Mk7n.js",
  functions: ["De/ke", "_1/bb", "Sj/wj", "uj/yj", "rx"],
  transport: ".vite/build/main-CqEoQDOU.js:cfe/ufe",
})

/** Exact minimal direct start envelope consumed by Sj/wj/uj in installed build 155.
 * Omitted permission/model/context properties are intentional: uj inherits latest
 * thread settings, current permissions and the previous default-policy mode.
 * Do NOT set useAppServerPermissionDefault=true (could replace existing policy),
 * usePermissionSelection, approvalsReviewer, sandboxPolicy or runtime roots.
 * Native clientUserMessageId is correlation, NOT proven durable deduplication.
 */
export function nativeTurnStart(sessionId, { prompt, messageId, model }) {
  if (!UUID.test(sessionId) || typeof prompt !== "string" || !prompt.trim()
      || typeof messageId !== "string" || !messageId) throw fail("invalid_input", "A thread, prompt and stable message ID are required.")
  if (model != null) throw fail("model_override_unavailable", "This prototype preserves the native thread's existing model and permissions. Select its model in Codex.")
  return {
    request: { threadId: sessionId, input: [{ type: "text", text: prompt, text_elements: [] }], clientUserMessageId: messageId },
    context: { inheritThreadSettings: true },
  }
}

function turnsFor(state) {
  if (state.turnHistory?.kind === "canonical") {
    const history = state.turnHistory.history
    if (!Array.isArray(history?.islands) || !history.entitiesByKey) throw fail("native_schema_mismatch", "Native conversation history has an unsupported shape.")
    const seen = new Set(), turns = []
    for (const island of history.islands) {
      if (!Array.isArray(island.entries)) throw fail("native_schema_mismatch", "Native history entries are unavailable.")
      for (const entry of island.entries) {
        if (seen.has(entry.value)) continue
        seen.add(entry.value)
        const turn = history.entitiesByKey[entry.value]
        if (turn) turns.push(turn)
      }
    }
    return turns
  }
  if (!Array.isArray(state.turns)) throw fail("native_schema_mismatch", "Native conversation turns are unavailable.")
  return state.turns
}
function textContent(input) {
  return (Array.isArray(input) ? input : []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
}
function safeError(turn) {
  return turn?.status === "failed" ? { code: "native_turn_failed", message: "The native Codex turn failed. Inspect the thread in Codex." } : null
}
function messagesFor(state) {
  const messages = []
  for (const [index, turn] of turnsFor(state).entries()) {
    const turnId = turn.turnId ?? `pending-${index}`
    const userText = textContent(turn.params?.input)
    const createdAt = Number.isFinite(turn.turnStartedAtMs) ? turn.turnStartedAtMs : null
    if (userText) messages.push({ id: turn.params.clientUserMessageId ?? `${turnId}:user`, role: "user", createdAt,
      text: userText.slice(0, TEXT_LIMIT), truncated: userText.length > TEXT_LIMIT, toolCalls: [], error: null })
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && typeof item.text === "string") messages.push({
        id: item.id ?? `${turnId}:assistant-${messages.length}`, role: "assistant", createdAt,
        text: item.text.slice(0, TEXT_LIMIT), truncated: item.text.length > TEXT_LIMIT, toolCalls: [], error: safeError(turn),
      })
      if (item.type === "steeringUserMessage" && typeof item.text === "string") messages.push({
        id: item.clientUserMessageId ?? item.id, role: "user", createdAt, text: item.text.slice(0, TEXT_LIMIT),
        truncated: item.text.length > TEXT_LIMIT, toolCalls: [], error: null,
      })
    }
  }
  return messages
}
function observation(state, now) {
  const turns = turnsFor(state), latest = turns.at(-1)
  const requests = (state.requests ?? []).filter((request) => request.completedAtMs == null)
  const methods = requests.map((request) => request.method)
  const permission = methods.some((method) => ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method))
  const question = methods.some((method) => ["item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(method))
  const flags = state.threadRuntimeStatus?.activeFlags ?? []
  const waitingFor = permission || flags.includes("waitingOnApproval") ? "permission"
    : question || flags.includes("waitingOnUserInput") ? "question" : null
  if (!state.threadRuntimeStatus || !["idle", "active", "systemError", "notLoaded"].includes(state.threadRuntimeStatus.type)) {
    throw fail("native_schema_mismatch", "Native runtime status is unavailable.")
  }
  if (state.resumeState === "needs_resume" || state.threadRuntimeStatus.type === "notLoaded") throw fail("native_thread_unavailable", "Open this enrolled thread in Codex before controlling it.")
  const status = waitingFor ? "waiting" : latest?.status === "failed" || state.threadRuntimeStatus.type === "systemError" ? "error"
    : state.threadRuntimeStatus.type === "active" || latest?.status === "inProgress" || state.unconfirmedTurnSubmissions?.length ? "running" : "idle"
  const messages = messagesFor(state)
  const latestAssistant = [...(latest?.items ?? [])].reverse().find((item) => item.type === "agentMessage" && typeof item.text === "string")
  return { status, waitingFor, error: status === "error" ? safeError(latest) ?? { code: "native_runtime_error", message: "Codex reported a native runtime error." } : null,
    messageCount: messages.length, observedAt: now(), ...(status === "idle" && latestAssistant ? { finalText: latestAssistant.text.slice(0, TEXT_LIMIT) } : {}) }
}

/** HarnessAdapter plus diagnose/enroll/close. No CLI spawning or app-server ownership.
 * enrollments: [{ sessionId, directory, confirmed:true, commandId?:string,
 *   initialMessageId?:string, initialTurnId?:string, verificationPending?:boolean,
 *   initialPrompt?:string, projectId?:string }]. These are also the restore API. Pending records are
 * known accepted children, NOT permission to control them; their bounded initial
 * prompt is private correlation state, removed after verification.
 * Without nativeCreation, commandId explicitly binds a human-created GUI thread.
 * nativeCreation: { ready(signal):Promise<boolean>,
 *   create(command, signal):Promise<{threadId, hostId}>, saveEnrollment?(record) }.
 * The coordinator MUST gate this port to a currently executing create_remote_task
 * MCP invocation and a human-confirmed saved local project. create must accept
 * command.prompt in its single native create_thread call before returning.
 * projectScope: { projectId, confirmed:true } authorizes the selected saved native
 * PROJECT RESOURCE, including all its current/future roots, not a folder sandbox.
 * The coordinator supplies it only after persisting explicit project-scope consent.
 * Native permissions remain unchanged. Trusted creator records carry projectId;
 * their first verified snapshot pins the actual root for later control. Manual
 * enrollment/bindings always retain strict configured-directory authorization.
 * Only confirmed records authorize control; journal/receipt IDs alone do not.
 */
export function createNativeCodexAdapter({ directory, workspaceId, socketPath = join(homedir(), ".codex", "ipc", "ipc.sock"),
  sourceThreadId, enrollments = [], nativeCreation, projectScope, timeoutMs = 5000, now = Date.now, ipcClient } = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory) || typeof workspaceId !== "string" || !workspaceId) throw fail("invalid_configuration", "An absolute directory and workspace ID are required.")
  if (nativeCreation != null && (typeof nativeCreation.ready !== "function" || typeof nativeCreation.create !== "function"
      || nativeCreation.saveEnrollment != null && typeof nativeCreation.saveEnrollment !== "function")) {
    throw fail("invalid_configuration", "Native creation requires coordinator readiness and creation callbacks.")
  }
  if (projectScope != null && (projectScope.confirmed !== true || typeof projectScope.projectId !== "string"
      || !projectScope.projectId.trim() || projectScope.projectId.length > 4096)) {
    throw fail("invalid_configuration", "Native project scope requires an explicitly confirmed saved project ID.")
  }
  const ipc = ipcClient ?? createIpcClient({ socketPath, timeoutMs })
  const authorized = new Map(), bindings = new Map(), creationAttempts = new Set()
  function validateInitialTurn(entry) {
    if (entry.verificationPending != null && typeof entry.verificationPending !== "boolean"
        || entry.verificationPending === true && (typeof entry.initialPrompt !== "string" || !entry.initialPrompt.trim()
          || Buffer.byteLength(entry.initialPrompt) > MAX_FRAME_BYTES || entry.initialMessageId == null || entry.initialTurnId != null)
        || entry.initialMessageId != null && (typeof entry.initialMessageId !== "string" || !entry.initialMessageId.trim())
        || entry.initialTurnId != null && (typeof entry.initialTurnId !== "string" || !entry.initialTurnId.trim() || entry.initialMessageId == null)) {
      throw fail("invalid_configuration", "Initial turn aliases require a nonempty message ID and, when available, native turn ID.")
    }
  }
  let closed = false, rootPromise
  const resolveDirectory = async (path) => {
    try { return await realpath(path) }
    catch { throw fail("directory_unavailable", "The configured native project directory is not accessible.") }
  }
  const root = () => rootPromise ??= resolveDirectory(directory)
  for (const entry of enrollments) {
    if (entry.confirmed !== true || typeof entry.sessionId !== "string" || !UUID.test(entry.sessionId) || typeof entry.directory !== "string" || !isAbsolute(entry.directory)) {
      throw fail("enrollment_confirmation_required", "Each enrollment needs an explicit confirmation, native UUID and absolute directory.")
    }
    validateInitialTurn(entry)
    if (entry.projectId != null && (typeof entry.projectId !== "string" || !entry.projectId.trim() || entry.projectId.length > 4096
        || entry.commandId != null || entry.initialMessageId == null || typeof entry.verificationPending !== "boolean"
        || !entry.verificationPending && entry.initialTurnId == null)) {
      throw fail("invalid_configuration", "Project-scoped restoration requires a private native-creator ownership record.")
    }
    if (authorized.has(entry.sessionId)) throw fail("invalid_configuration", "A native thread cannot be enrolled twice.")
    authorized.set(entry.sessionId, { ...entry })
    if (entry.commandId != null) {
      if (typeof entry.commandId !== "string" || !entry.commandId || bindings.has(entry.commandId)) throw fail("invalid_configuration", "Command bindings must be unique nonempty IDs.")
      bindings.set(entry.commandId, entry.sessionId)
    }
  }
  async function checkReceipt(receipt) {
    if (closed) throw fail("native_adapter_closed", "The native adapter is closed.")
    if (receipt?.workspaceId !== workspaceId || !authorized.has(receipt?.sessionId)) throw fail("native_thread_not_enrolled", "This native thread is not explicitly enrolled for this runner.")
    const entry = authorized.get(receipt.sessionId)
    if (entry.projectId != null) {
      if (projectScope?.projectId !== entry.projectId) throw fail("project_scope_mismatch", "This native child belongs to a different or unapproved saved project.")
      // Receipt authority is the approved creator/project record, not existence
      // of the obsolete setup folder. Snapshot validation discovers pending roots
      // and enforces verified roots without rebinding existing children.
    } else if (await resolveDirectory(entry.directory) !== await root()) {
      throw fail("directory_mismatch", "The confirmed enrollment belongs to a different directory.")
    }
    return entry
  }
  async function owner(receipt, signal) {
    await checkReceipt(receipt)
    try {
      const result = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: receipt.sessionId }, { signal })
      if (typeof result.handledByClientId !== "string") throw new IpcError("invalid_response")
      return result.handledByClientId
    } catch (error) {
      if (!(error instanceof IpcError) || !["not_connected", "socket_unavailable", "connect_timeout", "connection_failed",
        "connection_closed", "request_timeout", "aborted", "no-client-found", "no-handler-found"].includes(error.code)) throw error
      throw fail("native_owner_unavailable", "No compatible running Codex GUI owner is available for this enrolled thread.")
    }
  }
  async function pinnedProjectRoot(entry) {
    let current
    try { current = await resolveDirectory(entry.directory) }
    catch { throw fail("directory_mismatch", "The native child's pinned local project root is no longer accessible.") }
    // Verified project records store canonical paths. A later symlink must not
    // silently redirect that pin to another root.
    if (current !== entry.directory) throw fail("directory_mismatch", "The native child's pinned local project root changed.")
    return current
  }
  async function snapshot(receipt, signal) {
    const ownerId = await owner(receipt, signal)
    // Repeating following=true requests a fresh complete snapshot (not a stale
    // partial patch). Never request load-complete-history or read persisted DBs.
    let remove, timer, abort
    const incoming = new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(timer); remove?.(); signal?.removeEventListener("abort", abort); fn(value) }
      abort = () => finish(reject, fail("native_observation_aborted", "Native observation was cancelled."))
      timer = setTimeout(() => finish(reject, fail("native_snapshot_unavailable", "Codex did not provide a compatible native snapshot.")), timeoutMs)
      signal?.addEventListener("abort", abort, { once: true })
      remove = ipc.onBroadcast((message) => {
        const params = message.params, change = params?.change
        if (message.method !== "thread-stream-state-changed" || message.sourceClientId !== ownerId
            || params?.hostId !== "local" || params?.conversationId !== receipt.sessionId || change?.type !== "snapshot") return
        if (change.conversationState?.id !== receipt.sessionId) return
        if (message.version !== 11) return finish(reject, new NativeSnapshotSchemaError())
        finish(resolve, change.conversationState)
      })
    })
    // Ensure a broadcast failure does not leave an unhandled pending promise.
    incoming.catch(() => {})
    try {
      signal?.throwIfAborted()
      await ipc.broadcast("thread-stream-following-changed", { conversationId: receipt.sessionId, hostId: "local", following: true }, { signal, targetClientIds: [ownerId] })
      const state = await incoming, entry = await checkReceipt(receipt)
      if (typeof state.cwd !== "string" || !isAbsolute(state.cwd)
          || entry.projectId != null && typeof state.workspaceKind !== "string"
          || state.environments != null && (!Array.isArray(state.environments)
            || state.environments.some((environment) => typeof environment?.environmentId !== "string"))) {
        throw fail("native_schema_mismatch", "Native project scope has an unsupported snapshot shape.")
      }
      if ((entry.projectId != null ? state.workspaceKind !== "project" : state.workspaceKind === "projectless")
          || state.environments?.some((environment) => environment.environmentId !== "local")) {
        throw fail("directory_mismatch", "Native thread must remain in an authorized local project context.")
      }
      const canonicalDirectory = await resolveDirectory(state.cwd)
      const expectedDirectory = entry.projectId != null ? entry.verificationPending ? null : await pinnedProjectRoot(entry) : await root()
      if (expectedDirectory != null && canonicalDirectory !== expectedDirectory) {
        throw fail("directory_mismatch", "Native thread must use exactly its authorized local project directory.")
      }
      return { state, ownerId, canonicalDirectory }
    } finally { clearTimeout(timer); remove?.(); signal?.removeEventListener("abort", abort) }
  }
  const verificationUpdates = new Map()
  const pendingError = () => fail("native_verification_pending", "Native ownership and initial turn verification are pending. Control is disabled.")
  async function verifyPending(receipt, state, canonicalDirectory) {
    const assertPinned = async () => {
      const current = authorized.get(receipt.sessionId)
      if (current.projectId != null && !current.verificationPending
          && canonicalDirectory !== await pinnedProjectRoot(current)) {
        throw fail("directory_mismatch", "Native thread moved away from its verified local project root.")
      }
    }
    const entry = authorized.get(receipt.sessionId)
    if (!entry.verificationPending) return assertPinned()
    if (verificationUpdates.has(receipt.sessionId)) {
      await verificationUpdates.get(receipt.sessionId)
      return assertPinned()
    }
    const first = turnsFor(state)[0]
    // Never correlate the latest turn or a matching later turn: only the first
    // native turn carrying the exact accepted initial prompt can establish alias.
    if (!first || textContent(first.params?.input) !== entry.initialPrompt
        || typeof first.turnId !== "string" || !first.turnId.trim()) throw pendingError()
    const verified = { ...entry, verificationPending: false, initialTurnId: first.turnId,
      ...(entry.projectId != null ? { directory: canonicalDirectory } : {}) }
    delete verified.initialPrompt
    const update = (async () => {
      try { await nativeCreation?.saveEnrollment?.({ ...verified }) }
      catch { throw pendingError() }
      authorized.set(receipt.sessionId, verified)
    })()
    verificationUpdates.set(receipt.sessionId, update)
    try { await update; await assertPinned() } finally { verificationUpdates.delete(receipt.sessionId) }
  }
  const unavailable = error => error instanceof SessionRunnerError && !(error instanceof NativeSnapshotSchemaError)
    && ["native_owner_unavailable", "native_snapshot_unavailable",
    "native_observation_aborted", "native_thread_unavailable"].includes(error.code)
    || error instanceof IpcError && ["not_connected", "connection_failed", "connection_closed", "aborted", "request_timeout"].includes(error.code)
  const errorProgress = code => ({ status: "error", waitingFor: null, error: { code,
    message: code === "native_verification_pending" ? "Native verification is pending. Control is disabled."
      : code === "native_scope_changed" ? "This native child's local project scope changed. Reading and control are disabled."
      : "This native Codex thread is currently unavailable." }, observedAt: now() })
  function mutationError(error, action) {
    if (error instanceof IpcError && (error.rejection || !error.dispatched)) return fail("native_rejected", "Codex rejected the native operation before dispatch.")
    return fail(action === "send" ? "ambiguous_send" : "ambiguous_stop", "Codex did not confirm the native operation. Inspect its GUI thread; do not replay automatically.")
  }
  const adapter = {
    creation: "at_most_once",
    sendReplay: "at_most_once",
    ...(nativeCreation ? { creationPrompt: "included" } : {}),
    async create(command, signal) {
      if (nativeCreation) {
        if (closed) throw fail("native_adapter_closed", "The native adapter is closed.")
        if (command.workspaceId != null && command.workspaceId !== workspaceId) throw fail("workspace_unavailable", "The selected workspace is not this native adapter's workspace.")
        if (command.model != null) throw fail("model_override_unavailable", "Select the native model in Codex; this bridge preserves native defaults.")
        if (typeof command.prompt !== "string" || !command.prompt.trim() || Buffer.byteLength(command.prompt) > MAX_FRAME_BYTES
            || typeof command.commandId !== "string" || !command.commandId.trim()) {
          throw fail("invalid_input", "Native creation requires a nonempty prompt and command ID.")
        }
        if (!projectScope) await root()
        if (creationAttempts.has(command.commandId)) throw fail("ambiguous_creation", "This creation was already attempted. Inspect Codex; do not replay automatically.")
        if (await nativeCreation.ready(signal) !== true) throw fail("native_create_unavailable", "A verified native creation coordinator is not ready.")
        signal?.throwIfAborted()
        if (closed) throw fail("native_adapter_closed", "The native adapter is closed.")
        // Readiness can yield: recheck immediately before dispatch so concurrent
        // invocations with the same command cannot create two native children.
        if (creationAttempts.has(command.commandId)) throw fail("ambiguous_creation", "This creation was already attempted. Inspect Codex; do not replay automatically.")
        creationAttempts.add(command.commandId)
        let creatorReturned = false
        try {
          const result = await nativeCreation.create(command, signal)
          creatorReturned = true
          if (result?.hostId !== "local" || typeof result.threadId !== "string" || !UUID.test(result.threadId)
              || result.clientThreadId != null || authorized.has(result.threadId)) {
            throw new Error("Native creation did not return a new local thread receipt.")
          }
          const receipt = { sessionId: result.threadId, workspaceId }
          const entry = { sessionId: result.threadId, directory, confirmed: true, verificationPending: true,
            initialMessageId: stableMessageId(command.commandId), initialPrompt: command.prompt,
            ...(projectScope ? { projectId: projectScope.projectId } : {}) }
          authorized.set(receipt.sessionId, entry)
          // Preserve accepted ownership BEFORE any observation, including aborted
          // or unavailable snapshots. The private prompt is removed on verification.
          await nativeCreation.saveEnrollment?.({ ...entry })
          try {
            const { state, canonicalDirectory } = await snapshot(receipt, signal)
            await verifyPending(receipt, state, canonicalDirectory)
          } catch { /* Accepted receipt is durable; observe/read retry proof, never creation. */ }
          return receipt
        } catch (error) {
          if (!creatorReturned && error instanceof NativeAppToolsError && error.dispatched === false) {
            throw fail("native_rejected", "Native creation was rejected before dispatch; no thread was created.")
          }
          // Without a strict accepted receipt, dispatch lifetime remains unknown.
          throw fail("ambiguous_creation", "Native creation could not be fully confirmed. A Codex thread may exist; inspect it and do not replay automatically.")
        }
      }
      // Router has no GUI creation method. Bundled MCP create_thread additionally
      // needs real executor caller metadata + authorized inherited pipe. Never fake it.
      const sessionId = bindings.get(command.commandId)
      if (!sessionId) throw fail("native_create_unavailable", "This Codex build exposes no verified GUI creation method on its follower socket. Create a dedicated thread in Codex and explicitly bind its UUID and command ID in enrollment configuration.")
      if (command.workspaceId != null && command.workspaceId !== workspaceId) throw fail("workspace_unavailable", "The selected workspace is not this native adapter's workspace.")
      if (command.model != null) throw fail("model_override_unavailable", "Select the enrolled thread's model in Codex; this bridge preserves native defaults.")
      const receipt = { sessionId, workspaceId }
      await snapshot(receipt, signal)
      return receipt
    },
    async enroll({ sessionId, directory: enrollmentDirectory, confirmed, initialMessageId, initialTurnId, verificationPending, initialPrompt }, signal) {
      if (confirmed !== true || typeof sessionId !== "string" || !UUID.test(sessionId) || typeof enrollmentDirectory !== "string" || !isAbsolute(enrollmentDirectory)) throw fail("enrollment_confirmation_required", "Enrollment requires explicit confirmation and the native thread's directory.")
      if (await resolveDirectory(enrollmentDirectory) !== await root()) throw fail("directory_mismatch", "Enrollment must match the configured local directory.")
      const entry = { sessionId, directory: enrollmentDirectory, confirmed: true,
        ...(initialMessageId != null ? { initialMessageId } : {}), ...(initialTurnId != null ? { initialTurnId } : {}),
        ...(verificationPending != null ? { verificationPending } : {}), ...(initialPrompt != null ? { initialPrompt } : {}) }
      validateInitialTurn(entry)
      const previous = authorized.get(sessionId)
      if (previous?.verificationPending && !entry.verificationPending) throw pendingError()
      authorized.set(sessionId, entry)
      const receipt = { sessionId, workspaceId }
      try { await snapshot(receipt, signal); return receipt }
      catch (error) { if (previous) authorized.set(sessionId, previous); else authorized.delete(sessionId); throw error }
    },
    async send(receipt, input, signal) {
      const turnStart = nativeTurnStart(receipt.sessionId, input)
      const { state, ownerId, canonicalDirectory } = await snapshot(receipt, signal)
      await verifyPending(receipt, state, canonicalDirectory)
      const progress = observation(state, now)
      if (progress.status === "running" || progress.status === "waiting" || state.unconfirmedTurnSubmissions?.length) throw fail("native_thread_busy", "The enrolled Codex thread is busy or waiting for its user. Resolve it in Codex first.")
      if (turnsFor(state).some((turn) => turn.params?.clientUserMessageId === input.messageId)) {
        // No durable dedup proof: explicitly reject even visible duplicate IDs.
        throw fail("native_message_already_visible", "This message ID is already visible in Codex; it will not be submitted again.")
      }
      let result
      try { result = await ipc.request("thread-follower-start-turn", { conversationId: receipt.sessionId, turnStart }, { signal, targetClientId: ownerId }) }
      catch (error) { throw mutationError(error, "send") }
      if (typeof result.result?.result?.turn?.id !== "string") throw fail("ambiguous_send", "Native turn acceptance was not confirmed. Inspect Codex; do not replay automatically.")
      return { messageId: input.messageId, alreadyPresent: false }
    },
    async read(receipt, input, signal) {
      if (!["start", "end"].includes(input.from) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > READ_LIMIT) throw fail("invalid_input", "Transcript pages require a direction and a limit between 1 and 100.")
      const { state, canonicalDirectory } = await snapshot(receipt, signal)
      await verifyPending(receipt, state, canonicalDirectory)
      const progress = observation(state, now), messages = messagesFor(state)
      const scope = createHash("sha256").update(`${workspaceId}\n${receipt.sessionId}`).digest("hex").slice(0, 16)
      const forward = input.from === "start"
      let index = forward ? 0 : messages.length - 1
      if (input.cursor != null) {
        try {
          if (typeof input.cursor !== "string" || input.cursor.length > 512) throw new Error()
          const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString())
          const position = messages.findIndex((message) => message.id === cursor.messageId)
          if (cursor.scope !== scope || cursor.from !== input.from || position < 0) throw new Error()
          index = position + (forward ? 1 : -1)
        } catch { throw fail("invalid_cursor", "This cursor does not belong to the enrolled native context (or was removed by compaction).") }
      }
      const selected = []
      // Stable message-ID cursors page forward from start, backward from end.
      let bytes = 0, cursorMessage
      while (index >= 0 && index < messages.length && selected.length < input.limit) {
        const message = messages[index], size = Buffer.byteLength(JSON.stringify(message))
        if (selected.length && bytes + size > 192 * 1024) break
        selected.push(message); bytes += size; cursorMessage = message.id
        index += forward ? 1 : -1
      }
      if (!forward) selected.reverse()
      const more = index >= 0 && index < messages.length
      return { title: typeof state.title === "string" ? state.title.slice(0, 1000) : null, status: progress.status, waitingFor: progress.waitingFor,
        lastError: progress.error, messageCount: messages.length, from: input.from, messages: selected,
        nextCursor: more && cursorMessage ? Buffer.from(JSON.stringify({ scope, from: input.from, messageId: cursorMessage })).toString("base64url") : null,
        historyScope: "context" }
    },
    async stop(receipt, input, signal) {
      await checkReceipt(receipt)
      if (!input.messageId) return { stopped: false, reason: null }
      const { state, ownerId, canonicalDirectory } = await snapshot(receipt, signal), latest = turnsFor(state).at(-1)
      await verifyPending(receipt, state, canonicalDirectory)
      const entry = authorized.get(receipt.sessionId)
      const isInitialAlias = input.messageId === entry.initialMessageId
      const matches = isInitialAlias ? entry.initialTurnId != null && latest?.turnId === entry.initialTurnId
        : latest?.params?.clientUserMessageId === input.messageId
      if (!matches) return { stopped: false, reason: "different_turn" }
      if (latest?.status !== "inProgress" || typeof latest.turnId !== "string") return { stopped: false, reason: null }
      let result
      try {
        // rx compares expectedTurnId to the current native active turn atomically;
        // the modern version must never fall back to unguarded interrupt.
        result = await ipc.request("thread-follower-interrupt-turn", { conversationId: receipt.sessionId, mode: "user-stop", expectedTurnId: latest.turnId }, { signal, targetClientId: ownerId })
      } catch (error) { throw mutationError(error, "stop") }
      if (result.result?.ok !== true || !(result.result.interruptedTurnId === null || typeof result.result.interruptedTurnId === "string")) throw fail("ambiguous_stop", "Codex did not confirm the guarded stop.")
      return { stopped: result.result.interruptedTurnId === latest.turnId, reason: result.result.interruptedTurnId == null ? "different_turn" : null }
    },
    async observe(receipt, signal) {
      // Authority failures stay outside the scoped availability handling.
      await checkReceipt(receipt)
      try {
        const { state, canonicalDirectory } = await snapshot(receipt, signal)
        await verifyPending(receipt, state, canonicalDirectory)
        return observation(state, now)
      } catch (error) {
        if (unavailable(error)) return errorProgress("native_unavailable")
        if (error instanceof SessionRunnerError && (error.code === "native_verification_pending"
            || authorized.get(receipt.sessionId).verificationPending && error.code === "directory_mismatch")) {
          return errorProgress("native_verification_pending")
        }
        if (error instanceof SessionRunnerError && error.code === "directory_mismatch") {
          return errorProgress("native_scope_changed")
        }
        throw error // Unknown schema, configuration and authority errors fail closed.
      }
    },
    async diagnose(signal) {
      await ipc.connect(signal)
      let creationReady = false
      if (nativeCreation) {
        try { creationReady = await nativeCreation.ready(signal) === true } catch { /* Readiness is not a creation dispatch. */ }
      }
      const report = { connected: true, nativeCreation: creationReady, requiresCoordinator: true, enrollmentRequired: true, creation: "at_most_once", sendReplay: "at_most_once",
        frameCapBytes: MAX_FRAME_BYTES, methodVersions: METHOD_VERSIONS, source: SOURCES }
      if (sourceThreadId != null) {
        if (!UUID.test(sourceThreadId)) throw fail("invalid_input", "The diagnostic source thread must be a native UUID.")
        // Diagnostic IDs never authorize create/send/read/stop/observe. Only this
        // owner + settings-key probe is permitted without enrollment confirmation.
        const discovery = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: sourceThreadId }, { signal })
        const response = await ipc.request("thread-follower-read-model-settings", { conversationId: sourceThreadId }, { signal, targetClientId: discovery.handledByClientId })
        report.ownerFound = true
        report.settingsKeys = Object.keys(response.result?.settings ?? {})
        report.sourceThreadEnrolled = authorized.has(sourceThreadId)
      }
      return report // Never include transcript, prompts, model values, paths or credentials.
    },
    close() { closed = true; ipc.close(); authorized.clear(); bindings.clear() },
  }
  return adapter
}
