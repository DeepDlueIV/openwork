import { setTimeout as delay } from "node:timers/promises"
import { createHash } from "node:crypto"
import { isAllowedApiBaseUrl, normalizeBaseUrl, type DenSession, type Fetch } from "./den.ts"

export const INVENTORY_EVENTS_PATH = "/v1/inference-providers/inventory/events"

export function inventorySessionKey(session: DenSession): string {
  return createHash("sha256").update(JSON.stringify([normalizeBaseUrl(session.apiBaseUrl), session.orgId, session.token])).digest("hex")
}

interface SharedSubscription {
  readonly controller: AbortController
  readonly listeners: Map<symbol, SubscriptionOptions>
  received: boolean
}

// OpenCode creates one plugin instance per Location. Share across all copies of
// this module in a process too; otherwise a fifth Location hits Den's stream cap.
declare global {
  var __openworkInventorySubscriptions: Map<string, SharedSubscription> | undefined
}

/** Ref-counted fanout; one Location may only release its own subscription. */
export function subscribeSharedInventory(options: SubscriptionOptions & { identity: DenSession }): Promise<void> {
  if (options.signal.aborted) return Promise.resolve()
  const shared = globalThis.__openworkInventorySubscriptions ??= new Map<string, SharedSubscription>()
  const key = inventorySessionKey(options.identity)
  let entry = shared.get(key)
  const first = !entry
  if (!entry) {
    entry = { controller: new AbortController(), listeners: new Map(), received: false }
    shared.set(key, entry)
  }
  const current = entry
  const id = Symbol()
  current.listeners.set(id, options)
  const result = new Promise<void>(resolve => {
    const release = () => {
      options.signal.removeEventListener("abort", release)
      current.listeners.delete(id)
      if (!current.listeners.size) {
        if (shared.get(key) === current) shared.delete(key)
        current.controller.abort()
      }
      resolve()
    }
    options.signal.addEventListener("abort", release, { once: true })
  })
  if (first) {
    void subscribeInventory({
      fetch: options.fetch,
      heartbeatMs: options.heartbeatMs,
      retryMs: options.retryMs,
      signal: current.controller.signal,
      session: async () => {
        // Never retain the first Location as owner after it unloads, nor send a
        // changed account's credential to the old account's listeners.
        for (const listener of current.listeners.values()) {
          if (listener.signal.aborted) continue
          const session = await listener.session().catch(() => null)
          if (!listener.signal.aborted && session && inventorySessionKey(session) === key) return session
        }
        return null
      },
      unauthorized: () => {
        for (const listener of current.listeners.values()) {
          if (!listener.signal.aborted) { try { listener.unauthorized?.() } catch {} }
        }
      },
      changed: () => {
        current.received = true
        for (const listener of current.listeners.values()) {
          if (!listener.signal.aborted) { try { listener.changed() } catch {} }
        }
      },
    })
    // Keep a terminal (feature-disabled) subscription until its last consumer
    // leaves. New Locations must not reopen the killed stream for this session.
  } else if (current.received) {
    queueMicrotask(() => { if (!options.signal.aborted) options.changed() })
  }
  return result
}

/** Incremental SSE framing: UTF-8 decoding belongs to the caller. Comments are heartbeats. */
export class SseParser {
  private buffer = ""
  private event = ""
  private data: string[] = []
  private readonly receive: (event: { event: string; data: string }) => void
  constructor(receive: (event: { event: string; data: string }) => void) { this.receive = receive }

  push(text: string) {
    this.buffer += text
    // Bound untrusted/incorrect responses, including streams with no line breaks.
    if (this.buffer.length > 1024 * 1024) throw new Error("SSE frame too large")
    while (true) {
      const match = /[\r\n]/.exec(this.buffer)
      if (!match) return
      const index = match.index
      const ending = this.buffer[index]
      if (ending === "\r" && index === this.buffer.length - 1) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + (ending === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1))
      if (!line) {
        if (this.data.length) this.receive({ event: this.event || "message", data: this.data.join("\n") })
        this.event = ""
        this.data = []
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? "" : line.slice(colon + 1)
        if (value.startsWith(" ")) value = value.slice(1)
        if (field === "event") this.event = value
        if (field === "data") this.data.push(value)
        if (this.data.reduce((size, entry) => size + entry.length, 0) > 1024 * 1024) throw new Error("SSE event too large")
      }
    }
  }
}

interface SubscriptionOptions {
  fetch: Fetch
  session: () => Promise<DenSession | null>
  changed: () => void
  unauthorized?: () => void
  signal: AbortSignal
  heartbeatMs?: number
  retryMs?: number
}

/** One owned subscription. Resolves credentials anew before every reconnect. */
export function subscribeInventory(options: SubscriptionOptions): Promise<void> {
  return (async () => {
    let failures = 0
    while (!options.signal.aborted) {
      const connection = new AbortController()
      const signal = AbortSignal.any([options.signal, connection.signal])
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const touch = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => connection.abort(), options.heartbeatMs ?? 45_000)
        watchdog.unref?.()
      }
      try {
        const session = await options.session()
        if (!session || signal.aborted) return
        if (!isAllowedApiBaseUrl(session.apiBaseUrl)) return
        touch() // Also bounds a server that never sends response headers.
        const response = await options.fetch(`${normalizeBaseUrl(session.apiBaseUrl)}${INVENTORY_EVENTS_PATH}`, {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${session.token}`,
            ...(session.orgId ? { "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId } : {}),
          },
          redirect: "error",
          signal,
        })
        // A killed/unsupported rollout is terminal for this session; do not hammer Den.
        // A new account/session (or a restarted engine) owns a new subscription.
        if (response.status === 404) { await response.body?.cancel().catch(() => {}); return }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => {})
          options.unauthorized?.()
          return
        }
        if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel()
          throw new Error("Inventory subscription unavailable")
        }
        // Reconnects always reconcile, even if the server's first event is lost.
        options.changed()
        const parser = new SseParser(({ event }) => {
          if (event === "inventory.changed") options.changed()
        })
        const reader = response.body.getReader()
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const decoder = new TextDecoder()
          while (!signal.aborted) {
            const chunk = await reader.read()
            if (chunk.done) break
            touch()
            failures = 0
            parser.push(decoder.decode(chunk.value, { stream: true }))
          }
        } finally {
          signal.removeEventListener("abort", cancel)
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      } catch {
        // No response bodies/URLs/tokens in logs; transient failures retry below.
      } finally {
        clearTimeout(watchdog)
        connection.abort()
      }
      if (options.signal.aborted) return
      const base = options.retryMs ?? 1000
      const backoff = Math.min(30_000, base * 2 ** Math.min(failures++, 5))
      await delay(backoff, undefined, { signal: options.signal, ref: false }).catch(() => {})
    }
  })()
}
