import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { loadConfig } from "../src/config.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { createRuntime } from "../src/runtime.js"
import { Store } from "../src/store.js"

export type ProbeFixtureMode = "answered" | "unauthorized" | "payment_required" | "unavailable" | "empty" | "timeout"

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response).catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Local fixture did not start")
  return { url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

/** Real Node runner/runtime/adapter, synthetic localhost provider, memory-only SQLite, no external credentials. */
export async function modelProbeFixture(options: { mode?: ProbeFixtureMode; lunaAvailable?: boolean; catalogVerified?: boolean; protocol?: "openai" | "anthropic" } = {}) {
  let mode = options.mode ?? "answered"
  const calls: { path: string; body: unknown; authorized: boolean }[] = []
  const provider = await listen(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk
    const authorized = (options.protocol === "anthropic" ? request.headers["x-api-key"] : request.headers.authorization) === (options.protocol === "anthropic" ? "fixture-model-key" : "Bearer fixture-model-key")
    response.setHeader("content-type", "application/json")
    if (request.url === "/models") {
      if (!authorized || options.catalogVerified === false) { response.writeHead(401).end(JSON.stringify({ error: "catalog_denied" })); return }
      response.end(JSON.stringify({ data: [{ id: "gateway/other", name: "Another model" }, ...(options.lunaAvailable === false ? [] : [{ id: "gateway/luna", name: "GPT-6 Luna" }])] })); return
    }
    calls.push({ path: request.url ?? "", body: raw ? JSON.parse(raw) : null, authorized })
    if (!authorized || mode === "unauthorized") { response.writeHead(401).end(JSON.stringify({ error: { message: "fixture-private-provider-detail fixture-model-key" } })); return }
    if (mode === "payment_required") { response.writeHead(402).end(JSON.stringify({ error: "fixture-private-billing-detail" })); return }
    if (mode === "unavailable") { response.writeHead(503).end(JSON.stringify({ error: "fixture-private-provider-detail" })); return }
    if (mode === "timeout") return
    const text = mode === "empty" ? "" : "READY. fixture-answer-must-stay-private"
    response.end(JSON.stringify(options.protocol === "anthropic"
      ? { model: "gpt-6-luna-fixture-snapshot", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { model: "gpt-6-luna-fixture-snapshot", choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  const sql = nodeSqlite(":memory:")
  try {
    const runtime = await createRuntime(loadConfig({ HEADLESS_API_TOKEN: "r".repeat(32), HEADLESS_MODEL_PROTOCOL: options.protocol ?? "openai", HEADLESS_MODEL_BASE_URL: provider.url, HEADLESS_MODEL: "gateway/other", HEADLESS_MODEL_API_KEY: "fixture-model-key" }), new Store(sql))
    const runner = await listen(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value)
      const result = await runtime.app.request(`${request.url ?? "/"}`, { method: request.method, headers, ...(body ? { body } : {}) })
      response.statusCode = result.status
      result.headers.forEach((value, name) => response.setHeader(name, value))
      response.end(Buffer.from(await result.arrayBuffer()))
    })
    return {
      url: runner.url,
      app: runtime.app,
      calls: () => [...calls],
      setMode: (next: ProbeFixtureMode) => { mode = next },
      sessionCount: () => sql.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count,
      async close() { await runner.close(); await provider.close(); sql.close() },
    }
  } catch (error) { await provider.close(); sql.close(); throw error }
}
