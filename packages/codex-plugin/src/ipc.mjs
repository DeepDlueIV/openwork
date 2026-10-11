import net from "node:net"
import { lstat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"

export const MAX_FRAME_BYTES = 8 * 1024 * 1024
// Extracted from Codex desktop build 155, src-BJv5Mk7n.js (De/ke).
// Local follower requests omit envelope hostId. Do not negotiate guessed versions.
export const METHOD_VERSIONS = Object.freeze({
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-follower-read-model-settings": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-interrupt-turn": 4,
})
export const BROADCAST_VERSIONS = Object.freeze({
  "thread-stream-following-changed": 1,
  "thread-stream-state-changed": 11,
})

export class IpcError extends Error {
  constructor(code, { dispatched = false, rejection = false } = {}) {
    super(`Codex desktop IPC: ${code}`)
    this.name = "IpcError"
    this.code = code
    this.dispatched = dispatched
    this.rejection = rejection
  }
}

export function encodeFrame(message, maxBytes = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  if (!body.length || body.length > maxBytes || maxBytes > MAX_FRAME_BYTES) throw new IpcError("frame_too_large")
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32LE(body.length)
  body.copy(frame, 4)
  return frame
}

/** Incremental decoder; validates the cap before allocating a single bounded body. */
export function createFrameDecoder(onMessage, maxBytes = MAX_FRAME_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) throw new IpcError("invalid_frame_cap")
  let header = Buffer.alloc(4), headerBytes = 0, expected = 0, body = null, received = 0
  return (chunk) => {
    let offset = 0
    while (offset < chunk.length) {
      if (!expected) {
        const count = Math.min(4 - headerBytes, chunk.length - offset)
        chunk.copy(header, headerBytes, offset, offset + count)
        headerBytes += count
        offset += count
        if (headerBytes !== 4) continue
        expected = header.readUInt32LE()
        headerBytes = 0
        if (!expected || expected > maxBytes) throw new IpcError("invalid_frame_length")
        body = Buffer.allocUnsafe(expected)
      }
      const count = Math.min(expected - received, chunk.length - offset)
      chunk.copy(body, received, offset, offset + count)
      received += count
      offset += count
      if (received !== expected) continue
      let message
      try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) }
      catch { throw new IpcError("invalid_frame_json") }
      expected = 0
      received = 0
      body = null
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new IpcError("invalid_envelope")
      onMessage(message)
    }
  }
}

async function validateSocket(socketPath) {
  if (!isAbsolute(socketPath)) throw new IpcError("invalid_socket_path")
  const uid = process.getuid?.()
  if (uid == null) throw new IpcError("unsupported_platform")
  const [parent, socket] = await Promise.all([lstat(dirname(socketPath)), lstat(socketPath)])
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077)
      || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077)) throw new IpcError("unsafe_socket_permissions")
}

/** Connects only to an existing, owner-private socket. Never starts/restarts a router. */
export function createIpcClient({ socketPath, timeoutMs = 5000, clientType = "openwork-native-codex-prototype" }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new IpcError("invalid_timeout")
  let socket, connecting, closed = false, clientId = "initializing-client"
  const pending = new Map(), listeners = new Set()
  const routeRejections = new Set(["no-client-found", "request-version-mismatch", "no-handler-for-request"])

  function fail(code) {
    for (const entry of pending.values()) entry.reject(new IpcError(code, { dispatched: entry.dispatched }))
    pending.clear()
    socket?.destroy()
  }
  function write(message) {
    const frame = encodeFrame(message)
    if (closed || !socket?.writable) throw new IpcError("not_connected")
    socket.write(frame)
  }
  function handle(message) {
    if (message.type === "client-discovery-request") {
      // This bridge is a follower, never a native thread owner or approval responder.
      write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } })
    } else if (message.type === "response") {
      const entry = pending.get(message.requestId)
      if (!entry) return
      if (message.resultType === "error") {
        const rejection = routeRejections.has(message.error)
        entry.reject(new IpcError(rejection ? message.error : "native_handler_error", { dispatched: entry.dispatched, rejection }))
      } else if (message.resultType === "success" && message.method === entry.method
                 && typeof message.handledByClientId === "string") entry.resolve(message)
      else entry.reject(new IpcError("invalid_response", { dispatched: entry.dispatched }))
    } else if (message.type === "broadcast") {
      if (message.targetClientIds && !message.targetClientIds.includes(clientId)) return
      if (BROADCAST_VERSIONS[message.method] !== message.version) return
      for (const listener of listeners) listener(message)
    }
  }
  function rawRequest(method, params, { signal, targetClientId } = {}) {
    const version = METHOD_VERSIONS[method]
    if (version == null || (method === "initialize" && clientId !== "initializing-client")) throw new IpcError("unsupported_method")
    signal?.throwIfAborted()
    // Encode before admission so oversized requests are definitively not dispatched.
    const requestId = randomUUID()
    const envelope = { type: "request", requestId, sourceClientId: clientId, version, method, params, timeoutMs,
      ...(targetClientId ? { targetClientId } : {}) }
    encodeFrame(envelope)
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        pending.delete(requestId)
        fn(value)
      }
      const entry = { method, dispatched: false,
        resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) }
      const abort = () => entry.reject(new IpcError("aborted", { dispatched: entry.dispatched }))
      const timer = setTimeout(() => entry.reject(new IpcError("request_timeout", { dispatched: entry.dispatched })), timeoutMs)
      pending.set(requestId, entry)
      signal?.addEventListener("abort", abort, { once: true })
      try {
        // Mark before write: a write exception after submission is still uncertain.
        if (closed || !socket?.writable) throw new IpcError("not_connected")
        entry.dispatched = true
        write(envelope)
      } catch (error) { entry.reject(new IpcError(error.code ?? "write_failed", { dispatched: entry.dispatched })) }
    })
  }
  async function connect(signal) {
    signal?.throwIfAborted()
    if (closed) throw new IpcError("closed")
    if (!connecting) connecting = (async () => {
      try { await validateSocket(socketPath) } catch (error) { throw new IpcError(error.code ?? "socket_unavailable") }
      if (closed) throw new IpcError("closed")
      const decode = createFrameDecoder(handle)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket?.destroy(); reject(new IpcError("connect_timeout")) }, timeoutMs)
        socket = net.createConnection(socketPath)
        socket.once("connect", () => { clearTimeout(timer); resolve() })
        socket.on("error", () => { clearTimeout(timer); reject(new IpcError("connection_failed")); fail("connection_failed") })
        socket.on("close", () => { clearTimeout(timer); reject(new IpcError("connection_closed")); fail("connection_closed") })
        socket.on("data", (chunk) => { try { decode(chunk) } catch { fail("protocol_error") } })
      })
      const response = await rawRequest("initialize", { clientType })
      if (typeof response.result?.clientId !== "string" || !response.result.clientId) { fail("invalid_initialize"); throw new IpcError("invalid_initialize") }
      clientId = response.result.clientId
    })()
    await connecting
    signal?.throwIfAborted()
  }
  return {
    connect,
    get clientId() { return clientId },
    async request(method, params, options = {}) { await connect(options.signal); return rawRequest(method, params, options) },
    async broadcast(method, params, { signal, targetClientIds } = {}) {
      await connect(signal)
      if (method !== "thread-stream-following-changed") throw new IpcError("unsupported_broadcast")
      signal?.throwIfAborted()
      write({ type: "broadcast", sourceClientId: clientId, method, version: BROADCAST_VERSIONS[method], params,
        ...(targetClientIds ? { targetClientIds } : {}) })
    },
    onBroadcast(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    close() { closed = true; fail("closed"); listeners.clear() },
  }
}
