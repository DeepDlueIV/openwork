import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { deviceLogin, DEFAULT_API_BASE_URL } from "./auth.mjs"
import { readConfig, readCredentials, writeConfig, writeCredentials, deleteCredentials, readStateFile, defaultStateDirectory } from "./state.mjs"

export async function login({ apiBaseUrl = DEFAULT_API_BASE_URL, orgId, onAuthorization, signal, stateDirectory = defaultStateDirectory() } = {}) {
  const credential = await deviceLogin({ apiBaseUrl, orgId, onAuthorization, signal })
  const previous = await readCredentials(stateDirectory)
  const config = await readConfig(stateDirectory)
  // Account replacement cannot inherit somebody else's remote-control approval.
  if (!previous || previous.user?.id !== credential.user.id || previous.orgId !== credential.orgId || previous.apiBaseUrl !== credential.apiBaseUrl) await writeConfig({ ...config, remoteSessions: false }, stateDirectory)
  await writeCredentials(credential, stateDirectory)
  return { signedIn: true, user: credential.user, organization: credential.organization, remoteSessions: false }
}

export async function enable({ directory, confirm = false, sourceThreadId, label, stateDirectory = defaultStateDirectory() } = {}) {
  if (confirm !== true) throw new Error("Explicit confirmation is required to allow OpenWork to control Codex in this folder.")
  if (!directory || typeof directory !== "string") throw new Error("Choose one allowed local folder.")
  const canonical = await realpath(directory)
  if (!(await stat(canonical)).isDirectory()) throw new Error("The allowed folder must be a directory.")
  if (!await readCredentials(stateDirectory)) throw new Error("Sign in to OpenWork first.")
  const config = await readConfig(stateDirectory)
  const next = { ...config, installationId: config.installationId || randomUUID(), directory: canonical, remoteSessions: true,
    ...(sourceThreadId ? { sourceThreadId } : {}), ...(label ? { label: String(label).slice(0, 120) } : {}) }
  const adapter = await nativeFactory(next)
  try {
    const diagnostic = await adapter.diagnose(AbortSignal.timeout(10_000))
    if (diagnostic.nativeCreation === false) throw new Error("Remote enrollment is not ready: this Codex build has no verified new-GUI-chat creation path. Sign-in and the read-only doctor work; no runner was registered or enabled.")
  } finally { await adapter.close?.() }
  await writeConfig(next, stateDirectory)
  return { enabled: true, directory: canonical, sourceThreadId: next.sourceThreadId ?? null }
}

export async function disable(stateDirectory = defaultStateDirectory()) {
  const config = await readConfig(stateDirectory)
  await writeConfig({ ...config, remoteSessions: false }, stateDirectory)
  return { enabled: false, message: "Remote enrollment is off. Existing Codex chats are not deleted or interrupted." }
}

export async function logout(stateDirectory = defaultStateDirectory()) {
  await disable(stateDirectory)
  await deleteCredentials(stateDirectory)
  return { signedIn: false, enabled: false }
}

export async function status(stateDirectory = defaultStateDirectory()) {
  const credential = await readCredentials(stateDirectory)
  const config = await readConfig(stateDirectory)
  const runner = await readStateFile("runner-status.json", stateDirectory)
  return { signedIn: Boolean(credential), user: credential?.user ?? null, organization: credential?.organization ?? null,
    enabled: config.remoteSessions === true, directory: config.directory ?? null,
    runner: runner && Date.now() - runner.observedAt < 15000 ? runner : null }
}

export async function nativeFactory(config) {
  const { createNativeCodexAdapter } = await import("./native-codex.mjs")
  return createNativeCodexAdapter({ directory: config.directory, workspaceId: "codex-local", sourceThreadId: config.sourceThreadId, socketPath: config.socketPath })
}
