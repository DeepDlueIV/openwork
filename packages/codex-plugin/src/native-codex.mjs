import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { createHash } from "node:crypto"
import { SessionRunnerError } from "../lib/index.mjs"
import { createIpcClient, IpcError, MAX_FRAME_BYTES, METHOD_VERSIONS } from "./ipc.mjs"

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const fail = (code, message) => new SessionRunnerError(code, message)
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
 * enrollments: [{ sessionId, directory, confirmed:true, commandId?:string }].
 * commandId is an explicit one-command binding to a human-created GUI thread, not
 * a claim that this adapter can create new threads. Unbound create fails closed.
 * Only these confirmed records are authorized; journal/receipt IDs alone are not.
 * Config must persist enrollments across restarts; this adapter never writes them.
 */
export function createNativeCodexAdapter({ directory, workspaceId, socketPath = join(homedir(), ".codex", "ipc", "ipc.sock"),
  sourceThreadId, enrollments = [], timeoutMs = 5000, now = Date.now, ipcClient } = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory) || typeof workspaceId !== "string" || !workspaceId) throw fail("invalid_configuration", "An absolute directory and workspace ID are required.")
  const ipc = ipcClient ?? createIpcClient({ socketPath, timeoutMs })
  const authorized = new Map(), bindings = new Map()
  let closed = false, rootPromise
  const resolveDirectory = async (path) => {
    try { return await realpath(path) }
    catch { throw fail("directory_unavailable", "The configured native project directory is not accessible.") }
  }
  const root = () => rootPromise ??= resolveDirectory(directory)
  for (const entry of enrollments) {
    if (entry.confirmed !== true || !UUID.test(entry.sessionId) || typeof entry.directory !== "string" || !isAbsolute(entry.directory)) {
      throw fail("enrollment_confirmation_required", "Each enrollment needs an explicit confirmation, native UUID and absolute directory.")
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
    if (await resolveDirectory(entry.directory) !== await root()) throw fail("directory_mismatch", "The confirmed enrollment belongs to a different directory.")
    return entry
  }
  async function owner(receipt, signal) {
    await checkReceipt(receipt)
    try {
      const result = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: receipt.sessionId }, { signal })
      if (typeof result.handledByClientId !== "string") throw new IpcError("invalid_response")
      return result.handledByClientId
    } catch {
      throw fail("native_owner_unavailable", "No compatible running Codex GUI owner is available for this enrolled thread.")
    }
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
        if (message.method !== "thread-stream-state-changed" || message.version !== 11 || message.sourceClientId !== ownerId
            || params?.hostId !== "local" || params?.conversationId !== receipt.sessionId || change?.type !== "snapshot") return
        if (change.conversationState?.id !== receipt.sessionId) return
        finish(resolve, change.conversationState)
      })
    })
    // Ensure a broadcast failure does not leave an unhandled pending promise.
    incoming.catch(() => {})
    try {
      signal?.throwIfAborted()
      await ipc.broadcast("thread-stream-following-changed", { conversationId: receipt.sessionId, hostId: "local", following: true }, { signal, targetClientIds: [ownerId] })
      const state = await incoming
      if (typeof state.cwd !== "string" || !isAbsolute(state.cwd) || await resolveDirectory(state.cwd) !== await root()
          || state.workspaceKind === "projectless" || state.environments?.some((environment) => environment.environmentId !== "local")) {
        throw fail("directory_mismatch", "Native thread must use exactly the configured local project directory.")
      }
      return { state, ownerId }
    } finally { clearTimeout(timer); remove?.(); signal?.removeEventListener("abort", abort) }
  }
  function mutationError(error, action) {
    if (error instanceof IpcError && (error.rejection || !error.dispatched)) return fail("native_rejected", "Codex rejected the native operation before dispatch.")
    return fail(action === "send" ? "ambiguous_send" : "ambiguous_stop", "Codex did not confirm the native operation. Inspect its GUI thread; do not replay automatically.")
  }
  const adapter = {
    creation: "at_most_once",
    sendReplay: "at_most_once",
    async create(command, signal) {
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
    async enroll({ sessionId, directory: enrollmentDirectory, confirmed }, signal) {
      if (confirmed !== true || !UUID.test(sessionId) || typeof enrollmentDirectory !== "string" || !isAbsolute(enrollmentDirectory)) throw fail("enrollment_confirmation_required", "Enrollment requires explicit confirmation and the native thread's directory.")
      if (await resolveDirectory(enrollmentDirectory) !== await root()) throw fail("directory_mismatch", "Enrollment must match the configured local directory.")
      const previous = authorized.get(sessionId)
      authorized.set(sessionId, { sessionId, directory: enrollmentDirectory, confirmed: true })
      const receipt = { sessionId, workspaceId }
      try { await snapshot(receipt, signal); return receipt }
      catch (error) { if (previous) authorized.set(sessionId, previous); else authorized.delete(sessionId); throw error }
    },
    async send(receipt, input, signal) {
      const turnStart = nativeTurnStart(receipt.sessionId, input)
      const { state, ownerId } = await snapshot(receipt, signal)
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
      const { state } = await snapshot(receipt, signal), progress = observation(state, now), messages = messagesFor(state)
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
      const { state, ownerId } = await snapshot(receipt, signal), latest = turnsFor(state).at(-1)
      if (latest?.params?.clientUserMessageId !== input.messageId) return { stopped: false, reason: "different_turn" }
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
    async observe(receipt, signal) { const { state } = await snapshot(receipt, signal); return observation(state, now) },
    async diagnose(signal) {
      await ipc.connect(signal)
      const report = { connected: true, nativeCreation: false, enrollmentRequired: true, creation: "at_most_once", sendReplay: "at_most_once",
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
