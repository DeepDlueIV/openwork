/** Fake fetch for tests: routes by "METHOD path" and records every call. No network. */
import type { Fetch } from "./den.ts"

export interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly redirect: RequestRedirect | undefined
}

export type Route = (call: RecordedCall) => Response | Promise<Response>

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(init).forEach((value, key) => {
    result[key] = value
  })
  return result
}

export function fakeFetch(routes: Record<string, Route | Route[]>): { fetch: Fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const counters = new Map<string, number>()
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    const call: RecordedCall = {
      method,
      url: input,
      path: `${url.pathname}${url.search}`,
      headers: headerRecord(init?.headers),
      body,
      redirect: init?.redirect,
    }
    calls.push(call)
    const key = `${method} ${call.path}`
    const route = routes[key]
    if (!route) return json(404, { error: "not_found" })
    if (Array.isArray(route)) {
      const index = counters.get(key) ?? 0
      counters.set(key, index + 1)
      const next = route[Math.min(index, route.length - 1)]
      if (!next) return json(500, {})
      return next(call)
    }
    return route(call)
  }
  return { fetch, calls }
}
