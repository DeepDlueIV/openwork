import { SignJWT, jwtVerify } from "jose"
import { z } from "zod"
import type { OfficeSession } from "./onlyoffice"
import { listZipEntries } from "@openwork/workbook"

export const OFFICE_MAX_BYTES = 12 * 1024 * 1024
export const OFFICE_TTL_SECONDS = 4 * 60 * 60
export function validateOfficePackage(bytes: Uint8Array, fileType: "docx" | "xlsx") {
  const entries = listZipEntries(bytes)
  if (!entries.some(entry => entry.name === (fileType === "docx" ? "word/document.xml" : "xl/workbook.xml"))) throw new Error("The document service returned a different file format.")
  if (entries.some(entry => /vbaproject|_xmlsignatures|encryptedpackage/i.test(entry.name))) throw new Error("Macro-enabled, encrypted and signed Office packages cannot be edited here.")
}
export const officeDraftSchema = z.object({
  id: z.string().uuid(), organizationId: z.string(), memberId: z.string(), userId: z.string(), connectionId: z.string(),
  fileId: z.string(), revision: z.string(), name: z.string(), mimeType: z.string(),
  fileType: z.enum(["docx", "xlsx"]), canEdit: z.boolean(), saveAsCopy: z.boolean(),
  expiresAt: z.number(), ticket: z.string(), source: z.string(),
  draft: z.string().optional(), pending: z.string().optional(), completed: z.string().optional(),
  savedFileId: z.string().optional(), error: z.string().optional(), uncertain: z.boolean().optional(),
})
export type OfficeDraft = z.infer<typeof officeDraftSchema>
/** Hosts provide shared, encrypted temporary storage and cross-process serialization. */
export type OfficeStore = {
  get(id: string): Promise<OfficeDraft | null>
  put(draft: OfficeDraft): Promise<void>
  remove(draft: OfficeDraft): Promise<void>
  lock<T>(key: string, action: () => Promise<T>): Promise<T>
}
export type OnlyOfficeOptions = { serverUrl: string; callbackBaseUrl: string; jwtSecret: string; fetch?: typeof fetch }

export async function officeBytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error("The document service did not return the file.")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("The document service returned an empty file.")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    if (Number(response.headers.get("content-length")) > OFFICE_MAX_BYTES) throw new Error("This file exceeds the 12 MB editing limit.")
    for (;;) {
      const next = await reader.read(); if (next.done) break
      size += next.value.byteLength
      if (size > OFFICE_MAX_BYTES) throw new Error("This file exceeds the 12 MB editing limit.")
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (!size) throw new Error("The document service returned an empty file.")
  return bytes
}

/** ONLYOFFICE protocol only; the host owns user authorization and provider writes. */
export function createOnlyOfficeService(options: OnlyOfficeOptions) {
  const secret = new TextEncoder().encode(options.jwtSecret)
  const server = new URL(options.serverUrl)
  const fetcher = options.fetch ?? fetch
  const sign = (payload: Record<string, unknown>, expiration: number) => new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt().setExpirationTime(expiration).sign(secret)
  const sourceUrl = (draft: OfficeDraft) => `${options.callbackBaseUrl}/v1/documents/onlyoffice/sessions/${draft.id}/source?ticket=${encodeURIComponent(draft.ticket)}`
  return {
    sourceUrl,
    async session(draft: OfficeDraft): Promise<OfficeSession> {
      const config = {
        documentType: draft.fileType === "docx" ? "word" : "cell",
        document: { key: draft.id, title: draft.name, fileType: draft.fileType, url: sourceUrl(draft), permissions: { edit: draft.canEdit, download: true, print: true, copy: true } },
        editorConfig: {
          mode: draft.canEdit ? "edit" : "view",
          callbackUrl: `${options.callbackBaseUrl}/v1/documents/onlyoffice/sessions/${draft.id}/callback`,
          user: { id: draft.memberId, name: "Document editor" },
          customization: { autosave: true, forcesave: false, macros: false, plugins: false },
          plugins: { autostart: [], pluginsData: [] },
        },
        width: "100%", height: "100%", type: "desktop",
      } satisfies Omit<OfficeSession["config"], "token">
      return { id: draft.id, serverUrl: server.origin, expiresAt: draft.expiresAt, canEdit: draft.canEdit, saveAsCopy: draft.saveAsCopy, config: { ...config, token: await sign(config, Math.floor(draft.expiresAt / 1000)) } }
    },
    async verifySource(draft: OfficeDraft, authorization: string | undefined, ticket: string | undefined) {
      if (ticket !== draft.ticket) throw new Error("Invalid download ticket.")
      const { payload } = await jwtVerify((authorization ?? "").replace(/^Bearer /i, ""), secret, { algorithms: ["HS256"] })
      const parsed = z.object({ payload: z.object({ url: z.string() }), operation: z.literal("download").optional() }).parse(payload)
      if (parsed.payload.url !== sourceUrl(draft)) throw new Error("Invalid document download.")
    },
    async callback(draft: OfficeDraft, authorization: string | undefined, bodyToken?: string) {
      const { payload } = await jwtVerify(authorization ? authorization.replace(/^Bearer /i, "") : bodyToken ?? "", secret, { algorithms: ["HS256"] })
      // Read signed fields exclusively. An editor-config JWT is never a callback/download JWT.
      const fields = z.object({ key: z.string(), status: z.number().int(), url: z.string().url().optional(), filetype: z.string().optional(), userdata: z.string().optional() })
      z.object({ operation: z.literal("callback").optional() }).parse(payload)
      const body = fields.parse(payload.payload ?? payload)
      if (body.key !== draft.id) throw new Error("Callback belongs to another document.")
      if (body.status === 3 || body.status === 7) return { error: "The document service could not prepare the file. Your Drive file has not been changed." }
      // Closing an editor does not authorize a Drive save. Only a requested force-save is staged.
      if (body.status !== 6) return {}
      if (body.status === 6 && (!draft.pending || body.userdata !== draft.pending)) return {}
      if (!draft.canEdit || !body.url || body.filetype !== draft.fileType) throw new Error("Unexpected document output.")
      const url = new URL(body.url)
      // No arbitrary fetch, credentials, redirect, alternate port or protocol from callback data.
      if (url.origin !== server.origin || url.username || url.password || !url.pathname.startsWith("/cache/files/")) throw new Error("Untrusted document output URL.")
      const bytes = await officeBytes(await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20_000) }))
      return { bytes, completed: body.status === 6 && body.userdata === draft.pending ? body.userdata : undefined }
    },
    async flush(draft: OfficeDraft, nonce: string) {
      const body = { c: "forcesave", key: draft.id, userdata: nonce, operation: "command" }
      const response = await fetcher(new URL("/coauthoring/CommandService.ashx", server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: await sign(body, Math.floor(Date.now() / 1000) + 60) }), redirect: "error", signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error("The document service could not prepare your changes.")
      const result = z.object({ error: z.number().int() }).parse(await response.json())
      if (result.error !== 0 && result.error !== 4) throw new Error("The document service could not prepare your changes. Try saving again when it is ready.")
      return result.error === 4 ? "unchanged" : "pending"
    },
  }
}
