import { z } from "zod"

export const officeMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet",
])
export const officeSessionSchema = z.object({
  id: z.string().uuid(), serverUrl: z.string().url(), editorUrl: z.string().url(), accessToken: z.string(), expiresAt: z.number(),
  saveAsCopy: z.boolean(), canEdit: z.boolean(), fileType: z.enum(["docx", "xlsx"]),
})
export const officeStatusSchema = z.object({ expiresAt: z.number(), draftVersion: z.number().int(), savedFileId: z.string().optional() })
export type OfficeSession = z.infer<typeof officeSessionSchema>
export type OfficeStatus = z.infer<typeof officeStatusSchema>
export type OfficeEditor = {
  open(fileId: string, signal?: AbortSignal): Promise<OfficeSession>
  status(fileId: string, sessionId: string, signal?: AbortSignal): Promise<OfficeStatus>
  save(fileId: string, sessionId: string, draftVersion: number): Promise<{ fileId: string }>
  close(fileId: string, sessionId: string): Promise<void>
}

/** Provider-independent Office transport; hosts choose their own file route. */
export function officeEditor(request: (path: string, init?: RequestInit) => Promise<unknown>, filePath: (fileId: string) => string): OfficeEditor {
  const path = (fileId: string, sessionId?: string) => `${filePath(fileId)}${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`
  const post = (url: string, body: unknown = {}, signal?: AbortSignal) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal })
  return {
    open: async (fileId, signal) => officeSessionSchema.parse(await post(path(fileId), {}, signal)),
    status: async (fileId, id, signal) => officeStatusSchema.parse(await request(path(fileId, id), { signal })),
    save: async (fileId, id, draftVersion) => z.object({ fileId: z.string() }).parse(await post(`${path(fileId, id)}/save`, { draftVersion })),
    close: async (fileId, id) => { await post(`${path(fileId, id)}/close`) },
  }
}
