"use client"

import { ExternalLink, Save, X } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { DocumentItem } from "./index"
import type { OfficeEditor, OfficeSession } from "./onlyoffice"

type Engine = { destroyEditor(): void }
type EngineOptions = OfficeSession["config"] & { events: { onDocumentReady(): void; onDocumentStateChange(event: { data: boolean }): void; onError(): void; onWarning(): void } }
declare global { interface Window { DocsAPI?: { DocEditor: new (id: string, config: EngineOptions) => Engine } } }
let engineScript: { url: string; loading: Promise<void> } | undefined
function loadEngine(serverUrl: string) {
  const server = new URL(serverUrl)
  if (server.protocol !== "https:" && !(server.protocol === "http:" && ["localhost", "127.0.0.1"].includes(server.hostname))) throw new Error("The document editor requires a secure connection.")
  const url = `${server.origin}/web-apps/apps/api/documents/api.js`
  if (engineScript) {
    if (engineScript.url !== url) throw new Error("The editor server changed. Reload Documents to continue.")
    return engineScript.loading
  }
  const script = document.createElement("script"); script.src = url; script.async = true; script.referrerPolicy = "no-referrer"
  const loading = new Promise<void>((resolve, reject) => {
    script.onload = () => window.DocsAPI ? resolve() : reject(new Error("The document editor did not start."))
    script.onerror = () => { engineScript = undefined; script.remove(); reject(new Error("Couldn't reach the document editor. Your Drive file has not changed.")) }
  })
  engineScript = { url, loading }; document.head.append(script)
  return loading
}

export function OnlyOfficeEditorTab({ item, editor, enabled, active, scope, onDirtyChange, onClose }: { item: DocumentItem; editor: OfficeEditor; enabled: boolean; active: boolean; scope: readonly string[]; onDirtyChange?(id: string, dirty: boolean): void; onClose(): void }) {
  const [dirty, setDirty] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string>()
  const [error, setError] = useState<string>()
  const [closing, setClosing] = useState(false)
  const changes = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const query = useQuery({ queryKey: ["documents", ...scope, "office", item.id], queryFn: ({ signal }) => editor.open(item.id, signal), enabled: enabled && active, retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const session = query.data
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    clearTimeout(closeTimer.current)
    if (!session) return
    return () => { closeTimer.current = setTimeout(() => { void editor.close(item.id, session.id).catch(() => {}) }, 0) }
  }, [editor, item.id, session])
  useEffect(() => { onDirtyChange?.(item.id, dirty); return () => onDirtyChange?.(item.id, false) }, [dirty, item.id, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  const changed = useCallback((value: boolean) => {
    setSyncing(value)
    // false means saved on the document service, not saved in Drive.
    if (value) { changes.current++; setDirty(true) }
  }, [])
  const engineError = useCallback(() => setError("The editor reported a problem. Keep this tab open and download a copy from the editor before reloading."), [])
  const engineReady = useCallback(() => setReady(true), [])
  const [now, setNow] = useState(Date.now)
  useEffect(() => { if (!session) return; const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [session])
  const expired = !!session && session.expiresAt <= now
  const save = async () => {
    if (!session || !enabled || saving || syncing || expired || !ready) return
    const generation = changes.current; setSaving(true); setError(undefined)
    try {
      await editor.flush(item.id, session.id)
      const deadline = Date.now() + 45_000
      for (;;) {
        const status = await editor.status(item.id, session.id)
        if (status.error) throw new Error(status.error)
        if (status.ready) break
        if (!mounted.current || Date.now() > deadline) throw new Error("The editor hasn't confirmed the snapshot yet. Keep this tab open and try Save to Drive again.")
        await new Promise(resolve => setTimeout(resolve, 1_000))
      }
      const result = await editor.save(item.id, session.id)
      if (!mounted.current) return
      setSaved(result.fileId)
      if (generation === changes.current) setDirty(false)
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "The save was not confirmed. Check Drive before trying again.") }
    finally { if (mounted.current) setSaving(false) }
  }
  return <section className="ow-document-editor ow-office-editor" hidden={!active} aria-label={item.name}>
    <header className="ow-editor-toolbar"><strong>{item.name}</strong><span role="status">{saving ? "Saving to Drive…" : syncing ? "Syncing editor…" : dirty ? "Unsaved to Drive" : saved ? "Saved to Drive" : session?.canEdit ? "Ready to edit" : "Read-only"}</span>{item.openUrl && <a href={item.openUrl} target="_blank" rel="noopener noreferrer" aria-label="Open original in Drive"><ExternalLink size={16}/></a>}<button type="button" disabled={!enabled || !session?.canEdit || !ready || saving || syncing || expired || (!dirty && (!session.saveAsCopy || !!saved))} onClick={() => void save()}><Save size={15}/>{session?.saveAsCopy && !saved ? `Save ${session.config.document.fileType === "docx" ? "Word" : "Excel"} copy to Drive` : "Save to Drive"}</button><button type="button" aria-label={`Close ${item.name}`} disabled={saving} onClick={() => dirty ? setClosing(true) : onClose()}><X size={16}/></button></header>
    {closing && <div className="ow-editor-message">This file has changes that haven't been saved to Drive.<button type="button" onClick={() => setClosing(false)}>Keep editing</button><button type="button" disabled={saving} onClick={onClose}>Close without saving</button></div>}
    {session?.saveAsCopy && <div className="ow-editor-message">{saved ? "Your Office copy is saved in My Drive. Further saves update that copy." : `You’re editing ${session.config.document.fileType === "docx" ? "a Word" : "an Excel"} copy. Save creates a new file in My Drive; the Google original stays unchanged.`}{saved && <a href={`https://drive.google.com/file/d/${encodeURIComponent(saved)}/view`} target="_blank" rel="noopener noreferrer">Open saved copy</a>}</div>}
    {!enabled && <div className="ow-editor-message">Documents is off for this workspace.</div>}
    {(error || query.isError || expired) && <div className="ow-editor-message" role="alert">{expired ? "This editing session expired. Download your changes from the editor before closing it." : error ?? (query.error instanceof Error ? query.error.message : "Couldn't open the full editor.")}{!session && item.openUrl && <a href={item.openUrl} target="_blank" rel="noopener noreferrer">Open in Drive</a>}</div>}
    {!session && query.isPending && <div className="ow-documents-skeleton" aria-label="Opening full editor" aria-busy="true"><div/><div/><div/></div>}
    {session && <div className="ow-office-canvas" inert={saving || !enabled} aria-busy={saving}><OfficeCanvas session={session} onChange={changed} onReady={engineReady} onError={engineError}/></div>}
  </section>
}

function OfficeCanvas({ session, onChange, onReady, onError }: { session: OfficeSession; onChange(value: boolean): void; onReady(): void; onError(): void }) {
  const id = `office-${useId().replace(/:/g, "")}`
  useEffect(() => {
    let cancelled = false; let engine: Engine | undefined
    void loadEngine(session.serverUrl).then(() => {
      if (cancelled || !window.DocsAPI) return
      engine = new window.DocsAPI.DocEditor(id, { ...session.config, events: { onDocumentReady: onReady, onDocumentStateChange: event => onChange(event.data), onError, onWarning: onError } })
    }).catch(onError)
    return () => { cancelled = true; engine?.destroyEditor() }
  }, [session, id, onChange, onReady, onError])
  return <div className="ow-office-mount"><div id={id}/></div>
}
