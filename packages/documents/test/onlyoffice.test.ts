import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { SignJWT } from "jose"
import { createOnlyOfficeService, officeBytes, OFFICE_MAX_BYTES, type OfficeDraft } from "../src/onlyoffice-server"

const secret = "test-document-service-secret-at-least-32-characters"
const key = new TextEncoder().encode(secret)
const draft: OfficeDraft = { id: randomUUID(), organizationId: "example-org", memberId: "example-member", userId: "example-user", connectionId: "google-workspace", fileId: "example-file", revision: "1", name: "Example.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileType: "xlsx", canEdit: true, saveAsCopy: false, expiresAt: Date.now() + 60_000, ticket: randomUUID(), source: "", pending: randomUUID() }
const signed = (payload: Record<string, unknown>) => new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1m").sign(key)
const service = (fetcher?: typeof fetch) => createOnlyOfficeService({ serverUrl: "https://office.example.com", callbackBaseUrl: "https://api.example.com", jwtSecret: secret, fetch: fetcher })

test("editor config tokens cannot authorize downloads or callbacks", async () => {
  const engine = service(); const opened = await engine.session(draft)
  await assert.rejects(engine.callback(draft, `Bearer ${opened.config.token}`))
  await assert.rejects(engine.verifySource(draft, `Bearer ${opened.config.token}`, draft.ticket))
  await assert.rejects(engine.callback(draft, `Bearer ${await signed({ payload: { key: randomUUID(), status: 4 } })}`))
  const token = await signed({ operation: "download", payload: { url: engine.sourceUrl(draft) } })
  await engine.verifySource(draft, `Bearer ${token}`, draft.ticket)
  await assert.rejects(engine.verifySource(draft, `Bearer ${token}`, "another-ticket"))
})

test("signed callbacks cannot fetch arbitrary hosts, ports, credentials or paths", async () => {
  let fetches = 0
  const engine = service(async () => { fetches++; return new Response("file") })
  for (const url of ["http://169.254.169.254/cache/files/file.xlsx", "https://office.example.com:444/cache/files/file.xlsx", "https://office.example.com/admin", "https://name:password@office.example.com/cache/files/file.xlsx", "https://office.example.com/cache/files/../../admin"]) {
    const token = await signed({ operation: "callback", payload: { key: draft.id, status: 6, filetype: "xlsx", userdata: draft.pending, url } })
    await assert.rejects(engine.callback(draft, `Bearer ${token}`))
  }
  assert.equal(fetches, 0)
})

test("only the requested save nonce completes a snapshot, with header or body signatures", async () => {
  let fetches = 0
  const engine = service(async (_url, init) => { fetches++; assert.equal(init?.redirect, "error"); return new Response("snapshot") })
  const fields = { key: draft.id, status: 6, filetype: "xlsx", userdata: draft.pending, url: "https://office.example.com/cache/files/example/output.xlsx" }
  const stale = await signed({ payload: { ...fields, userdata: "old-save" } })
  assert.deepEqual(await engine.callback(draft, `Bearer ${stale}`), {})
  assert.equal(fetches, 0)
  const header = await engine.callback(draft, `Bearer ${await signed({ operation: "callback", payload: fields })}`)
  assert.equal(header.completed, draft.pending)
  assert.equal(new TextDecoder().decode(header.bytes), "snapshot")
  const body = await engine.callback(draft, undefined, await signed(fields))
  assert.equal(body.completed, draft.pending)
  await assert.rejects(engine.callback(draft, `Bearer ${await signed({ operation: "download", payload: fields })}`))
})

test("chunked and declared oversized editor output is rejected before buffering unbounded bytes", async () => {
  let cancelled = false
  await assert.rejects(officeBytes(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(OFFICE_MAX_BYTES + 1)) }, cancel() { cancelled = true } }))))
  assert.equal(cancelled, true)
  await assert.rejects(officeBytes(new Response("small", { headers: { "content-length": String(OFFICE_MAX_BYTES + 1) } })))
})
