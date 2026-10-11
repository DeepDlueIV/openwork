import net from "node:net"
import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { validateNativeSocket, recheckNativeSocket } from "./native-socket.mjs"
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "./ipc.mjs"

const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = value => typeof value === "string" && value.trim().length > 0
const allowedTools = new Set(["list_projects", "create_thread"])
const MAX_CLAIMS = 4096

/** Never contains native error text, paths, prompts or caller metadata. */
export class NativeAppToolsError extends Error {
  constructor(code, { dispatched = false, rejection = false } = {}) {
    super(`Codex native app tools: ${code}`)
    this.name = "NativeAppToolsError"
    this.code = code
    this.dispatched = dispatched
    this.rejection = rejection
    this.ambiguous = dispatched && !rejection
  }
}

function reject(code) { throw new NativeAppToolsError(code, { rejection: true }) }
function assertSignal(signal) {
  if (!signal || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean") reject("invocation_signal_required")
  if (signal.aborted) reject("aborted")
}

/** Correlation only: never an authorization grant. No synthesized ID fallback. */
function caller(metadata) {
  if (!record(metadata) || !nonempty(metadata.callId) || metadata.callId.length > 4096) reject("missing_caller_metadata")
  let turn = metadata["x-codex-turn-metadata"]
  if (typeof turn === "string") {
    if (Buffer.byteLength(turn) > MAX_FRAME_BYTES) reject("invalid_caller_metadata")
    try { turn = JSON.parse(turn) } catch { reject("invalid_caller_metadata") }
  }
  if (!record(turn) || !nonempty(turn.thread_id) || !nonempty(turn.turn_id)
      || turn.thread_id.length > 4096 || turn.turn_id.length > 4096) reject("missing_caller_metadata")
  return { callId: metadata.callId, threadId: turn.thread_id, turnId: turn.turn_id }
}

function validateArguments(tool, args, confirmed) {
  if (!record(args)) reject("invalid_arguments")
  if (tool === "list_projects") {
    if (Object.keys(args).length) reject("invalid_arguments")
    return
  }
  if (confirmed !== true) reject("explicit_confirmation_required")
  // Narrower than the native catalog: only existing local projects, no worktrees,
  // cloud tasks, projectless directory selection or policy/model overrides.
  if (Object.keys(args).some(key => !["prompt", "title", "target"].includes(key))
      || !nonempty(args.prompt) || (args.title !== undefined && !nonempty(args.title))
      || !record(args.target) || args.target.type !== "project" || !nonempty(args.target.projectId)
      || Object.keys(args.target).some(key => !["type", "projectId", "environment"].includes(key))
      || !record(args.target.environment) || args.target.environment.type !== "local"
      || Object.keys(args.target.environment).length !== 1) reject("invalid_arguments")
}

/** Parse privately; callers must never log the returned native data. */
export function parseNativeTextResult(response) {
  if (!record(response) || typeof response.success !== "boolean") throw new NativeAppToolsError("invalid_native_result", { dispatched: true })
  // A handler error may follow a partial effect; it is not a pre-dispatch rejection.
  if (!response.success) throw new NativeAppToolsError("native_tool_failed", { dispatched: true })
  if (!Array.isArray(response.contentItems) || response.contentItems.length !== 1
      || !record(response.contentItems[0]) || response.contentItems[0].type !== "inputText"
      || typeof response.contentItems[0].text !== "string"
      || Buffer.byteLength(response.contentItems[0].text) > MAX_FRAME_BYTES) throw new NativeAppToolsError("invalid_native_result", { dispatched: true })
  let result
  try { result = JSON.parse(response.contentItems[0].text) }
  catch { throw new NativeAppToolsError("invalid_native_result", { dispatched: true }) }
  if (!record(result)) throw new NativeAppToolsError("invalid_native_result", { dispatched: true })
  return result
}

/** Build 155 execution-fde3a4937b6a.js Yu/Xu: schemaVersion 2. */
export function normalizeLocalProjects(response) {
  const result = parseNativeTextResult(response)
  if (result.schemaVersion !== 2 || !Array.isArray(result.projects)) throw new NativeAppToolsError("invalid_project_catalog", { dispatched: true })
  const projects = [], ids = new Set()
  for (const project of result.projects) {
    if (!record(project) || !["local", "remote", "chatgpt"].includes(project.projectKind)
        || !nonempty(project.projectId) || !nonempty(project.label) || ids.has(project.projectId)) throw new NativeAppToolsError("invalid_project_catalog", { dispatched: true })
    ids.add(project.projectId)
    if (project.projectKind !== "local") continue
    if (project.hostId !== "local" || project.hostDisplayName !== null || typeof project.isGitRepository !== "boolean"
        || (project.path !== undefined && (!nonempty(project.path) || !isAbsolute(project.path)))) throw new NativeAppToolsError("invalid_project_catalog", { dispatched: true })
    // Local entries may legitimately lack a path; they cannot route an approved folder.
    if (project.path === undefined) continue
    projects.push({ projectId: project.projectId, projectKind: "local", label: project.label,
      path: project.path, hostId: "local", hostDisplayName: null, isGitRepository: project.isGitRepository })
  }
  return projects
}

function validateCatalog(result) {
  if (!record(result) || !Array.isArray(result.tools)) throw new NativeAppToolsError("invalid_tool_catalog", { dispatched: true })
  const seen = new Set()
  for (const tool of result.tools) {
    if (!record(tool) || !nonempty(tool.name) || !nonempty(tool.namespace) || !record(tool.inputSchema)) throw new NativeAppToolsError("invalid_tool_catalog", { dispatched: true })
    const key = JSON.stringify([tool.namespace, tool.name])
    if (seen.has(key)) throw new NativeAppToolsError("invalid_tool_catalog", { dispatched: true })
    seen.add(key)
  }
  return result.tools.filter(tool => tool.namespace === "codex_app" && allowedTools.has(tool.name))
}

/** Connects only to the supplied existing private pipe. Native peer signing and
 * ancestry checks remain untouched. Keep one client for the coordinator lifetime;
 * claims are hashes only, never persisted or evicted to permit replay.
 * Each invokeOnce requires the signal of its CURRENT genuine MCP invocation.
 * The owner must abort that signal when the invocation returns or is cancelled.
 */
export function createNativeAppToolsClient({ pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH, timeoutMs = 10000 } = {}) {
  if (!nonempty(pipePath) || !isAbsolute(pipePath)) reject("missing_native_pipe")
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) reject("invalid_timeout")
  let socket, connecting, closed = false, nextId = 1, generation = 0
  const pending = new Map(), claims = new Set()

  function cancel(entry, transport) {
    if (!entry.dispatched || entry.method !== "tools/call" || !transport?.writable) return
    try { transport.write(encodeFrame({ jsonrpc: "2.0", id: entry.id, method: "tools/cancel" })) } catch {}
  }
  function fail(code, expectedGeneration = generation) {
    if (expectedGeneration !== generation) return
    const transport = socket, connection = connecting
    // Detach before settling callers. Late events and unfinished socket validation
    // belong to the old generation and cannot tear down a recovered transport.
    generation++
    socket = undefined
    connecting = undefined
    for (const entry of [...pending.values()]) {
      if (entry.generation !== expectedGeneration) continue
      cancel(entry, transport)
      entry.reject(new NativeAppToolsError(code, { dispatched: entry.dispatched }))
    }
    connection?.reject?.(new NativeAppToolsError(code))
    transport?.destroy()
  }
  function handle(message, transport, expectedGeneration) {
    if (expectedGeneration !== generation || transport !== socket) return
    const entry = pending.get(message.id)
    if (!entry || entry.generation !== expectedGeneration) return
    if (message.jsonrpc !== "2.0" || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
      fail("invalid_native_response", expectedGeneration)
      return
    }
    if (Object.hasOwn(message, "error")) {
      const rejection = record(message.error) && [-32600, -32601, -32602].includes(message.error.code)
      entry.reject(new NativeAppToolsError(rejection ? "native_request_rejected" : "native_handler_error", { dispatched: entry.dispatched, rejection }))
    } else entry.resolve(message.result)
  }
  async function connect(expectedGeneration) {
    if (closed) throw new NativeAppToolsError("closed")
    if (expectedGeneration !== generation) throw new NativeAppToolsError("native_disconnected")
    if (connecting) return connecting.promise
    if (socket?.readyState === "open") return socket
    const connection = { promise: undefined, reject: undefined }
    connecting = connection
    connection.promise = (async () => {
      let endpoint
      try { endpoint = await validateNativeSocket(pipePath) }
      catch (error) { throw new NativeAppToolsError(error.message === "unsafe_native_pipe" ? "unsafe_native_pipe" : "native_pipe_unavailable", { rejection: true }) }
      if (closed) throw new NativeAppToolsError("closed")
      if (expectedGeneration !== generation) throw new NativeAppToolsError("native_disconnected")
      const transport = net.createConnection(endpoint.path)
      socket = transport
      await new Promise((resolve, rejectConnection) => {
        connection.reject = rejectConnection
        const decode = createFrameDecoder(message => handle(message, transport, expectedGeneration))
        const current = () => expectedGeneration === generation && transport === socket
        transport.on("data", chunk => {
          if (!current()) return
          try { decode(chunk) } catch { fail("invalid_native_frame", expectedGeneration) }
        })
        transport.once("connect", async () => {
          try {
            await recheckNativeSocket(endpoint)
            if (!current()) return rejectConnection(new NativeAppToolsError("native_disconnected"))
            resolve()
          } catch {
            rejectConnection(new NativeAppToolsError("unsafe_native_pipe", { rejection: true }))
            if (current()) fail("unsafe_native_pipe", expectedGeneration)
          }
        })
        transport.on("error", () => {
          rejectConnection(new NativeAppToolsError("native_connection_failed"))
          if (current()) fail("native_connection_failed", expectedGeneration)
        })
        transport.on("close", () => {
          rejectConnection(new NativeAppToolsError("native_disconnected"))
          if (current()) fail("native_disconnected", expectedGeneration)
        })
      })
      return transport
    })()
    try { return await connection.promise }
    finally { if (connecting === connection) connecting = undefined }
  }
  function request(method, params, signal) {
    assertSignal(signal)
    if (closed) return Promise.reject(new NativeAppToolsError("closed"))
    const id = nextId++
    let frame
    try { frame = encodeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) }
    catch { return Promise.reject(new NativeAppToolsError("invalid_request_frame", { rejection: true })) }
    return new Promise((resolve, rejectRequest) => {
      const finish = (fn, value) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        pending.delete(id)
        fn(value)
      }
      const entry = { id, method, generation, dispatched: false, resolve: value => finish(resolve, value), reject: error => finish(rejectRequest, error) }
      const abort = () => fail("aborted", entry.generation)
      const timer = setTimeout(() => fail("native_request_timeout", entry.generation), timeoutMs)
      pending.set(id, entry)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) return abort()
      connect(entry.generation).then(transport => {
        if (!pending.has(id)) return
        if (closed || signal.aborted || entry.generation !== generation || transport !== socket || !transport.writable) return fail("not_connected", entry.generation)
        entry.dispatched = true
        try { transport.write(frame) } catch { fail("native_write_failed", entry.generation) }
      }, error => {
        if (pending.has(id)) entry.reject(new NativeAppToolsError(error instanceof NativeAppToolsError ? error.code : "native_connection_failed"))
      })
    })
  }
  async function listTools(signal) { return validateCatalog(await request("tools/list", undefined, signal)) }
  return {
    listTools,
    async invokeOnce({ tool, args, metadata, signal, confirmed = false }) {
      assertSignal(signal)
      if (!allowedTools.has(tool)) reject("unsupported_native_tool")
      validateArguments(tool, args, confirmed)
      const context = caller(metadata)
      const key = createHash("sha256").update(JSON.stringify(["local", context.threadId, context.turnId, context.callId])).digest("hex")
      if (claims.has(key)) reject("caller_already_used")
      if (claims.size >= MAX_CLAIMS) reject("caller_claim_limit")
      claims.add(key)
      // Catalog reads do not consume the host's native execution claim.
      let tools
      try { tools = await listTools(signal) }
      catch (error) {
        // Catalog I/O is not the requested effect. Never report its dispatch as
        // an ambiguous create; no tools/call has been sent at this point.
        throw new NativeAppToolsError(error instanceof NativeAppToolsError ? error.code : "invalid_tool_catalog",
          { rejection: error instanceof NativeAppToolsError && error.rejection })
      }
      if (!tools.some(value => value.name === tool && value.namespace === "codex_app")) reject("native_tool_unavailable")
      return request("tools/call", { arguments: args, callerSource: "codex", ...context,
        hostId: "local", namespace: "codex_app", tool }, signal)
    },
    close() { closed = true; fail("closed") },
  }
}
