import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient } from "../../../packages/headless-protocol/src/client.ts"
import { editWorkbotMessage, type WorkbotActor } from "../../../packages/workbot-server/src/service.ts"

const actor: WorkbotActor = { organizationId: "org_example", organizationName: "Example", organizationMetadata: {}, memberId: "member_example", userId: "user_example", firstName: "Alex" }

function fixture() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  let refuse = true
  const turns = ["wb_original1", "wb_followup1"]
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "local-fixture-token" }, maxTokenTtlMs: 1000,
    mintToken: async () => ({ token: "local-member-token" }),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET"
      const path = new URL(String(url)).pathname
      const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ method, path, body })
      if (method === "DELETE") { turns.splice(0); return new Response(null, { status: 204 }) }
      if (method === "GET") return Response.json({ turns: turns.map(messageId => ({ messageId, status: "completed", error: null })), messages: [], finalAssistantText: "Earlier answer" })
      if (method === "PUT") return Response.json({ id: path.split("/").pop() })
      if (refuse) return Response.json({ error: "too_many_queued" }, { status: 429 })
      if (typeof body.messageId === "string" && !turns.includes(body.messageId)) turns.push(body.messageId)
      return Response.json({ state: "accepted" }, { status: 202 })
    },
  })
  return { client, calls, turns, accept: () => { refuse = false } }
}

test("a refused correction keeps the original and all later turns; retry uses the same new id", async () => {
  const runner = fixture()
  const deps = { client: runner.client, canSchedule: async () => false }
  const input = { id: "original1", newId: "corrected1", text: "Use Friday", attachments: ["file_example"] }
  assert.deepEqual(await editWorkbotMessage(actor, input, deps), { ok: false, code: "too_many_queued" })
  assert.deepEqual(runner.turns, ["wb_original1", "wb_followup1"])
  runner.accept()
  assert.deepEqual(await editWorkbotMessage(actor, input, deps), { ok: true })
  assert.deepEqual(await editWorkbotMessage(actor, input, deps), { ok: true })
  assert.deepEqual(runner.turns, ["wb_original1", "wb_followup1", "wb_corrected1"])
  assert.equal(runner.calls.some(call => call.method === "DELETE"), false)
  const sends = runner.calls.filter(call => call.method === "POST")
  assert.equal(sends.length, 3)
  for (const send of sends) {
    assert.equal(send.body.messageId, "wb_corrected1")
    assert.equal(send.body.prompt, "Correction to an earlier message:\nUse Friday")
    assert.deepEqual(send.body.attachments, ["file_example"])
  }
})

test("an unknown original never sends or deletes anything", async () => {
  const runner = fixture()
  assert.deepEqual(await editWorkbotMessage(actor, { id: "unknown01", newId: "corrected1", text: "Use Friday" }, { client: runner.client, canSchedule: async () => false }), { ok: false, code: "unknown_message" })
  assert.equal(runner.calls.some(call => call.method !== "GET"), false)
})
