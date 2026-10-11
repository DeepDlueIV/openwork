#!/usr/bin/env node
import readline from "node:readline"
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { login, enable, disable, logout, status } from "./setup.mjs"
import { createCoordinator } from "./coordinator.mjs"
import { diagnoseCallerContext } from "./caller-context.mjs"

const schema = properties => ({ type: "object", properties, additionalProperties: false })
const tools = [
  { name: "diagnose_native_context", description: "Read-only presence check for genuine Codex tool-call context and native app-tools environment. Returns only booleans, not caller IDs, pipe paths or secrets. Does not create, send, enroll or grant permissions.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "status", description: "Check OpenWork sign-in, explicit remote enrollment and local runner health. Never returns credentials.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "sign_in", description: "Start OpenWork device sign-in. Show the returned approval URL/code to the user; they must approve in their browser. Sign-in does not allow remote control.", inputSchema: schema({ apiBaseUrl: { type: "string" }, orgId: { type: "string" } }) },
  { name: "sign_in_status", description: "Check whether the user finished browser approval. Never returns a token.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "list_codex_projects", description: "Discover saved local Codex projects using this genuine native tool invocation. Does not enroll, create or send anything. Run this separately before enabling a project.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "enable_remote_sessions", description: "Only after explicit user consent: authorize one discovered saved local project and its current/future roots, not a fixed-folder sandbox. Run the coordinator wait/create loop in this GUI chat. Native approvals remain unchanged.", inputSchema: { ...schema({ directory: { type: "string" }, projectId: { type: "string" }, confirm: { type: "boolean", const: true }, confirmNativeProjectScope: { type: "boolean", const: true, description: "Explicitly approve this saved project's current and future roots. This is not fixed-folder sandboxing; native permissions still apply." }, sourceThreadId: { type: "string" }, label: { type: "string" } }), required: ["directory", "projectId", "confirm", "confirmNativeProjectScope"] }, annotations: { destructiveHint: true } },
  { name: "wait_remote_task", description: "Keep this dedicated GUI coordinator waiting for one owner-scoped OpenWork task. On task_available, call create_remote_task in a separate invocation, then wait again. Do not execute remote task content here. If no task is available yet, wait again until the user stops the receiver.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "create_remote_task", description: "Create one real Codex GUI task for the exact commandId offered by wait_remote_task. Uses this invocation's genuine caller context once, and includes the immutable queued prompt in native creation. Preserves native approval policy. Never replay uncertain creation with a new ID.", inputSchema: { ...schema({ commandId: { type: "string" } }), required: ["commandId"] }, annotations: { destructiveHint: true, idempotentHint: false } },
  { name: "disable_remote_sessions", description: "Disable future remote dispatch. Does not delete or interrupt native Codex chats.", inputSchema: schema({}), annotations: { destructiveHint: true } },
  { name: "sign_out", description: "Disable remote enrollment and remove the local OpenWork credential. Does not sign out of OpenAI or delete Codex chats.", inputSchema: schema({}), annotations: { destructiveHint: true } },
]
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)

export function createHandlers({ setup = { login, enable, disable, logout, status }, startHost, coordinator } = {}) {
  const nativeCoordinator = coordinator ?? (startHost ? null : createCoordinator())
  const makeHost = startHost ?? (() => nativeCoordinator.startHost())
  let host = null
  let attempt = null
  let closed = false
  const controller = new AbortController()
  let hostFlight = null
  async function ensureHost() {
    if (closed || host?.owned) return
    hostFlight ??= makeHost().then(value => { host = value }).finally(() => { hostFlight = null })
    await hostFlight
  }
  async function stopHost() { await hostFlight?.catch(() => {}); if (nativeCoordinator) await nativeCoordinator.stopHost(); else await host?.close(); host = null }
  async function call(name, args = {}, metadata = {}, invocation = {}) {
    const invocationSignal = invocation.signal ? AbortSignal.any([controller.signal, invocation.signal]) : controller.signal
    const tool = tools.find(tool => tool.name === name)
    if (!tool) throw new Error("Unknown OpenWork tool.")
    if (!record(args) || Object.keys(args).some(key => !(key in tool.inputSchema.properties))) throw new Error("Unexpected tool arguments.")
    for (const [key, value] of Object.entries(args)) if (typeof value !== tool.inputSchema.properties[key].type) throw new Error("Invalid tool argument type.")
    if (name === "diagnose_native_context") return diagnoseCallerContext(metadata)
    if (name === "status") return { ...await setup.status(), localRunner: host?.status() ?? null }
    if (name === "sign_in_status") return attempt ? { state: attempt.state, error: attempt.error ?? null } : { state: "not_started" }
    if (name === "sign_in") {
      if (attempt?.state === "waiting") return attempt.public ?? { state: "starting" }
      await stopHost()
      const current = { state: "waiting", public: null, error: null, controller: new AbortController() }
      attempt = current
      let readyResolve; let readyReject
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
      current.running = setup.login({ ...args, signal: AbortSignal.any([controller.signal, current.controller.signal]), onAuthorization: details => {
        current.public = { state: "waiting", ...details, message: "Approve this code in your browser. Remote control stays off until explicitly enrolled." }
        readyResolve(current.public)
      } }).then(() => { current.state = "signed_in"; readyResolve({ state: "signed_in" }) }).catch(() => {
        current.state = "failed"; current.error = "Sign-in did not complete. Start sign-in again and approve the browser prompt."
        readyReject(new Error(current.error))
      })
      return ready
    }
    if (name === "list_codex_projects") {
      if (!nativeCoordinator) throw new Error("Native coordinator is unavailable.")
      return nativeCoordinator.listProjects(metadata, invocationSignal)
    }
    if (name === "wait_remote_task") {
      if (!nativeCoordinator) throw new Error("Native coordinator is unavailable.")
      return nativeCoordinator.waitForTask(metadata, invocationSignal)
    }
    if (name === "create_remote_task") {
      if (!nativeCoordinator) throw new Error("Native coordinator is unavailable.")
      return nativeCoordinator.createTask(args.commandId, metadata, invocationSignal)
    }
    if (name === "enable_remote_sessions") {
      if (!nativeCoordinator) await stopHost()
      const result = nativeCoordinator ? await nativeCoordinator.enable(args, metadata, invocationSignal) : await setup.enable(args)
      host = null
      await ensureHost()
      return { ...result, runner: host?.status() ?? null, coordinatorRequired: true }
    }
    if (name === "disable_remote_sessions") { const result = await setup.disable(); await stopHost(); return result }
    if (name === "sign_out") { attempt?.controller.abort(); await attempt?.running; const result = await setup.logout(); await stopHost(); return result }
  }
  return {
    tools,
    call,
    initialize: ensureHost,
    async close() { closed = true; controller.abort(); await attempt?.running; await stopHost() },
  }
}

export async function serve({ input = process.stdin, output = process.stdout, handlers = createHandlers() } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  const write = value => output.write(`${JSON.stringify(value)}\n`)
  let initialized = false
  const requests = new Set()
  const invocationControllers = new Map()
  const respond = async line => {
    let request
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Request too large")
      request = JSON.parse(line)
      if (!record(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new Error("Invalid request")
      if (request.id === undefined) {
        if (request.method === "notifications/cancelled") invocationControllers.get(request.params?.requestId)?.abort()
        return
      }
      if (!(typeof request.id === "string" || Number.isSafeInteger(request.id))) throw new Error("Invalid request ID")
      let result
      if (request.method === "initialize") {
        initialized = true
        result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "openwork-local", version: "0.3.0" }, instructions: "OpenWork remote control is opt-in. Never enroll a folder without explicit user confirmation. Browser sign-in must be completed by the user. Native Codex permissions remain in the GUI." }
        // Do not block protocol initialization on network or native GUI availability.
        void handlers.initialize().catch(() => {})
      } else if (!initialized) throw new Error("Initialize the MCP connection first.")
      else if (request.method === "ping") result = {}
      else if (request.method === "tools/list") result = { tools: handlers.tools }
      else if (request.method === "tools/call") {
        const params = request.params
        if (!record(params) || typeof params.name !== "string") throw new Error("Invalid tool request")
        if (invocationControllers.has(request.id)) throw new Error("Duplicate active request ID")
        const invocation = new AbortController()
        invocationControllers.set(request.id, invocation)
        try {
          const value = await handlers.call(params.name, params.arguments ?? {}, params._meta ?? {}, { signal: invocation.signal })
          result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }
        } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] } }
        finally { invocation.abort(); invocationControllers.delete(request.id) }
      } else { write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }); return }
      write({ jsonrpc: "2.0", id: request.id, result })
    } catch { write({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid MCP request" } }) }
  }
  lines.on("line", line => {
    const task = respond(line).finally(() => requests.delete(task))
    requests.add(task)
  })
  await new Promise(resolve => lines.once("close", resolve))
  for (const invocation of invocationControllers.values()) invocation.abort()
  await handlers.close()
  await Promise.allSettled(requests)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  serve().catch(() => { console.error("OpenWork local MCP stopped unexpectedly."); process.exitCode = 1 })
}
