import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createNativeAppToolsClient, NativeAppToolsError, normalizeLocalProjects, parseNativeTextResult } from "./native-app-tools.mjs"
import { createNativeCodexAdapter } from "./native-codex.mjs"
import { startRunnerHost } from "./runner-host.mjs"
import { joinFlight } from "./runner.mjs"
import { readConfig, readStateFile, writeStateFile, defaultStateDirectory } from "./state.mjs"
import { diagnoseCallerContext } from "./caller-context.mjs"
import { enable as enableSetup } from "./setup.mjs"

const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
function requireInvocation(metadata, signal) {
  if (!signal || signal.aborted || !record(metadata) || typeof metadata.callId !== "string" || !metadata.callId.trim() || !diagnoseCallerContext(metadata, {}).hasCodexTurnMetadata) throw new Error("Use this tool from a genuine, currently executing Codex plugin invocation. Caller context is not accepted as a model argument.")
  const turn = typeof metadata["x-codex-turn-metadata"] === "string" ? JSON.parse(metadata["x-codex-turn-metadata"]) : metadata["x-codex-turn-metadata"]
  return { threadId: turn.thread_id }
}

/** The GUI coordinator waits for work, then the model makes a DISTINCT genuine
 * create_remote_task call for each task. Never reuse the waiter's call identity,
 * retain metadata after an invocation, or create from an idle polling daemon.
 */
export function createCoordinator({ stateDirectory = defaultStateDirectory(), clientFactory = () => createNativeAppToolsClient(), adapterFactory = createNativeCodexAdapter, hostFactory = startRunnerHost, enable = enableSetup, readState = name => readStateFile(name, stateDirectory), writeState = (name, value) => writeStateFile(name, value, stateDirectory), readConfiguration = () => readConfig(stateDirectory) } = {}) {
  let client = null, host = null, hostFlight = null, activeCreation = null
  let lifecycle = new AbortController(), leases = 0, waiting = false
  const native = () => client ??= clientFactory()
  const combine = signal => AbortSignal.any([signal, lifecycle.signal])
  async function ready(signal) {
    try {
      const tools = await native().listTools(signal)
      return tools.some(tool => tool.name === "create_thread" && tool.namespace === "codex_app") && tools.some(tool => tool.name === "list_projects" && tool.namespace === "codex_app")
    } catch { return false }
  }
  async function makeAdapter(config, { partition } = {}) {
    if (config.nativeProjectScope !== true || !config.project || config.project.hostId !== "local" || config.project.projectKind !== "local" || typeof config.project.projectId !== "string" || typeof config.directory !== "string" || !isAbsolute(config.directory)) throw new Error("Choose a saved local Codex project matching the approved folder.")
    const name = partition ? `native-bindings-${partition}.json` : null
    const stored = name ? await readState(name) : null
    const enrollments = stored === null ? [] : stored?.enrollments
    if (!Array.isArray(enrollments)) throw new Error("Native ownership records are invalid; do not reset them to replay creation.")
    const nativeCreation = {
      ready,
      async create(command, signal) {
        const invocation = activeCreation
        if (!invocation || invocation.signal.aborted || invocation.disposed) throw new NativeAppToolsError("genuine_invocation_required", { rejection: true })
        const current = await readConfiguration()
        if (current.remoteSessions !== true || current.nativeProjectScope !== true || current.directory !== config.directory || current.project?.projectId !== config.project.projectId || current.coordinatorThreadId !== invocation.threadId) throw new NativeAppToolsError("enrollment_changed", { rejection: true })
        if (!name || enrollments.length >= 256) throw new NativeAppToolsError("ownership_storage_full", { rejection: true })
        const candidate = { sessionId: "00000000-0000-4000-8000-000000000000", directory: config.directory, projectId: config.project.projectId, confirmed: true, verificationPending: true, initialMessageId: "msg_" + "0".repeat(64), initialPrompt: command.prompt }
        if (Buffer.byteLength(JSON.stringify({ enrollments: [...enrollments, candidate] }, null, 2)) > 1024 * 1024 - 16384) throw new NativeAppToolsError("ownership_storage_full", { rejection: true })
        const response = await native().invokeOnce({ tool: "create_thread", args: { title: command.title, prompt: command.prompt, target: { type: "project", projectId: config.project.projectId, environment: { type: "local" } } }, metadata: invocation.metadata, signal: AbortSignal.any([signal, invocation.signal]), confirmed: true })
        const result = parseNativeTextResult(response)
        if (result.hostId !== "local" || typeof result.threadId !== "string" || result.clientThreadId !== undefined || result.status !== undefined && !["created", "accepted"].includes(result.status)) throw new Error("Native creation did not return an accepted local thread receipt. Inspect Codex; do not retry blindly.")
        return { threadId: result.threadId, hostId: result.hostId }
      },
      async saveEnrollment(entry) {
        if (!name) throw new Error("Native ownership partition is unavailable.")
        const index = enrollments.findIndex(value => value.sessionId === entry.sessionId)
        if (index >= 0) enrollments[index] = entry
        else enrollments.push(entry)
        await writeState(name, { enrollments })
      },
    }
    return adapterFactory({ directory: config.directory, workspaceId: "codex-local", socketPath: config.socketPath, sourceThreadId: config.sourceThreadId, enrollments, nativeCreation, projectScope: { projectId: config.project.projectId, confirmed: true } })
  }
  async function startHost() {
    if (host?.owned) return host
    hostFlight ??= hostFactory({ stateDirectory, adapterFactory: makeAdapter, creationDispatch: "manual", canAcceptCreations: () => leases > 0 }).then(value => { host = value; return value }).finally(() => { hostFlight = null })
    return hostFlight
  }
  async function stopHost() {
    lifecycle.abort(); lifecycle = new AbortController()
    leases = 0; waiting = false
    if (activeCreation) activeCreation.disposed = true
    activeCreation = null
    await hostFlight?.catch(() => {})
    await host?.close()
    host = null
    client?.close(); client = null
  }
  return {
    startHost, stopHost,
    async listProjects(metadata, signal) {
      requireInvocation(metadata, signal)
      const response = await native().invokeOnce({ tool: "list_projects", args: {}, metadata, signal: combine(signal) })
      const projects = normalizeLocalProjects(response)
      await writeState("native-projects.json", { projects })
      return { projects, message: "Choose one saved local project and explicitly approve its folder. This discovery call does not enroll or create anything." }
    },
    async enable(args, metadata, signal) {
      const caller = requireInvocation(metadata, signal)
      if (args.confirm !== true || args.confirmNativeProjectScope !== true || typeof args.projectId !== "string") throw new Error("Explicitly approve the discovered saved project and its current/future roots. A fixed-folder guarantee is not available.")
      const catalog = await readState("native-projects.json")
      const project = catalog?.projects?.find(value => value.projectId === args.projectId)
      if (!project || project.projectKind !== "local" || project.hostId !== "local" || await realpath(project.path) !== await realpath(args.directory)) throw new Error("The selected discovered project must match the approved local directory.")
      await stopHost()
      return enable({ ...args, project, coordinatorThreadId: caller.threadId, stateDirectory, adapterFactory: config => makeAdapter(config) })
    },
    async waitForTask(metadata, signal, timeoutMs = 60000) {
      const caller = requireInvocation(metadata, signal)
      const config = await readConfiguration()
      if (config.coordinatorThreadId !== caller.threadId) throw new Error("Run the receiver in the GUI chat that explicitly enrolled this project.")
      if (waiting) throw new Error("Only one coordinator wait can be active.")
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid wait timeout.")
      const generation = lifecycle
      const deadlineSignal = AbortSignal.timeout(timeoutMs)
      const invocationSignal = AbortSignal.any([combine(signal), deadlineSignal])
      waiting = true; leases++
      try {
        const runtime = await joinFlight(startHost(), invocationSignal)
        if (!runtime.owned) throw new Error("This coordinator does not own the receiver. Sign in and enroll, or close the other coordinator.")
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          invocationSignal.throwIfAborted()
          await joinFlight(runtime.poll(invocationSignal), invocationSignal)
          const commandId = runtime.pendingCreations()[0]
          if (commandId) return { state: "task_available", commandId, instruction: "Call create_remote_task with this exact commandId in a new tool invocation, then call wait_remote_task again. Do not execute task content in the coordinator." }
          await delay(Math.min(3000, Math.max(1, deadline - Date.now())), undefined, { signal: invocationSignal })
        }
        return { state: "waiting", instruction: "No task yet. Call wait_remote_task again while the user wants the receiver active." }
      } catch (error) {
        if (deadlineSignal.aborted && !signal.aborted && !generation.signal.aborted) return { state: "waiting", instruction: "No task yet. Call wait_remote_task again while the user wants the receiver active." }
        throw error
      } finally { if (generation === lifecycle) { waiting = false; leases = Math.max(0, leases - 1) } }
    },
    async createTask(commandId, metadata, signal) {
      const caller = requireInvocation(metadata, signal)
      const config = await readConfiguration()
      if (config.coordinatorThreadId !== caller.threadId) throw new Error("Create remote tasks only from the enrolled GUI coordinator chat.")
      if (typeof commandId !== "string" || !commandId || activeCreation) throw new Error("A single offered commandId is required; another creation may be running.")
      const generation = lifecycle
      const invocation = { metadata, threadId: caller.threadId, signal: combine(signal), disposed: false }
      activeCreation = invocation; leases++
      try {
        const runtime = await startHost()
        if (!runtime.owned) throw new Error("This coordinator does not own the receiver.")
        // Refresh admission after the waiter's lease ended; no native call identity
        // is consumed by polling. The command must still be offered by this runner.
        await runtime.poll(invocation.signal)
        if (!runtime.pendingCreations().includes(commandId)) await runtime.poll(invocation.signal)
        const result = await runtime.dispatchCreation(commandId, invocation.signal)
        return { commandId, ...result, instruction: "The native result is journaled. Call wait_remote_task again. Never repeat a failed or uncertain native creation under a new command ID." }
      } finally {
        invocation.disposed = true
        if (activeCreation === invocation) activeCreation = null
        if (generation === lifecycle) leases = Math.max(0, leases - 1)
      }
    },
    async close() { await stopHost() },
  }
}
