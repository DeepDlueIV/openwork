import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import {
  latestUserMessageId,
  parseRemoteRead,
  remoteActionError,
  remoteFollowUpMessageId,
  remotePendingRequestId,
  type RemoteReadOutcome,
} from "@/lib/remote-session-thread"
import { useRemoteThreadStore, type RemoteThreadAction, type RemoteThreadEntry } from "./remote-thread-store"

const REQUEST_POLL_MS = 2_000
const REQUEST_WAIT_MS = 40_000

type Failure = { code: string; message: string; retryable: boolean }

function context() {
  const settings = readDenSettings()
  const token = settings.authToken?.trim()
  const organizationId = settings.activeOrgId?.trim()
  if (!token || !organizationId) return null
  return { client: createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token }), organizationId }
}

function failure(error: unknown): Failure {
  if (error instanceof DenApiError) {
    if (error.code === "feature_disabled") useRemoteThreadStore.getState().setEnabled(false)
    return { code: error.code, message: error.message, retryable: error.status >= 500 }
  }
  return { code: "request_failed", message: "Couldn't reach OpenWork. Check your connection and try again.", retryable: true }
}

/** Where the task's session lives, once its computer has started it. */
export function remoteThreadLocation(entry: RemoteThreadEntry): { sessionId: string; workspaceId?: string } | null {
  const sessionId = entry.status?.sessionId ?? entry.start.sessionId
  if (!sessionId) return null
  const workspaceId = entry.start.target === "desktop" ? entry.status?.workspaceId ?? entry.start.workspaceId : null
  return { sessionId, ...(workspaceId ? { workspaceId } : {}) }
}

async function call(action: "read" | "send" | "stop", input: Record<string, unknown>): Promise<unknown> {
  const requireEnabled = () => {
    if (!useRemoteThreadStore.getState().enabled) {
      throw new DenApiError(404, "feature_disabled", "Tasks on other computers are turned off.")
    }
  }
  requireEnabled()
  const den = context()
  if (!den) throw new DenApiError(401, "unauthorized", "Sign in to OpenWork to follow this task.")
  const controller = new AbortController()
  const unsubscribe = useRemoteThreadStore.subscribe((state) => {
    if (!state.enabled) controller.abort()
  })
  try {
    let payload = await den.client.remoteSessionAction(den.organizationId, action, input, controller.signal)
    const deadline = Date.now() + REQUEST_WAIT_MS
    for (let requestId = remotePendingRequestId(payload); requestId && Date.now() < deadline; requestId = remotePendingRequestId(payload)) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_POLL_MS))
      requireEnabled()
      payload = await den.client.remoteSessionAction(den.organizationId, "read", { requestId }, controller.signal)
    }
    return payload
  } finally {
    unsubscribe()
  }
}

export async function readRemoteThread(entry: RemoteThreadEntry, input: { limit: number; cursor?: string | null; requestId?: string | null }): Promise<RemoteReadOutcome> {
  const location = remoteThreadLocation(entry)
  if (!location) return { kind: "error", code: "not_started", message: "The conversation appears once the computer starts the task.", retryable: true }
  try {
    return parseRemoteRead(await call("read", input.requestId ? { requestId: input.requestId } : {
      ...location,
      limit: input.limit,
      ...(input.cursor ? { from: "end", cursor: input.cursor } : {}),
    }))
  } catch (error) {
    return { kind: "error", ...failure(error) }
  }
}

function actionResult(payload: unknown, action: "send" | "stop"): RemoteThreadAction {
  const requestId = remotePendingRequestId(payload)
  if (requestId) return {
    phase: "unconfirmed", requestId,
    message: action === "send" ? "The computer hasn't confirmed this follow-up. Check again before sending it again." : "The computer hasn't confirmed Stop. The task may still be running.",
  }
  const error = remoteActionError(payload)
  if (error) return { phase: "failed", requestId: null, message: error.message }
  return { phase: "accepted", requestId: null, message: null }
}

const requesting: RemoteThreadAction = { phase: "requesting", requestId: null, message: null }

/** The submitted message lives on the thread, independently of the next editable draft. */
export async function sendRemoteFollowUp(entry: RemoteThreadEntry, prompt: string): Promise<void> {
  const store = useRemoteThreadStore.getState()
  const current = store.threads[entry.start.key]
  if (!current || current.followUps.some((item) => item.phase === "requesting")) return
  const id = remoteFollowUpMessageId()
  store.update(entry.start.key, (thread) => ({ ...thread, followUps: [...thread.followUps, { ...requesting, id, text: prompt }] }))
  const location = remoteThreadLocation(entry)
  let result: RemoteThreadAction
  try {
    result = location ? actionResult(await call("send", { ...location, prompt, messageId: id }), "send")
      : { phase: "failed", requestId: null, message: "Wait for the computer to start the task, then send your follow-up." }
  } catch (error) {
    // A lost response is not proof that a send failed. Never replay it automatically.
    result = { phase: "unconfirmed", requestId: null, message: `${failure(error).message} Check the conversation before sending this follow-up again.` }
  }
  store.update(entry.start.key, (thread) => ({ ...thread, followUps: thread.followUps.map((item) => item.id === id ? { ...item, ...result } : item) }))
  if (result.phase === "accepted") store.followedUp(entry.start.key)
}

/** Stops only the current turn. Its receipt is shared by the row and panel. */
export async function stopRemoteThread(entry: RemoteThreadEntry, latestUserId?: string | null): Promise<void> {
  const store = useRemoteThreadStore.getState()
  const current = store.threads[entry.start.key]
  if (!current || (current.stop && current.stop.phase !== "failed")) return
  store.update(entry.start.key, (thread) => ({ ...thread, stop: requesting }))
  let result: RemoteThreadAction
  try {
    const location = remoteThreadLocation(entry)
    if (!location) throw new Error("not_started")
    let messageId = latestUserId ?? null
    if (!messageId) {
      const tail = await readRemoteThread(entry, { limit: 4 })
      messageId = tail.kind === "page" ? latestUserMessageId(tail.page.messages) : null
    }
    // Never issue an unguarded desktop Stop after an unconfirmed transcript read.
    if (!messageId && entry.start.target === "desktop") {
      result = { phase: "failed", requestId: null, message: "Couldn't confirm the current turn. Open the conversation and try Stop again." }
    } else result = actionResult(await call("stop", { ...location, ...(messageId ? { messageId } : {}) }), "stop")
  } catch (error) {
    result = { phase: "unconfirmed", requestId: null, message: `${failure(error).message} Stop isn't confirmed; the task may still be running.` }
  }
  store.update(entry.start.key, (thread) => ({ ...thread, stop: result }))
}

/** Check an existing receipt, never repeat the send/stop mutation. */
export async function checkRemoteThreadAction(entry: RemoteThreadEntry, followUpId?: string): Promise<void> {
  const store = useRemoteThreadStore.getState()
  const current = store.threads[entry.start.key]
  const action = followUpId ? current?.followUps.find((item) => item.id === followUpId) : current?.stop
  if (!action?.requestId || action.phase === "requesting") return
  const update = (result: RemoteThreadAction) => store.update(entry.start.key, (thread) => followUpId
    ? { ...thread, followUps: thread.followUps.map((item) => item.id === followUpId ? { ...item, ...result } : item) }
    : { ...thread, stop: result })
  update({ ...action, phase: "requesting" })
  try {
    const result = actionResult(await call("read", { requestId: action.requestId }), followUpId ? "send" : "stop")
    update(result)
    if (followUpId && result.phase === "accepted") store.followedUp(entry.start.key)
  } catch (error) {
    update({ ...action, phase: "unconfirmed", message: failure(error).message })
  }
}
