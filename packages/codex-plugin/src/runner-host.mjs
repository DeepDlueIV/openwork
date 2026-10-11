import { mkdir, open, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createCodexRunner, sessionRunnerIdentity } from "./runner.mjs"
import { readConfig, readCredentials, readStateFile, writeStateFile, defaultStateDirectory } from "./state.mjs"

/** Only one MCP instance may own a runner; other Codex chats remain tool clients. */
export async function acquireRunnerLock(directory = defaultStateDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, "runner.lock")
  async function claim() {
    const handle = await open(path, "wx", 0o600)
    try { await handle.writeFile(String(process.pid)); await handle.sync() } finally { await handle.close() }
    let released = false
    return async () => {
      if (released) return
      released = true
      const owner = await readFile(path, "utf8").catch(() => null)
      if (owner === String(process.pid)) await rm(path, { force: true })
    }
  }
  try { return await claim() } catch (error) { if (error.code !== "EEXIST") throw error }
  const owner = await readFile(path, "utf8").catch(() => null)
  if (!owner || !/^\d+$/.test(owner)) return null
  try { process.kill(Number(owner), 0); return null } catch (error) { if (error.code !== "ESRCH") return null }
  // Do not race a concurrent new owner by automatically deleting/replacing a lock.
  throw new Error("The previous local runner exited without releasing its lock. Close other runner instances, then remove runner.lock in the private state directory and restart.")
}

export async function startRunnerHost({ adapterFactory, stateDirectory = defaultStateDirectory(), onStatus = () => {}, creationDispatch = "automatic", canAcceptCreations = () => true, runnerFactory = createCodexRunner } = {}) {
  const config = await readConfig(stateDirectory)
  const credentials = await readCredentials(stateDirectory)
  if (config.remoteSessions !== true || !credentials) return { owned: false, close: async () => {}, status: () => ({ state: "waiting", phase: !credentials ? "sign_in" : "opt_in" }) }
  // Validate owner-only state before opening the lock or claiming work.
  await writeStateFile("runner-status.json", { state: "starting", observedAt: Date.now() }, stateDirectory)
  const release = await acquireRunnerLock(stateDirectory)
  if (!release) return { owned: false, close: async () => {}, status: () => ({ state: "connected_elsewhere", phase: "ownership" }) }
  let adapter
  const partition = sessionRunnerIdentity({ ...credentials, userId: credentials.user?.id, directory: config.directory, installationId: config.installationId, projectId: config.project?.projectId })
  try { adapter = await adapterFactory(config, { stateDirectory, partition }) } catch (error) { await release(); throw error }
  const controller = new AbortController()
  const runner = runnerFactory({ adapter, label: config.label, creationDispatch, canAcceptCreations,
    account: async () => {
      const current = await readConfig(stateDirectory)
      const login = await readCredentials(stateDirectory)
      if (!login || current.remoteSessions !== true) { controller.abort(new Error("remote_control_disabled")); return null }
      const account = { ...login, userId: login.user?.id, enabled: current.remoteSessions === true, directory: current.directory, installationId: current.installationId, projectId: current.project?.projectId, expiresAt: login.expiresAt ? Date.parse(login.expiresAt) : 0 }
      if (sessionRunnerIdentity(account) !== partition || current.coordinatorThreadId !== config.coordinatorThreadId) {
        controller.abort(new Error("account_partition_changed"))
        return null
      }
      return account
    },
    journal: async identity => ({
      load: () => readStateFile(`journal-${identity}.json`, stateDirectory),
      save: value => writeStateFile(`journal-${identity}.json`, value, stateDirectory),
    }),
  })
  const watcher = setInterval(() => {
    const status = { ...runner.inspectStatus(), observedAt: Date.now() }
    onStatus(status)
    void writeStateFile("runner-status.json", status, stateDirectory).catch(() => {})
  }, 1000)
  watcher.unref()
  const controls = new Set()
  const running = runner.run(controller.signal).finally(async () => {
    clearInterval(watcher)
    try { await Promise.allSettled(controls); await runner.close() } finally { await release() }
  })
  let stopping = null
  return { get owned() { return !controller.signal.aborted }, status: runner.inspectStatus,
    poll: signal => runner.poll(AbortSignal.any([controller.signal, signal])), pendingCreations: runner.pendingCreations,
    dispatchCreation(commandId, signal) {
      const task = runner.dispatchCreation(commandId, AbortSignal.any([controller.signal, signal])).finally(() => controls.delete(task))
      controls.add(task)
      return task
    },
    close() {
      stopping ??= (async () => { controller.abort(); await running.catch(() => {}) })()
      return stopping
    },
  }
}
