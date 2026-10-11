#!/usr/bin/env node
import readline from "node:readline"
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { login, enable, disable, logout, status, nativeFactory } from "./setup.mjs"
import { startRunnerHost } from "./runner-host.mjs"

const schema = properties => ({ type: "object", properties, additionalProperties: false })
const tools = [
  { name: "status", description: "Check OpenWork sign-in, explicit remote enrollment and local runner health. Never returns credentials.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "sign_in", description: "Start OpenWork device sign-in. Show the returned approval URL/code to the user; they must approve in their browser. Sign-in does not allow remote control.", inputSchema: schema({ apiBaseUrl: { type: "string" }, orgId: { type: "string" } }) },
  { name: "sign_in_status", description: "Check whether the user finished browser approval. Never returns a token.", inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: "enable_remote_sessions", description: "Only after explicit user consent: enroll this computer for OpenWork remote sessions in one allowed folder. Native Codex approvals remain in the GUI.", inputSchema: { ...schema({ directory: { type: "string" }, confirm: { type: "boolean", const: true }, sourceThreadId: { type: "string" }, label: { type: "string" } }), required: ["directory", "confirm"] }, annotations: { destructiveHint: true } },
  { name: "disable_remote_sessions", description: "Disable future remote dispatch. Does not delete or interrupt native Codex chats.", inputSchema: schema({}), annotations: { destructiveHint: true } },
  { name: "sign_out", description: "Disable remote enrollment and remove the local OpenWork credential. Does not sign out of OpenAI or delete Codex chats.", inputSchema: schema({}), annotations: { destructiveHint: true } },
]
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)

export function createHandlers({ setup = { login, enable, disable, logout, status }, startHost = () => startRunnerHost({ adapterFactory: nativeFactory }) } = {}) {
  let host = null
  let attempt = null
  let closed = false
  const controller = new AbortController()
  let hostFlight = null
  async function ensureHost() {
    if (closed || host?.owned) return
    hostFlight ??= startHost().then(value => { host = value }).finally(() => { hostFlight = null })
    await hostFlight
  }
  async function stopHost() { await hostFlight?.catch(() => {}); await host?.close(); host = null }
  async function call(name, args = {}) {
    const tool = tools.find(tool => tool.name === name)
    if (!tool) throw new Error("Unknown OpenWork tool.")
    if (!record(args) || Object.keys(args).some(key => !(key in tool.inputSchema.properties))) throw new Error("Unexpected tool arguments.")
    for (const [key, value] of Object.entries(args)) if (typeof value !== tool.inputSchema.properties[key].type) throw new Error("Invalid tool argument type.")
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
    if (name === "enable_remote_sessions") {
      const result = await setup.enable(args)
      await stopHost()
      await ensureHost()
      return { ...result, runner: host?.status() ?? null }
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
  const respond = async line => {
    let request
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Request too large")
      request = JSON.parse(line)
      if (!record(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new Error("Invalid request")
      if (request.id === undefined) return
      let result
      if (request.method === "initialize") {
        initialized = true
        result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "openwork-local", version: "0.1.0" }, instructions: "OpenWork remote control is opt-in. Never enroll a folder without explicit user confirmation. Browser sign-in must be completed by the user. Native Codex permissions remain in the GUI." }
        // Do not block protocol initialization on network or native GUI availability.
        void handlers.initialize().catch(() => {})
      } else if (!initialized) throw new Error("Initialize the MCP connection first.")
      else if (request.method === "ping") result = {}
      else if (request.method === "tools/list") result = { tools: handlers.tools }
      else if (request.method === "tools/call") {
        const params = request.params
        if (!record(params) || typeof params.name !== "string") throw new Error("Invalid tool request")
        try {
          const value = await handlers.call(params.name, params.arguments ?? {})
          result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }
        } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] } }
      } else { write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }); return }
      write({ jsonrpc: "2.0", id: request.id, result })
    } catch { write({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid MCP request" } }) }
  }
  lines.on("line", line => {
    const task = respond(line).finally(() => requests.delete(task))
    requests.add(task)
  })
  await new Promise(resolve => lines.once("close", resolve))
  await handlers.close()
  await Promise.allSettled(requests)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  serve().catch(() => { console.error("OpenWork local MCP stopped unexpectedly."); process.exitCode = 1 })
}
