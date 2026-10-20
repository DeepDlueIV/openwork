/** Boots the real Worker host with a streamed mock model; all database state is isolated in a temporary project. */
import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { z } from "zod"
import { createApp } from "../src/app.js"
import type { ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const runtime = process.argv.includes("--celld") ? "celld" : "wrangler"
const project = join(import.meta.dirname, "..")
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "owner-cells-e2e-")))
const token = `test_${crypto.randomUUID().replaceAll("-", "")}`
const ownerA = "test-org/member-a"
const ownerB = "test-org/member-b"
let worker: ChildProcess | null = null
let output = ""
let base = ""
let slowCalls = 0
let durableCalls = 0
const hanging: ServerResponse[] = []
/** A `[steps]` turn: this many tool steps, each model call taking STEP_MS, then its answer; calls per step index. */
const STEP_COUNT = 5
const STEP_MS = 800
const stepCalls = new Map<number, number>()
const modelKeys: string[] = []
const seenReadResults: string[] = []
const modelRequest = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).loose()) })
const model = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "test-model" }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body = modelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    modelKeys.push(request.headers.authorization ?? "")
    const index = body.messages.findLastIndex((message) => message.role === "user")
    const content = body.messages[index]?.content
    const prompt = typeof content === "string" ? content : ""
    const result = body.messages.slice(index + 1).find((message) => message.role === "tool")
    if (prompt.includes("[steps]")) {
      // A slow step-mode turn: each call streams a little, waits, then asks for the next note (or answers).
      const step = body.messages.slice(index + 1).filter((message) => message.role === "tool").length
      stepCalls.set(step, (stepCalls.get(step) ?? 0) + 1)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Step ${step}. ` } }] })}\n\n`)
      const note = { index: 0, id: `call_step_${step}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `steps/${step}.md`, content: `step ${step}` }) } }
      setTimeout(() => {
        const last = { choices: [{ delta: step < STEP_COUNT ? { tool_calls: [note] } : { content: "Steps done." }, finish_reason: step < STEP_COUNT ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
        response.end(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)
      }, STEP_MS)
      return
    }
    if (prompt.includes("[slow]") && !result && slowCalls++ === 0) {
      hanging.push(response)
      return
    }
    if (prompt.includes("[durable]") && !result && durableCalls++ === 0) {
      hanging.push(response)
      return
    }
    if (result && prompt.includes("[read]")) seenReadResults.push(String(result.content))
    const read = prompt.includes("[read]")
    const tool = { index: 0, id: "call_note", type: "function", function: {
      name: read ? "read_file" : "write_file",
      arguments: JSON.stringify({ path: "memory/note.md", ...(!read ? { content: "shared-memory-witness" } : {}) }),
    } }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: result ? { content: "Memory checked." } : { tool_calls: [tool] }, finish_reason: result ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

// Den's resume-token exchange (self-resume): answers every grant with a fresh token and records who asked.
const callbackToken = `test_callback_${crypto.randomUUID().replaceAll("-", "")}`
const grantKey = `test_grant_key_${crypto.randomUUID().replaceAll("-", "")}`
const grant = `hrg_${randomBytes(32).toString("base64url")}`
const exchanges: Array<{ authorization: string | undefined; grant: string; sessionId: string; messageId: string }> = []
const den = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  if (request.method !== "POST" || request.url !== "/v1/headless/resume-token") return void response.writeHead(404).end()
  const body = z.object({ grant: z.string(), sessionId: z.string(), messageId: z.string() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString()))
  exchanges.push({ authorization: request.headers.authorization, ...body })
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mcpToken: `test-fresh-token-${exchanges.length}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), readOnly: false }))
})
let denPort = 0

async function freePort() {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function start(modelPort: number) {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const vars = {
    HEADLESS_API_TOKEN: token,
    HEADLESS_MODEL_PROTOCOL: "openai",
    HEADLESS_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
    HEADLESS_MODEL: "test-model",
    // Slack and Automations send no model key of their own; the runner's default key answers them.
    HEADLESS_MODEL_API_KEY: "test-default-key",
    // Self-resume: turns sent with a resume grant keep going after a restart with nobody re-sending them.
    HEADLESS_DEN_API_URL: `http://127.0.0.1:${denPort}`,
    HEADLESS_DEN_CALLBACK_TOKEN: callbackToken,
    HEADLESS_GRANT_KEY: grantKey,
  }
  writeFileSync(join(temporary, ".dev.vars"), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n"))
  // celld requires main to be inside the project. Bundle into our isolated project instead of clobbering .dev.vars.
  execFileSync(join(project, "node_modules/.bin/esbuild"), [join(project, "src/worker/index.ts"), "--bundle", "--platform=neutral", "--conditions=workerd,browser", "--main-fields=browser,module,main", "--format=esm", "--external:node:*", "--external:cloudflare:*", ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `--alias:${name}=node:${name}`), `--outfile=${join(temporary, "index.js")}`], { cwd: project, stdio: "pipe" })
  const config = readFileSync(join(project, "wrangler.jsonc"), "utf8").replace('"src/worker/index.ts"', '"index.js"')
  writeFileSync(join(temporary, "wrangler.jsonc"), config)
  const binary = runtime === "celld" ? process.env.CELLD_BIN ?? "celld" : join(project, "node_modules/.bin/wrangler")
  const args = runtime === "celld"
    // --logs prints the internal (operator) listener, which the version-switch check calls.
    ? ["dev", ".", "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"]
    : ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(temporary, "state"), "--show-interactive-dev-session=false"]
  const child = spawn(binary, args, { cwd: temporary, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", CELLD_ESBUILD: join(project, "node_modules/.bin/esbuild"),
  } })
  worker = child
  let spawnError: Error | null = null
  child.on("error", (error) => { spawnError = error })
  child.stdout?.on("data", (chunk: unknown) => { output += String(chunk) })
  child.stderr?.on("data", (chunk: unknown) => { output += String(chunk) })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`${runtime} exited: ${output.slice(-6_000)}`)
    if (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false)) return
    await sleep(200)
  }
  throw new Error(`${runtime} startup timed out: ${output.slice(-6_000)}`)
}

async function stop() {
  const child = worker
  worker = null
  if (!child?.pid || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  try { process.kill(-child.pid, "SIGKILL") } catch { return }
  await exited
}

function call(path: string, owner = ownerA, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000), headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", ...(owner ? { "x-openwork-headless-owner": owner } : {}), ...init.headers,
  } })
}
/** celld's internal listener (POST /reload, GET /state), from the newest node's log. */
function celldInternal() {
  const address = [...output.matchAll(/celld internal listening on (\S+)/g)].at(-1)?.[1]
  assert.ok(address, "celld printed its internal listener")
  return `http://${address}`
}
const celldStateSchema = z.object({ deployment: z.object({ generation: z.number(), swapping: z.number(), cells: z.record(z.string(), z.number()) }).loose() }).loose()
async function celldDeployment() {
  return celldStateSchema.parse(await (await fetch(`${celldInternal()}/state`, { signal: AbortSignal.timeout(5_000) })).json()).deployment
}
/** A session's SSE `data:` events, parsed, until `signal` aborts. */
async function readSse(id: string, owner: string, signal: AbortSignal, into: unknown[]) {
  const response = await fetch(`${base}/v1/sessions/${id}/events`, { signal, headers: { authorization: `Bearer ${token}`, "x-openwork-headless-owner": owner } })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value
        for (let boundary = buffer.indexOf("\n\n"); boundary !== -1; boundary = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (block.startsWith(":") || /^event: ready/m.test(block)) continue
          into.push(JSON.parse(block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")))
        }
      }
    } catch {
      // Aborted.
    }
  })()
}
const completedEvent = (messageId: string) => (event: unknown) => {
  const parsed = z.object({ type: z.literal("changed"), messageId: z.literal(messageId), status: z.literal("completed") }).safeParse(event)
  return parsed.success
}
async function until(check: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const viewSchema = z.object({ status: z.string(), finalAssistantText: z.string(), turns: z.array(z.object({ messageId: z.string(), status: z.string(), error: z.string().nullable() })) })
async function view(id: string, owner = ownerA) { return viewSchema.parse(await (await call(`/v1/sessions/${id}`, owner)).json()) }
async function untilIdle(id: string, owner = ownerA) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await view(id, owner)
    if (snapshot.status === "idle") return snapshot
    await sleep(100)
  }
  throw new Error(`turn did not finish: ${JSON.stringify(await view(id, owner))}`)
}
function send(id: string, messageId: string, prompt: string, owner = ownerA) {
  return call(`/v1/sessions/${id}/turns`, owner, { method: "POST", body: JSON.stringify({ messageId, prompt, credentials: { modelApiKey: "test-turn-key" } }) })
}
async function create(owner: string, body: Record<string, unknown>) {
  const response = await call("/v1/sessions", owner, { method: "POST", body: JSON.stringify(body) })
  assert.equal(response.status, 201, await response.clone().text())
  return z.object({ id: z.string() }).parse(await response.json()).id
}

try {
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
  const address = model.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolve) => den.listen(0, "127.0.0.1", resolve))
  const denAddress = den.address()
  assert.ok(denAddress && typeof denAddress === "object")
  denPort = denAddress.port
  await start(address.port)
  assert.equal((await fetch(`${base}/v1/models`)).status, 401)
  assert.equal((await call("/v1/sessions", ownerA, { method: "POST", body: JSON.stringify({ owner: ownerB }) })).status, 400)
  const main = await create(ownerA, { title: "Main", tasks: true })
  const side = await create(ownerA, { title: "Side", memoryOf: main })
  const other = await create(ownerB, { title: "Other owner" })
  assert.equal((await call(`/v1/sessions/${main}`, ownerB)).status, 404)
  assert.equal((await call(`/v1/sessions?owner=${encodeURIComponent(ownerB)}`, ownerA)).status, 400)
  assert.equal((await call("/v1/sessions", ownerB, { method: "POST", body: JSON.stringify({ memoryOf: main }) })).status, 400)
  assert.equal((await call("/v1/sessions?owner=x", "")).status, 400)
  const filesStatus = await call("/v1/files/status", "")
  assert.equal(filesStatus.status, 200, await filesStatus.clone().text())
  console.log("PASS authenticated owner routing, body consistency, and cross-owner isolation")

  // Slack and Automations: no owner header, one cell per conversation, same API as the Node runner.
  const slack = await create("", { title: "Slack thread" })
  assert.match(slack, /^hs_[0-9a-f]{32}$/)
  assert.equal((await call(`/v1/sessions/${slack}`, ownerA)).status, 404)
  assert.equal((await call(`/v1/sessions/hs_${"0".repeat(32)}`, "")).status, 404)
  assert.equal((await send(slack, "msg_slack", "[write] Slack question", "")).status, 202)
  const slackDone = await untilIdle(slack, "")
  assert.equal(slackDone.turns[0]?.status, "completed")
  assert.equal(slackDone.finalAssistantText, "Memory checked.")
  const stopped = await call(`/v1/sessions/${slack}/abort`, "", { method: "POST", body: "{}" })
  assert.equal(stopped.status, 200)
  const slackAgain = z.object({ state: z.string() }).parse(await (await send(slack, "msg_slack", "[write] Slack question", "")).json())
  assert.equal(slackAgain.state, "already_present")
  console.log("PASS owner-less (Slack/Automations) conversations: create, send, read, stop, idempotent resend, isolation")

  assert.equal((await send(main, "msg_1", "[write] Remember a note")).status, 202)
  assert.equal((await untilIdle(main)).turns[0]?.status, "completed")
  assert.equal((await call(`/v1/sessions/${main}/files/content?path=memory/note.md`)).status, 200)
  assert.equal((await send(side, "msg_2", "[read] Read the shared note")).status, 202)
  assert.equal((await untilIdle(side)).turns[0]?.status, "completed")
  assert.ok(seenReadResults.some((result) => result.includes("shared-memory-witness")))
  assert.equal((await send(other, "msg_other", "[write] A different owner", ownerB)).status, 202)
  assert.equal((await untilIdle(other, ownerB)).turns[0]?.status, "completed")
  const sessions = z.object({ sessions: z.array(z.object({ id: z.string() })) }).parse(await (await call(`/v1/sessions?owner=${encodeURIComponent(ownerA)}`)).json())
  assert.deepEqual(new Set(sessions.sessions.map((s) => s.id)), new Set([main, side]))
  const again = z.object({ state: z.string() }).parse(await (await send(main, "msg_1", "[write] Remember a note")).json())
  assert.equal(again.state, "already_present")
  assert.ok(modelKeys.length > 0 && modelKeys.every((key) => key === "Bearer test-turn-key"))
  console.log("PASS streamed model turns, file tools, shared side-chat memory, owner listing, per-turn credentials, and idempotency")

  // Den's own Slack adapter (the code Slack runs use), unchanged, against this runtime.
  const { createSlackRunner } = await import("../../den-api/src/slack-assistant/headless.ts")
  const slackDeps = { config: { url: base, token }, fetch, mintToken: async () => ({ token: "test-mcp-token" }), maxTokenTtlMs: 60 * 60_000 }
  const slackRunner = createSlackRunner({ userId: "test-user", organizationId: "test-org" }, slackDeps)
  const opened = await slackRunner.create({ title: "Slack thread" })
  assert.ok(opened.ok, JSON.stringify(opened))
  const slackSession = opened.sessionId
  const sentRun = await slackRunner.send({ sessionId: slackSession, messageId: "slack_run_1", prompt: "[write] What changed?" })
  assert.ok(sentRun.ok && sentRun.accepted, JSON.stringify(sentRun))
  let slackStatus = "busy"
  let slackText = ""
  let slackError: string | undefined
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(200)) {
    const read = await slackRunner.read({ sessionId: slackSession, messageId: "slack_run_1" })
    assert.ok(read.ok, JSON.stringify(read))
    slackStatus = read.snapshot.status
    slackText = read.snapshot.finalAssistantText
    slackError = read.snapshot.terminalError?.code
    if (slackStatus === "idle") break
  }
  assert.equal(slackStatus, "idle")
  assert.equal(slackText, "Memory checked.")
  assert.equal(slackError, undefined)
  assert.ok(modelKeys.at(-1) === "Bearer test-default-key")
  await slackRunner.stop({ sessionId: slackSession, messageId: "slack_run_1" })
  const unknown = await slackRunner.read({ sessionId: `hs_${"1".repeat(32)}`, messageId: "x" })
  assert.ok(!unknown.ok && unknown.error === "unknown_session", JSON.stringify(unknown))
  console.log("PASS Den's Slack adapter (create, send, read to the answer, stop, unknown session) unchanged on this runtime")

  // Live updates over a WebSocket (headless-protocol's openEventsSocket): the same events as the SSE stream.
  const live = await create(ownerA, { title: "Live" })
  const liveClient = createHeadlessRunnerClient({ config: { url: base, token, owner: ownerA }, fetch, mintToken: async () => ({ token: "unused" }), maxTokenTtlMs: 60_000 })
  const socketStop = new AbortController()
  const socket = await liveClient.openEventsSocket(live, socketStop.signal)
  assert.ok(socket, `${runtime} upgraded the events request`)
  const socketEvents: unknown[] = []
  let socketEnded = false
  const socketDone = (async () => {
    for await (const event of socket) socketEvents.push(event)
    socketEnded = true
  })()
  const sseStop = new AbortController()
  const sseEvents: unknown[] = []
  await readSse(live, ownerA, sseStop.signal, sseEvents)
  await until(() => socketEvents.length > 0, 5_000, "the socket's ready message")
  await sleep(200)
  assert.equal((await send(live, "msg_live_1", "[write] A live note")).status, 202)
  assert.equal((await untilIdle(live)).turns[0]?.status, "completed")
  await until(() => sseEvents.some(completedEvent("msg_live_1")) && socketEvents.some(completedEvent("msg_live_1")), 10_000, "both streams to see the turn complete")
  await sleep(200)
  assert.deepEqual(socketEvents[0], { type: "ready" })
  assert.deepEqual(socketEvents.slice(1), sseEvents, "each socket message is one SSE event, in the same order")
  assert.ok(sseEvents.length >= 4, JSON.stringify(sseEvents))
  // An open SSE stream is a request the cell is serving: it would hold up a version switch, so it ends here.
  sseStop.abort()
  console.log(`PASS live events over a WebSocket on ${runtime} match the SSE stream for the same turn`)

  if (runtime === "celld") {
    // A runner deploy: celld switches resident cells to new code once they are idle. The open hibernatable socket
    // neither holds that up (a forced switch waits 60 s) nor is closed by it, and events after the switch reach it.
    const before = await celldDeployment()
    // The socket's cell just answered a turn, so it is resident, on the code before the switch.
    assert.ok(Object.keys(before.cells).length > 0 && Object.values(before.cells).every((generation) => generation === before.generation), JSON.stringify(before))
    const reload = z.object({ ok: z.literal(true), outcome: z.literal("adopted"), generation: z.number() }).loose().parse(await (await fetch(`${celldInternal()}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) })).json())
    assert.notEqual(reload.generation, before.generation)
    const switchStarted = Date.now()
    let after = await celldDeployment()
    while (Date.now() - switchStarted < 30_000 && (after.swapping > 0 || Object.values(after.cells).some((generation) => generation !== reload.generation))) {
      await sleep(250)
      after = await celldDeployment()
    }
    assert.ok(Object.values(after.cells).every((generation) => generation === reload.generation) && after.swapping === 0, `every resident cell switched: ${JSON.stringify(after)}`)
    const switchMs = Date.now() - switchStarted
    assert.ok(switchMs < 30_000, `the switch took ${switchMs} ms`)
    assert.equal(socketEnded, false, "the socket stayed open across the switch")
    assert.equal((await send(live, "msg_live_2", "[write] After the switch")).status, 202)
    assert.equal((await untilIdle(live)).turns.find((turn) => turn.messageId === "msg_live_2")?.status, "completed")
    await until(() => socketEvents.some(completedEvent("msg_live_2")), 10_000, "the socket to see the turn after the switch")
    assert.equal(socketEnded, false)
    console.log(`PASS an open hibernatable socket didn't hold up a celld version switch (${switchMs} ms) and kept receiving events after it`)
  }
  socketStop.abort()
  await socketDone

  assert.equal((await send(main, "msg_slow", "[slow] [write] Resume after restart")).status, 202)
  // Another person's turn, sent with a resume grant (as Den sends them with headlessDurableTurns on).
  const durable = await call(`/v1/sessions/${other}/turns`, ownerB, { method: "POST", body: JSON.stringify({
    messageId: "msg_durable", prompt: "[durable] [write] Keep going on your own", credentials: { modelApiKey: "test-turn-key", resumeGrant: grant },
  }) })
  assert.equal(durable.status, 202, await durable.clone().text())
  assert.ok(!(await durable.text()).includes(grant))
  const deadline = Date.now() + 10_000
  while (hanging.length < 2 && Date.now() < deadline) await sleep(100)
  assert.equal(hanging.length, 2)
  assert.equal((await view(main)).status, "busy")
  assert.equal((await view(other, ownerB)).status, "busy")
  await stop()
  for (const response of hanging.splice(0)) response.destroy()
  await start(address.port)
  const cut = (await view(main)).turns.find((turn) => turn.messageId === "msg_slow")
  assert.equal(cut?.status, "interrupted")
  assert.equal(cut?.error, "runner_restarted")
  assert.equal((await call(`/v1/sessions/${main}/files/content?path=memory/note.md`)).status, 200)
  assert.equal((await view(slack, "")).turns[0]?.status, "completed")
  assert.equal((await send(main, "msg_slow", "[slow] [write] Resume after restart")).status, 202)
  assert.equal((await untilIdle(main)).turns.find((turn) => turn.messageId === "msg_slow")?.status, "completed")
  assert.equal((await call(`/v1/sessions/${side}`, ownerA, { method: "DELETE" })).status, 204)
  assert.equal((await call(`/v1/sessions/${side}`)).status, 404)
  assert.equal((await call(`/v1/sessions/${main}`)).status, 200)
  assert.equal((await call(`/v1/sessions/${main}/files/content?path=memory/note.md`)).status, 200)
  console.log("PASS runtime-kill recovery, resume, persisted memory, and deleting a side chat without deleting its owner's state")

  // Nobody re-sends msg_durable, or even reads that cell: its alarm wakes it on the restarted runtime, recovery
  // marks the turn interrupted, and the runner exchanges the grant with Den and resumes the turn itself.
  const resumedBy = Date.now() + 90_000
  while (!exchanges.some((entry) => entry.messageId === "msg_durable") && Date.now() < resumedBy) await sleep(250)
  assert.deepEqual(exchanges, [{ authorization: `Bearer ${callbackToken}`, grant, sessionId: other, messageId: "msg_durable" }])
  const finished = Date.now() + 30_000
  let durableView = await view(other, ownerB)
  while (durableView.turns.find((turn) => turn.messageId === "msg_durable")?.status !== "completed" && Date.now() < finished) {
    await sleep(200)
    durableView = await view(other, ownerB)
  }
  assert.equal(durableView.turns.find((turn) => turn.messageId === "msg_durable")?.status, "completed", JSON.stringify(durableView.turns))
  assert.equal(durableView.finalAssistantText, "Memory checked.")
  assert.equal(durableCalls, 2, "the turn's model call was made again after the restart")
  assert.ok(!output.includes(grant) && !output.includes("test-fresh-token"), "no grant or token in the runtime's logs")
  console.log(`PASS a turn with a resume grant completes after a ${runtime} restart with no caller re-send (alarm → Den exchange → resume)`)

  // Step mode (`execution: "steps"`): the turn runs one step at a time from its cell's alarm, so a runner deploy
  // switches the cell between two steps instead of cancelling one, and the turn goes on to its answer on the new
  // code (with the runner's model key: the caller's own is held in memory only).
  const stepped = await create("", { title: "Step mode" })
  const sentSteps = await call(`/v1/sessions/${stepped}/turns`, "", { method: "POST", body: JSON.stringify({
    messageId: "msg_steps", prompt: "[steps] Work through the list", execution: "steps", credentials: { modelApiKey: "test-turn-key" },
  }) })
  assert.equal(sentSteps.status, 202, await sentSteps.clone().text())
  assert.equal(z.object({ turn: z.object({ execution: z.string() }).loose() }).parse(await sentSteps.json()).turn.execution, "steps")
  await until(() => stepCalls.has(1), 20_000, "the first step to commit")
  let switchNote: string
  if (runtime === "celld") {
    // POST /reload on the internal listener rebuilds the deployment and adopts it as a new generation in place, the
    // same switch a `celld deploy` makes: each resident cell moves at a safe point (no request, alarm or output
    // pending), or is forced after CELLD_DEPLOY_MAX_AGE_S (60 s), cancelling its work.
    const reload = z.object({ ok: z.literal(true), outcome: z.literal("adopted"), generation: z.number() }).loose().parse(await (await fetch(`${celldInternal()}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) })).json())
    const switchStarted = Date.now()
    let after = await celldDeployment()
    while (Date.now() - switchStarted < 30_000 && (after.swapping > 0 || Object.values(after.cells).some((generation) => generation !== reload.generation))) {
      await sleep(100)
      after = await celldDeployment()
    }
    const switchMs = Date.now() - switchStarted
    assert.ok(Object.values(after.cells).every((generation) => generation === reload.generation) && after.swapping === 0, `every resident cell switched: ${JSON.stringify(after)}`)
    // Well inside the 60 s a forced switch waits: the cell was idle between two steps.
    assert.ok(switchMs < 30_000, `the switch took ${switchMs} ms`)
    const stepsAtSwitch = stepCalls.size
    assert.ok(stepsAtSwitch <= STEP_COUNT, `the cell switched before the turn's last step (${stepsAtSwitch} of ${STEP_COUNT + 1} model calls made)`)
    switchNote = `switched to generation ${reload.generation} in ${switchMs} ms after ${stepsAtSwitch} of ${STEP_COUNT + 1} model calls`
  } else {
    // wrangler dev reloads on a changed bundle: workerd restarts with the new code and cancels what was running, as a
    // Cloudflare deploy does. The step it cut off (if any) runs again from the alarm.
    const reloadsBefore = output.match(/Local server updated and ready/g)?.length ?? 0
    writeFileSync(join(temporary, "index.js"), `${readFileSync(join(temporary, "index.js"), "utf8")}\n// version switch ${Date.now()}\n`)
    await until(() => (output.match(/Local server updated and ready/g)?.length ?? 0) > reloadsBefore, 30_000, "wrangler to reload the changed bundle")
    switchNote = `reloaded with a changed bundle after ${stepCalls.size} of ${STEP_COUNT + 1} model calls`
  }
  let steppedView = await view(stepped, "")
  for (const deadline = Date.now() + 60_000; steppedView.status !== "idle" && Date.now() < deadline; steppedView = await view(stepped, "")) await sleep(200)
  assert.equal(steppedView.turns[0]?.status, "completed", JSON.stringify(steppedView.turns))
  assert.ok(steppedView.finalAssistantText.endsWith("Steps done."), steppedView.finalAssistantText)
  assert.deepEqual([...stepCalls.keys()].sort(), Array.from({ length: STEP_COUNT + 1 }, (_, step) => step), "every step ran")
  for (let step = 0; step < STEP_COUNT; step += 1) {
    assert.equal(await (await call(`/v1/sessions/${stepped}/files/content?path=steps/${step}.md`, "")).text(), `step ${step}`)
  }
  if (runtime === "celld") {
    // A forced switch cancels the step in flight, which then runs its model call again.
    assert.ok([...stepCalls.values()].every((calls) => calls === 1), `no step was cut off and run again: ${JSON.stringify([...stepCalls])}`)
  } else {
    assert.ok([...stepCalls.values()].reduce((sum, calls) => sum + calls, 0) <= STEP_COUNT + 2, `at most the step cut off ran again: ${JSON.stringify([...stepCalls])}`)
  }
  console.log(`PASS a step-mode turn keeps going through a ${runtime} version switch and completes (${switchNote}; model calls per step ${JSON.stringify(Object.fromEntries(stepCalls))})`)

  // The way off this host: a conversation's export imports into a Node runner and re-exports byte for byte.
  const exported = await call(`/v1/sessions/${main}/export`)
  assert.equal(exported.status, 200, await exported.clone().text())
  const conversation = await exported.text()
  assert.equal((await call(`/v1/sessions/${main}/import`, ownerA, { method: "POST", body: conversation })).status, 405)
  const nodeStore = new Store(nodeSqlite(":memory:"))
  const nodeModel: ModelClient = { complete: async () => { throw new Error("the Node runner only stores here") } }
  const nodeApp = createApp({ store: nodeStore, apiToken: token, runner: new Runner({ store: nodeStore, model: nodeModel, defaultModel: "test-model", limits: { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 } }) })
  const nodeAuth = { authorization: `Bearer ${token}` }
  const intoNode = await nodeApp.request(`/v1/sessions/${main}/import`, { method: "POST", headers: nodeAuth, body: conversation })
  assert.equal(intoNode.status, 201, await intoNode.clone().text())
  assert.equal(nodeStore.readFile(main, "memory/note.md"), "shared-memory-witness")
  assert.deepEqual(nodeStore.listSessions(ownerA, 10).map((session) => session.id), [main])
  assert.equal(await (await nodeApp.request(`/v1/sessions/${main}/export`, { headers: nodeAuth })).text(), conversation)
  nodeStore.close()
  console.log("PASS a conversation moves off this host into a Node runner with nothing lost; this host refuses imports")
} catch (error) {
  console.error(error)
  console.error(output.slice(-8_000))
  process.exitCode = 1
} finally {
  await stop()
  for (const response of hanging) response.destroy()
  model.closeAllConnections()
  await new Promise<void>((resolve) => model.close(() => resolve()))
  den.closeAllConnections()
  await new Promise<void>((resolve) => den.close(() => resolve()))
  rmSync(temporary, { recursive: true, force: true })
}
