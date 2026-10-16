import { randomBytes, randomUUID } from "node:crypto"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { officeSessionSchema, officeStatusSchema } from "@openwork/documents/onlyoffice"
import { createOnlyOfficeService, validateOfficePackage, officeBytes, OFFICE_TTL_SECONDS, type OfficeDraft } from "@openwork/documents/onlyoffice-server"
import { documentIdSchema } from "@openwork/documents/model"
import { configuredOfficeStore } from "../../documents-office-store.js"
import { env } from "../../env.js"
import { getOrganizationContextForUser } from "../../orgs.js"
import { beginAuditRequest } from "../../audit/request-capture.js"
import { organizationFeatureEnabled } from "../../features.js"
import { orgMemberRoute, tokenRoute, paramValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { requestGoogleAction, readGoogleActionJson, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const ROOT = "/v1/documents/google-drive/files/:fileId/office"
const SERVICE = "/v1/documents/onlyoffice/sessions/:sessionId"
const scope = "https://www.googleapis.com/auth/drive"
const READ = [scope, `${scope}.readonly`]
const MIME = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
const params = z.object({ fileId: documentIdSchema })
const sessionParams = params.extend({ sessionId: z.string().uuid() })
const fileSchema = z.object({ id: documentIdSchema, name: z.string(), mimeType: z.string(), version: z.string(), trashed: z.boolean().optional(), capabilities: z.object({ canEdit: z.boolean().optional() }).optional() })
const failureSchema = z.object({ error: z.string(), message: z.string() })
type GoogleContext = Parameters<typeof requestGoogleAction>[0]
function validOrigin(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname)))) throw new Error("Documents requires HTTPS service origins (HTTP is limited to local development).")
  return url.origin
}
function configuredService() {
  const config = env.documentsOffice
  if (!config.serverUrl || !config.jwtSecret || !config.callbackBaseUrl) return null
  return createOnlyOfficeService({ serverUrl: validOrigin(config.serverUrl), callbackBaseUrl: validOrigin(config.callbackBaseUrl), jwtSecret: config.jwtSecret })
}

export function registerGoogleOfficeEditorRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, deps: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const store = configuredOfficeStore()
  const service = configuredService()
  const enabled = async (id: string) => await organizationFeatureEnabled(id, "workbotDocuments") && await organizationFeatureEnabled(id, "workbot")
  const guard: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    const context = c.get("organizationContext")
    if (!context || !await enabled(context.organization.id)) return c.json({ error: "feature_disabled", message: "Documents is off for this workspace." }, 403)
    if (!store || !service) return c.json({ error: "office_not_configured", message: "Full document editing is not set up for this workspace. An administrator can enable the document editor. You can open this file in Drive." }, 503)
    c.header("cache-control", "no-store")
    await next()
  }
  const description = (operationId: string, summary: string, schema: z.ZodType, security?: []) => {
    const options: DescribeRouteOptions & { "x-mcp": false } = { operationId, summary, tags: ["Documents"], "x-mcp": false, ...(security ? { security } : {}), responses: { 200: jsonResponse("Office editor result.", schema), 409: jsonResponse("Reopen or reconnect.", failureSchema), 503: jsonResponse("The editor is unavailable.", failureSchema) } }
    return describeRoute(options)
  }
  const failure = (c: GoogleContext, message: string) => c.json({ error: "office_unavailable", message }, 409)
  const selected = async (c: GoogleContext, connectionId?: string) => {
    const context = c.get("organizationContext")
    if (!context) throw new Error("Sign in to your workspace.")
    const token = await deps.token({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, connectionId: connectionId ?? null })
    if (token.kind !== "ok" || !token.connectionId) return { ok: false, reply: c.json({ error: token.kind === "policy_blocked" ? "policy_blocked" : "needs_connection", message: token.kind === "ok" ? "Connect Google Drive to open documents." : token.message }, 409) } as const
    return { ok: true, token, connectionId: token.connectionId, deps: { ...deps, fetch: (url: Parameters<typeof fetch>[0], init?: RequestInit) => deps.fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]) }), token: (input: Parameters<typeof deps.token>[0]) => deps.token({ ...input, connectionId: token.connectionId }) } } as const
  }
  const fileUrl = (id: string, suffix = "") => new URL(`/drive/v3/files/${id}${suffix}`, env.googleApiBaseUrl ?? "https://www.googleapis.com")
  const metadata = async (c: GoogleContext, selectedDeps: GoogleWorkspaceActionDependencies, id: string) => {
    const url = fileUrl(id); url.searchParams.set("fields", "id,name,mimeType,version,trashed,capabilities(canEdit)"); url.searchParams.set("supportsAllDrives", "true")
    const result = await requestGoogleAction(c, selectedDeps, READ, url)
    if (!result.ok) return result
    const file = fileSchema.parse(await readGoogleActionJson(result.response))
    if (file.id !== id || file.trashed) throw new Error("This file is unavailable or in the trash.")
    return { ok: true, file, etag: result.response.headers.get("etag") } as const
  }
  const owned = async (c: GoogleContext, id: string, fileId: string) => {
    const draft = await store?.get(id); const context = c.get("organizationContext")
    if (!draft || !context || draft.organizationId !== context.organization.id || draft.memberId !== context.currentMember.id || draft.fileId !== fileId) throw new Error("This editing session expired or belongs to another person. Reopen the file.")
    return draft
  }
  const serviceAuthorized = async (c: Parameters<MiddlewareHandler<{ Variables: OrgRouteVariables }>>[0], draft: OfficeDraft) => {
    const context = await getOrganizationContextForUser({ organizationId: normalizeDenTypeId("organization", draft.organizationId), userId: normalizeDenTypeId("user", draft.userId) })
    if (!context || context.currentMember.id !== draft.memberId || !await enabled(draft.organizationId)) return false
    c.set("organizationContext", context)
    const auth = await selected(c, draft.connectionId)
    if (!auth.ok) return false
    return (await metadata(c, auth.deps, draft.savedFileId ?? draft.fileId)).ok
  }

  app.post(ROOT, description("openGoogleDriveOfficeEditor", "Open the full Word or Excel editor", officeSessionSchema), orgMemberRoute(), guard, bodyLimit({ maxSize: 1024 }), paramValidator(params), async c => {
    if (!store || !service) return failure(c, "The document editor is unavailable.")
    try {
      const { fileId } = c.req.valid("param"); const auth = await selected(c); if (!auth.ok) return auth.reply
      const meta = await metadata(c, auth.deps, fileId); if (!meta.ok) return meta.reply
      const native = meta.file.mimeType === "application/vnd.google-apps.document" ? "docx" : meta.file.mimeType === "application/vnd.google-apps.spreadsheet" ? "xlsx" : null
      const fileType = native ?? (meta.file.mimeType === MIME.docx ? "docx" : meta.file.mimeType === MIME.xlsx ? "xlsx" : null)
      if (!fileType) return failure(c, "The full editor supports Word and Excel documents.")
      const url = fileUrl(fileId, native ? "/export" : ""); url.searchParams.set(native ? "mimeType" : "alt", native ? MIME[fileType] : "media")
      const media = await requestGoogleAction(c, auth.deps, READ, url); if (!media.ok) return media.reply
      const bytes = await officeBytes(media.response); validateOfficePackage(bytes, fileType)
      const latest = await metadata(c, auth.deps, fileId); if (!latest.ok) return latest.reply
      if (meta.file.version !== latest.file.version) return failure(c, "This file changed while opening. Open the latest version again.")
      const context = c.get("organizationContext")!
      const canWrite = auth.token.account.scopes?.includes(scope) === true && auth.token.enabledScopes.includes(scope)
      const draft: OfficeDraft = {
        id: randomUUID(), organizationId: context.organization.id, memberId: context.currentMember.id, userId: context.currentMember.userId, connectionId: auth.connectionId,
        fileId, revision: meta.file.version, name: native ? `${meta.file.name}.${fileType}` : meta.file.name, mimeType: MIME[fileType], fileType,
        canEdit: canWrite && (native !== null || meta.file.capabilities?.canEdit === true), saveAsCopy: native !== null,
        expiresAt: Date.now() + OFFICE_TTL_SECONDS * 1000, ticket: randomBytes(32).toString("base64url"), source: Buffer.from(bytes).toString("base64"),
      }
      await store.lock(`member:${draft.organizationId}:${draft.memberId}`, () => store.put(draft))
      return c.json(await service.session(draft))
    } catch (error) { return failure(c, error instanceof Error ? error.message : "Couldn't open the full editor.") }
  })

  app.get(`${ROOT}/:sessionId`, description("getGoogleDriveOfficeEditorStatus", "Check whether an Office save is ready", officeStatusSchema), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    try {
      const input = c.req.valid("param"); const draft = await owned(c, input.sessionId, input.fileId)
      const auth = await selected(c, draft.connectionId); if (!auth.ok) return auth.reply
      const check = await metadata(c, auth.deps, draft.savedFileId ?? draft.fileId); if (!check.ok) return check.reply
      return c.json({ expiresAt: draft.expiresAt, ready: !!draft.pending && draft.pending === draft.completed, pending: !!draft.pending && draft.pending !== draft.completed, savedFileId: draft.savedFileId, error: draft.error })
    } catch (error) { return failure(c, error instanceof Error ? error.message : "Couldn't check the save.") }
  })

  app.post(`${ROOT}/:sessionId/flush`, description("prepareGoogleDriveOfficeSave", "Prepare an Office snapshot for an explicit save", z.object({ ok: z.literal(true) })), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    if (!store || !service) return failure(c, "The document editor is unavailable.")
    try {
      const input = c.req.valid("param"); const draft = await owned(c, input.sessionId, input.fileId)
      const auth = await selected(c, draft.connectionId); if (!auth.ok) return auth.reply
      if (!draft.canEdit || !auth.token.account.scopes?.includes(scope) || !auth.token.enabledScopes.includes(scope)) return c.json({ error: "read_only", message: "Editing requires Drive write access." }, 403)
      if (draft.uncertain) return failure(c, "Check the file in Drive and reopen it before saving again. The last write was not confirmed.")
      const nonce = randomUUID()
      await store.lock(draft.id, async () => { const current = await owned(c, draft.id, input.fileId); current.pending = nonce; current.completed = undefined; current.error = undefined; await store.put(current) })
      // Do not hold the session lock across a command: the service may callback before responding.
      if (await service.flush(draft, nonce) === "unchanged") await store.lock(draft.id, async () => { const current = await owned(c, draft.id, input.fileId); if (current.pending === nonce) { current.completed = nonce; await store.put(current) } })
      return c.json({ ok: true })
    } catch (error) { return failure(c, error instanceof Error ? error.message : "Couldn't prepare the save.") }
  })

  app.post(`${ROOT}/:sessionId/save`, description("saveGoogleDriveOfficeEditor", "Save an Office snapshot to Drive", z.object({ fileId: documentIdSchema })), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    if (!store) return failure(c, "The document editor is unavailable.")
    try {
      const input = c.req.valid("param"); const initial = await owned(c, input.sessionId, input.fileId)
      return await store.lock(`file:${initial.organizationId}:${initial.connectionId}:${initial.savedFileId ?? initial.fileId}`, () => store.lock(initial.id, async () => {
        const draft = await owned(c, initial.id, input.fileId)
        if (!draft.canEdit || !draft.pending || draft.pending !== draft.completed || draft.uncertain) return failure(c, "Prepare your latest changes before saving. An unconfirmed save must be checked in Drive.")
        const auth = await selected(c, draft.connectionId); if (!auth.ok) return auth.reply
        const target = draft.savedFileId ?? draft.fileId
        const meta = await metadata(c, auth.deps, target); if (!meta.ok) return meta.reply
        const copy = draft.saveAsCopy && !draft.savedFileId
        if (!copy && (meta.file.version !== draft.revision || meta.file.mimeType !== draft.mimeType || !meta.file.capabilities?.canEdit)) return failure(c, "This file changed in Drive or is read-only. Keep this tab open and download a copy from the editor, then reopen the Drive file.")
        const bytes = new Uint8Array(Buffer.from(draft.draft ?? draft.source, "base64")); validateOfficePackage(bytes, draft.fileType)
        let body: BodyInit = bytes.buffer; let contentType = draft.mimeType
        const url = new URL(`/upload/drive/v3/files${copy ? "" : `/${target}`}`, env.googleApiBaseUrl ?? "https://www.googleapis.com")
        url.searchParams.set("uploadType", copy ? "multipart" : "media"); url.searchParams.set("fields", "id,name,mimeType,version"); url.searchParams.set("supportsAllDrives", "true")
        if (copy) {
          const boundary = `office_${randomUUID()}`; contentType = `multipart/related; boundary=${boundary}`
          body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: draft.name, mimeType: draft.mimeType })}\r\n--${boundary}\r\nContent-Type: ${draft.mimeType}\r\n\r\n`, bytes.buffer, `\r\n--${boundary}--\r\n`])
        }
        const binaryDeps = { ...auth.deps, fetch: (request: Parameters<typeof fetch>[0], init?: RequestInit) => { const headers = new Headers(init?.headers); headers.set("content-type", contentType); return auth.deps.fetch(request, { ...init, headers, signal: AbortSignal.timeout(20_000) }) } }
        // Persist uncertainty before writing: a lost response must never trigger an automatic duplicate/overwrite.
        draft.uncertain = true; await store.put(draft)
        const result = await requestGoogleAction(c, binaryDeps, [scope], url, { method: copy ? "POST" : "PATCH", body, ...(meta.etag && !copy ? { headers: { "if-match": meta.etag } } : {}) })
        if (!result.ok) return result.reply
        const saved = z.object({ id: documentIdSchema, version: z.string() }).parse(await readGoogleActionJson(result.response))
        if (!copy && saved.id !== target) throw new Error("The save response could not be verified. Check the file in Drive before reopening it.")
        draft.savedFileId = saved.id; draft.revision = saved.version; draft.pending = undefined; draft.completed = undefined; draft.uncertain = false
        await store.put(draft)
        return c.json({ fileId: saved.id })
      }))
    } catch (error) { return failure(c, error instanceof Error ? error.message : "The save was not confirmed. Check Drive before trying again.") }
  })

  app.post(`${ROOT}/:sessionId/close`, description("closeGoogleDriveOfficeEditor", "Discard the temporary Office session without changing Drive", z.object({ ok: z.literal(true) })), orgMemberRoute(), guard, paramValidator(sessionParams), async c => {
    if (!store) return failure(c, "The document editor is unavailable.")
    try {
      const input = c.req.valid("param"); const draft = await owned(c, input.sessionId, input.fileId)
      await store.lock(draft.id, () => store.remove(draft))
      return c.json({ ok: true })
    } catch { return failure(c, "This editing session is already closed or expired.") }
  })

  app.get(`${SERVICE}/source`, description("downloadOnlyOfficeSource", "Download one signed Office session source", z.unknown(), []), tokenRoute, async c => {
    try {
      const id = z.string().uuid().parse(c.req.param("sessionId")); const draft = await store?.get(id)
      if (!draft || !service) return c.json({ error: "not_found" }, 404)
      await service.verifySource(draft, c.req.header("authorization"), c.req.query("ticket"))
      if (!await serviceAuthorized(c, draft)) return c.json({ error: "not_found" }, 403)
      const blocked = await beginAuditRequest(c); if (blocked) return blocked
      return new Response(new Uint8Array(Buffer.from(draft.source, "base64")).buffer, { headers: { "content-type": draft.mimeType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } })
    } catch { return c.json({ error: "invalid_document_request" }, 403) }
  })
  app.post(`${SERVICE}/callback`, description("receiveOnlyOfficeSnapshot", "Retain a signed editor snapshot without writing to Drive", z.object({ error: z.number() }), []), tokenRoute, bodyLimit({ maxSize: 1024 * 1024 }), async c => {
    try {
      const id = z.string().uuid().parse(c.req.param("sessionId")); const draft = await store?.get(id)
      if (!store || !draft || !service || !await enabled(draft.organizationId)) return c.json({ error: 1 }, 403)
      const input = z.object({ token: z.string().optional() }).parse(await c.req.json())
      const snapshot = await service.callback(draft, c.req.header("authorization"), input.token)
      if (!await serviceAuthorized(c, draft)) return c.json({ error: 1 }, 403)
      const blocked = await beginAuditRequest(c); if (blocked) return blocked
      if (snapshot.bytes) validateOfficePackage(snapshot.bytes, draft.fileType)
      await store.lock(id, async () => {
        const current = await store.get(id); if (!current) throw new Error("Expired session.")
        if (snapshot.bytes && (!snapshot.completed || current.pending !== snapshot.completed)) return
        if (snapshot.bytes) current.draft = Buffer.from(snapshot.bytes).toString("base64")
        if (snapshot.completed && current.pending === snapshot.completed) current.completed = snapshot.completed
        if (snapshot.error) current.error = snapshot.error
        await store.put(current)
      })
      return c.json({ error: 0 })
    } catch { return c.json({ error: 1 }, 403) }
  })
  routeApp.route("/", app)
}
