import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { RemoteThreadStart } from "../src/lib/remote-session-thread"

let response: (action: string, input: Record<string, unknown>) => Promise<unknown>
const calls: string[] = []
mock.module("@/app/lib/den", () => ({
  readDenSettings: () => ({ authToken: "fixture", activeOrgId: "org_fixture" }),
  createDenClient: () => ({
    remoteSessionAction: (org: string, action: string, input: Record<string, unknown>) => { calls.push(action); return response(action, input) },
    getRemoteSessionStatus: () => new Promise(() => {}),
  }),
  DenApiError: class extends Error {},
}))
mock.module("@/components/markdown/markdown", () => ({ MarkdownBlock: ({ text }: { text: string }) => <p>{text}</p> }))
const { useRemoteThreadStore } = await import("../src/react-app/domains/session/remote-threads/remote-thread-store")
const { RemoteThreadPanel } = await import("../src/react-app/domains/session/remote-threads/remote-thread-panel")
const { sendRemoteFollowUp, stopRemoteThread, checkRemoteThreadAction } = await import("../src/react-app/domains/session/remote-threads/remote-thread-actions")
const { remoteThreadView } = await import("../src/react-app/domains/session/remote-threads/remote-thread-view")

const start: RemoteThreadStart = { key: "cloud:ses_remote", ref: { sessionId: "ses_remote" }, toolCallId: "call_remote", title: "Review notes", prompt: "Review the notes", target: "cloud", sessionId: "ses_remote", workspaceId: null, computerId: null }
const owner = { workspaceId: "ws_owner", sessionId: "ses_owner" }
const tab = { type: "remote-thread", id: "tab_remote", label: "Review notes", threadKey: start.key, owner } as const
const ownedDom = typeof document === "undefined"
let root: Root | null = null
let container: HTMLDivElement
let createRoot: typeof import("react-dom/client")["createRoot"]
let previousAct: unknown
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  createRoot = (await import("react-dom/client")).createRoot
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  calls.length = 0
  useRemoteThreadStore.setState({ enabled: false, threads: {} })
  useRemoteThreadStore.getState().watch(start, { owner, organizationId: "org_fixture", startedAt: Date.now() })
  useRemoteThreadStore.setState({ enabled: true })
  response = async () => ({ messages: [{ id: "msg_original", role: "user", text: "Review the notes" }], nextCursor: null })
  container = document.createElement("div")
  document.body.append(container)
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  useRemoteThreadStore.setState({ enabled: false, threads: {} })
  mock.restore()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
})
const entry = () => {
  const found = useRemoteThreadStore.getState().threads[start.key]
  if (!found) throw new Error("Missing thread")
  return found
}
async function mount() {
  root = createRoot(container)
  await act(async () => root?.render(<RemoteThreadPanel tab={tab} />))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}
async function type(text: string) {
  const input = container.querySelector("textarea")
  if (!input) throw new Error("Missing follow-up")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return input
}

test("a slow follow-up keeps the next editable draft on success and retains the submitted message", async () => {
  let accept: (payload: unknown) => void = () => {}
  response = async (action) => action === "send" ? new Promise((resolve) => { accept = resolve }) : { messages: [] }
  await mount()
  await type("First follow-up")
  await act(async () => { container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) })
  expect(container.querySelector("textarea")?.value).toBe("")
  expect(container.querySelector('[data-remote-follow-up="requesting"]')?.textContent).toContain("First follow-up")
  const input = await type("Next draft stays here")
  await act(async () => accept({ ok: true }))
  expect(input.value).toBe("Next draft stays here")
  expect(container.textContent).toContain("First follow-up")
  expect(entry().followUps[0]?.phase).toBe("accepted")
})

test("failed sends preserve submitted text separately from the next draft", async () => {
  response = async (action) => action === "send" ? { error: "rejected", message: "The computer refused this follow-up." } : { messages: [] }
  await sendRemoteFollowUp(entry(), "Keep the submitted text")
  expect(entry().followUps[0]).toMatchObject({ phase: "failed", text: "Keep the submitted text" })
})

test("Stop rejection remains shared on the thread and never says Stopped", async () => {
  response = async (action) => action === "stop" ? { error: "offline", message: "The computer is offline. Try again when it reconnects." } : { messages: [] }
  await stopRemoteThread(entry(), "msg_original")
  expect(entry().stop).toMatchObject({ phase: "failed", message: "The computer is offline. Try again when it reconnects." })
  expect(remoteThreadView(start, entry(), Date.now()).stopped).toBe(false)
  await mount()
  expect(container.textContent).toContain("The computer is offline")
})

test("an exhausted Stop receipt is unconfirmed; Check again reads the receipt without repeating Stop", async () => {
  let now = 1_000
  spyOn(Date, "now").mockImplementation(() => now += 50_000)
  response = async () => ({ state: "pending", requestId: "request_stop" })
  await stopRemoteThread(entry(), "msg_original")
  expect(entry().stop?.phase).toBe("unconfirmed")
  expect(remoteThreadView(start, entry(), Date.now()).status).toContain("Stop not confirmed")
  expect(calls).toEqual(["stop"])
  response = async () => ({ ok: true })
  await checkRemoteThreadAction(entry())
  expect(calls).toEqual(["stop", "read"])
  expect(entry().stop?.phase).toBe("accepted")
  expect(remoteThreadView(start, entry(), Date.now()).status).toContain("Stop requested")
  expect(remoteThreadView(start, entry(), Date.now()).stopped).toBe(false)
})

test("an unconfirmed transcript ends the skeleton and offers checking the same receipt", async () => {
  let now = 1_000
  spyOn(Date, "now").mockImplementation(() => now += 50_000)
  response = async () => ({ state: "pending", requestId: "request_read" })
  await mount()
  expect(container.textContent).toContain("Conversation not confirmed yet")
  expect(container.textContent).toContain("Check again")
})
