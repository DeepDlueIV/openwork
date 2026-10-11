import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { createRemoteSessionTransport, createSessionRunner, parseJournal, emptyJournal, RemoteSessionHttpError } from "../lib/index.mjs"

const CAPABILITIES = ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"]
const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 32)
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
export function sessionRunnerIdentity(credentials) {
  return hash(JSON.stringify([credentials.apiBaseUrl, credentials.orgId, credentials.userId, credentials.installationId, credentials.directory, credentials.projectId ?? null]))
}

export function joinFlight(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { signal.removeEventListener("abort", abort); fn(value) }
    const abort = () => finish(reject, signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(value => finish(resolve, value), error => finish(reject, error))
    if (signal.aborted) abort()
  })
}

/** Native effects, journal and transport use the existing OpenWork runner, not a new inbox. */
export function createCodexRunner({ account, adapter, journal, fetcher = fetch, now = Date.now, label = `Codex · ${hostname()}`, platform = process.platform, creationDispatch = "automatic", canAcceptCreations = () => true }) {
  let active = null
  let flight = null
  let closed = false
  let status = { state: "waiting", phase: "opt_in", error: null }
  let pendingCreations = []
  let nativeCreationReady = false
  const update = (state, phase, error = null) => { status = { state, phase, error } }
  async function json(credentials, path, method = "GET", body, signal) {
    const url = new URL(credentials.apiBaseUrl)
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("unsafe_api_url")
    const response = await fetcher(`${credentials.apiBaseUrl.replace(/\/$/, "")}${path}`, {
      method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { accept: "application/json", authorization: `Bearer ${credentials.token}`, "x-openwork-org-id": credentials.orgId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw new RemoteSessionHttpError(response.status) }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("invalid_response")
    const chunks = []; let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 512 * 1024) throw new Error("response_too_large")
        chunks.push(chunk.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  async function cycle(signal) {
    if (closed) return
    pendingCreations = []
    const credentials = await account()
    if (!credentials?.enabled) { active = null; update("waiting", "opt_in"); return }
    if (!credentials.token || !credentials.orgId || !credentials.userId || !credentials.installationId || !credentials.directory || credentials.expiresAt <= now()) { active = null; update("waiting", "sign_in"); return }
    signal.throwIfAborted()
    update("connecting", "identity")
    // Verify every replacement member token before registration or native effects.
    const me = await json(credentials, "/v1/me", "GET", undefined, signal)
    if (!record(me) || !record(me.user) || me.user.id !== credentials.userId) { active = null; throw new Error("identity_changed") }
    const identity = sessionRunnerIdentity(credentials)
    if (!active || active.identity !== identity) {
      active = null
      const token = { value: null, expiresAt: 0 }
      const store = await journal(identity)
      const runner = createSessionRunner({ adapter, store: {
        async load() { const value = await store.load(); return value === null || value === undefined ? emptyJournal() : parseJournal(value) },
        save: value => store.save(value),
      }, transport: createRemoteSessionTransport({ baseUrl: credentials.apiBaseUrl, token: () => closed || token.expiresAt <= now() ? null : token.value, fetch: fetcher }), now })
      await runner.inspect()
      active = { identity, token, runner, registeredAt: 0, inventoryAt: 0, capabilityKey: null, apiBaseUrl: credentials.apiBaseUrl, runnerId: `codex_runner_${identity}` }
    }
    const state = active
    // Probe the actual GUI before advertising presence or claiming commands.
    update("connecting", "codex")
    nativeCreationReady = true
    if (adapter.diagnose) {
      const diagnostic = await adapter.diagnose(signal)
      nativeCreationReady = diagnostic?.nativeCreation !== false
      if (!nativeCreationReady && creationDispatch !== "manual") throw new Error("native_creation_unavailable")
    }
    const creationAvailable = nativeCreationReady && canAcceptCreations()
    const capabilities = creationAvailable ? CAPABILITIES : CAPABILITIES.filter(value => value !== "remote_session_v1")
    const capabilityKey = capabilities.join(",")
    if (!state.token.value || state.token.expiresAt <= now() + 120_000 || now() - state.registeredAt >= 30 * 60_000 || state.capabilityKey !== capabilityKey) {
      update("connecting", "registration")
      const result = await json(credentials, "/v1/session-runners/token", "POST", {
        runnerId: state.runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities,
        platform, appVersion: "codex-openwork-local/0.2.0", concurrency: 1,
      }, signal)
      if (!record(result) || typeof result.token !== "string" || result.token.length < 32 || /[\r\n]/.test(result.token) || !Number.isFinite(result.expiresAt) || result.expiresAt <= now()) throw new Error("invalid_registration")
      state.token.value = result.token; state.token.expiresAt = Math.min(result.expiresAt, credentials.expiresAt)
      state.registeredAt = now(); state.inventoryAt = 0; state.capabilityKey = capabilityKey
    }
    const runnerCredentials = { ...credentials, token: state.token.value }
    if (!state.inventoryAt || now() - state.inventoryAt >= 60_000) {
      // Released Den only recognizes OpenCode v1/v2 workspace engines. Advertise the
      // Codex COMPUTER honestly, with no fabricated engine/workspace/model inventory.
      // Existing computerId-only routing explicitly accepts an empty workspace list.
      const published = await json(runnerCredentials, "/v1/session-runners/inventory", "PUT", {
        computer: { label: label.slice(0, 120), platform, appVersion: "codex-openwork-local/0.2.0" }, workspaces: [],
      }, signal)
      if (!record(published) || published.ok !== true) throw new Error("invalid_inventory")
      state.inventoryAt = now()
    }
    update("connected", "recovery")
    await state.runner.reconcile(signal)
    const transport = createRemoteSessionTransport({ baseUrl: credentials.apiBaseUrl, token: () => closed || state.token.expiresAt <= now() ? null : state.token.value, fetch: fetcher })
    const work = await json(runnerCredentials, "/v1/session-runners/work", "GET", undefined, signal)
    if (!record(work) || !Array.isArray(work.items) || work.items.length > 30) throw new Error("invalid_work")
    update("connected", "work")
    for (const item of work.items) {
      signal.throwIfAborted()
      if (!record(item)) throw new Error("invalid_work")
      try {
        if (item.kind === "remote_session_create" && typeof item.commandId === "string") {
          if (!creationAvailable) continue
          if (creationDispatch === "manual") pendingCreations.push(item.commandId)
          else await state.runner.accept(await transport.claimCommand(item.commandId, signal), signal)
        }
        else if (item.kind === "remote_session_request" && typeof item.requestId === "string") await state.runner.execute(await transport.claimRequest(item.requestId, signal), signal)
        else throw new Error("unexpected_work_kind")
      } catch (error) { if (!(error instanceof RemoteSessionHttpError && error.status === 409)) throw error }
    }
    await state.runner.reconcile(signal)
    const entries = state.runner.inspect()
    const data = await entries
    if (data.commands.length >= 200 || data.requests.length >= 200) await state.runner.prune({ retainCommands: 128, retainRequests: 128 })
    update("connected", "work")
  }
  return {
    inspectStatus: () => ({ ...status, nativeCreationReady, awaitingNativeDispatch: pendingCreations.length }),
    pendingCreations: () => [...pendingCreations],
    async dispatchCreation(commandId, signal = AbortSignal.timeout(60_000)) {
      if (creationDispatch !== "manual" || !nativeCreationReady || !canAcceptCreations() || !pendingCreations.includes(commandId) || !active) throw new Error("creation_not_offered")
      const state = active
      const credentials = await account()
      const identity = credentials && sessionRunnerIdentity(credentials)
      if (!credentials?.enabled || credentials.expiresAt <= now() || identity !== state.identity || state.token.expiresAt <= now()) throw new Error("identity_changed")
      // Revalidate member authority before this native effect, even between polling cycles.
      const me = await json(credentials, "/v1/me", "GET", undefined, signal)
      if (!record(me) || !record(me.user) || me.user.id !== credentials.userId) throw new Error("identity_changed")
      const transport = createRemoteSessionTransport({ baseUrl: state.apiBaseUrl, token: () => closed || state.token.expiresAt <= now() ? null : state.token.value, fetch: fetcher })
      const command = await transport.claimCommand(commandId, signal)
      const completion = await state.runner.accept(command, signal)
      pendingCreations = pendingCreations.filter(id => id !== commandId)
      return completion
    },
    async poll(signal = AbortSignal.timeout(60_000)) {
      if (flight) return joinFlight(flight, signal)
      flight = cycle(signal).catch(error => {
        // Never persist/log provider errors, tokens or prompts in health output.
        update("retrying", status.phase, error instanceof RemoteSessionHttpError ? `http_${error.status}` : error.message === "native_creation_unavailable" ? "native_creation_unavailable" : "runner_unavailable")
        throw error
      }).finally(() => { flight = null })
      return joinFlight(flight, signal)
    },
    async run(signal) {
      while (!closed && !signal.aborted) {
        try { await this.poll(signal) } catch { /* Health is available through inspectStatus. */ }
        if (signal.aborted || closed) break
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
          const timer = setTimeout(finish, status.state === "retrying" ? 10_000 : 3000)
          signal.addEventListener("abort", finish, { once: true })
        })
      }
    },
    async close() { closed = true; await flight?.catch(() => {}); await adapter.close?.(); update("closed", "shutdown") },
  }
}
