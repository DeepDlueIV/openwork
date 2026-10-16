import { z } from "zod"

export const officeMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet",
])
export const officeConfigSchema = z.object({
  documentType: z.enum(["word", "cell"]),
  document: z.object({ key: z.string(), title: z.string(), fileType: z.enum(["docx", "xlsx"]), url: z.string().url(), permissions: z.object({ edit: z.boolean(), download: z.boolean(), print: z.boolean(), copy: z.boolean() }) }),
  editorConfig: z.object({
    mode: z.enum(["edit", "view"]), callbackUrl: z.string().url(), user: z.object({ id: z.string(), name: z.string() }),
    customization: z.object({ autosave: z.boolean(), forcesave: z.boolean(), macros: z.literal(false), plugins: z.literal(false) }),
    plugins: z.object({ autostart: z.array(z.string()), pluginsData: z.array(z.string()) }),
  }),
  token: z.string(), width: z.literal("100%"), height: z.literal("100%"), type: z.literal("desktop"),
})
export const officeSessionSchema = z.object({
  id: z.string().uuid(), serverUrl: z.string().url(), expiresAt: z.number(),
  saveAsCopy: z.boolean(), canEdit: z.boolean(), config: officeConfigSchema,
})
export const officeStatusSchema = z.object({
  expiresAt: z.number(), ready: z.boolean(), pending: z.boolean(), savedFileId: z.string().optional(),
  error: z.string().optional(),
})
export type OfficeSession = z.infer<typeof officeSessionSchema>
export type OfficeStatus = z.infer<typeof officeStatusSchema>
export type OfficeEditor = {
  open(fileId: string, signal?: AbortSignal): Promise<OfficeSession>
  flush(fileId: string, sessionId: string): Promise<void>
  status(fileId: string, sessionId: string, signal?: AbortSignal): Promise<OfficeStatus>
  save(fileId: string, sessionId: string): Promise<{ fileId: string }>
  close(fileId: string, sessionId: string): Promise<void>
}

/** Provider-independent Office engine transport. No credentials, provider SDK or Workbot dependencies. */
export function onlyOfficeEditor(request: (path: string, init?: RequestInit) => Promise<unknown>, filePath: (fileId: string) => string): OfficeEditor {
  const path = (fileId: string, sessionId?: string) => `${filePath(fileId)}${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`
  const post = (url: string, signal?: AbortSignal) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal })
  return {
    open: async (fileId, signal) => officeSessionSchema.parse(await post(path(fileId), signal)),
    flush: async (fileId, id) => { await post(`${path(fileId, id)}/flush`) },
    status: async (fileId, id, signal) => officeStatusSchema.parse(await request(path(fileId, id), { signal })),
    save: async (fileId, id) => z.object({ fileId: z.string() }).parse(await post(`${path(fileId, id)}/save`)),
    close: async (fileId, id) => { await post(`${path(fileId, id)}/close`) },
  }
}
