"use client"

import { useInfiniteQuery } from "@tanstack/react-query"
import { ChevronRight, ExternalLink, FileText, FileSpreadsheet, Image, Presentation, Folder, Grid2X2, Info, List, Lock, RefreshCw, Search, X } from "lucide-react"
import { useMemo, useState, type FormEvent } from "react"
import { DocumentsError, documentType, type DocumentItem, type DocumentsProvider } from "./index"

export type DocumentsBrowserProps = {
  provider: DocumentsProvider
  /** Include the authenticated organization and person. Never reuse a cache across identities. */
  scope: readonly string[]
  enabled: boolean
  connectionsHref?: string | null
}

function date(value: string | null) {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}
function size(value: number | null) {
  if (value === null) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}
function ItemIcon({ item }: { item: DocumentItem }) {
  const type = documentType(item)
  const Icon = item.kind === "folder" ? Folder : /Sheets|Excel|CSV/.test(type) ? FileSpreadsheet : /Slides|PowerPoint/.test(type) ? Presentation : type === "Image" ? Image : FileText
  return <Icon className="ow-documents-item-icon" data-kind={type} size={20} strokeWidth={1.5} aria-hidden />
}

/** A host-independent browser; providers own metadata reads and safe file-opening URLs. */
export function DocumentsBrowser({ provider, scope, enabled, connectionsHref }: DocumentsBrowserProps) {
  const [folders, setFolders] = useState([{ id: "root", name: provider.rootLabel }])
  const [draft, setDraft] = useState("")
  const [search, setSearch] = useState("")
  const [layout, setLayout] = useState<"list" | "grid">("list")
  const [selected, setSelected] = useState<DocumentItem | null>(null)
  const [order, setOrder] = useState<"name" | "modified">("name")
  const folder = folders[folders.length - 1]!
  const query = useInfiniteQuery({
    queryKey: ["documents", ...scope, provider.id, folder.id, search],
    queryFn: ({ pageParam, signal }) => provider.list({ folderId: folder.id, query: search, cursor: pageParam || undefined, signal }),
    initialPageParam: "",
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const items = useMemo(() => {
    const unique = new Map<string, DocumentItem>()
    for (const page of query.data?.pages ?? []) for (const item of page.items) unique.set(item.id, item)
    return [...unique.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1
      if (order === "modified") return (Date.parse(b.modifiedTime ?? "") || 0) - (Date.parse(a.modifiedTime ?? "") || 0)
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    })
  }, [query.data, order])
  const navigate = (index: number) => { setFolders(current => current.slice(0, index + 1)); setSelected(null); setSearch(""); setDraft("") }
  const open = (item: DocumentItem) => {
    if (item.kind === "folder") { setFolders(current => [...current, { id: item.id, name: item.name }]); setSearch(""); setDraft(""); setSelected(null) }
    else setSelected(item)
  }
  const submit = (event: FormEvent) => { event.preventDefault(); setSearch(draft.trim()); setSelected(null) }
  const blocked = query.error instanceof DocumentsError && [401, 403, 409].includes(query.error.status)
  // A failed revalidation must not leave a previously authorized file list or detail on screen.
  const visible = enabled && !query.isError
  return <section className="ow-documents" aria-label="Documents">
    <aside className="ow-documents-sidebar">
      <div className="ow-documents-source">{provider.id === "google-drive" && <svg viewBox="0 0 24 24" width="22" height="22" role="img" aria-label="Google Drive"><path fill="#0F9D58" d="M8 2h8l8 14h-8z"/><path fill="#F4B400" d="M8 2 0 16l4 7 8-14z"/><path fill="#4285F4" d="M4 23h16l4-7H8z"/></svg>}{provider.label}</div>
      <button type="button" className="ow-documents-location" onClick={() => navigate(0)}><Folder size={16} strokeWidth={1.5} aria-hidden />{provider.rootLabel}</button>
    </aside>
    <div className="ow-documents-main">
      <header className="ow-documents-toolbar">
        <form onSubmit={submit} role="search" className="ow-documents-search"><Search size={16} strokeWidth={1.5} aria-hidden /><input aria-label={`Search ${folder.name}`} placeholder={`Search in ${folder.name}`} value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} /><button type="submit">Search</button></form>
        <button type="button" title="Refresh documents" aria-label="Refresh documents" disabled={!enabled || query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} strokeWidth={1.5} /></button>
        <div className="ow-documents-layout" role="group" aria-label="Document view"><button type="button" aria-label="List view" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><List size={16} strokeWidth={1.5} /></button><button type="button" aria-label="Grid view" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><Grid2X2 size={16} strokeWidth={1.5} /></button></div>
      </header>
      <div className="ow-documents-heading"><nav aria-label="Folder breadcrumbs">{folders.map((entry, index) => <span key={`${entry.id}-${index}`}>{index > 0 && <ChevronRight size={14} aria-hidden />}<button type="button" onClick={() => navigate(index)} aria-current={index === folders.length - 1 ? "location" : undefined}>{entry.name}</button></span>)}</nav><label>Sort by <select aria-label="Sort documents" value={order} onChange={event => setOrder(event.target.value === "modified" ? "modified" : "name")}><option value="name">Name</option><option value="modified">Last modified</option></select></label></div>
      {search && <div className="ow-documents-notice">Results for “{search}” <button type="button" onClick={() => { setDraft(""); setSearch("") }}>Clear search</button></div>}
      {!enabled ? <div className="ow-documents-state"><Lock size={20} strokeWidth={1.5} /><p>Documents is off for your workspace. An admin can turn it on.</p></div>
        : query.isError ? <div className="ow-documents-state" role="status">{blocked && <Lock size={20} strokeWidth={1.5} />}<p>{blocked ? "Google Drive isn't available. Check your connection and Drive read permission." : "Couldn't load your documents."}</p>{blocked && connectionsHref && <a href={connectionsHref} target="_blank" rel="noopener noreferrer">Manage connections</a>}<button type="button" onClick={() => void query.refetch()}>Try again</button></div>
        : query.isPending ? <div className="ow-documents-skeleton" aria-label="Loading documents" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div key={index} />)}</div>
        : <><div className="ow-documents-content">
          <div className="ow-documents-listing">
            {layout === "list" ? <table><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Last modified</th><th scope="col">Size</th></tr></thead><tbody>{items.map(item => <tr key={item.id} data-selected={selected?.id === item.id}><td><button type="button" className="ow-documents-file" onClick={() => open(item)}><ItemIcon item={item} /><span>{item.name}</span></button></td><td>{documentType(item)}</td><td>{date(item.modifiedTime)}</td><td>{size(item.size)}</td></tr>)}</tbody></table>
              : <div className="ow-documents-grid">{items.map(item => <button type="button" key={item.id} className="ow-documents-tile" data-selected={selected?.id === item.id} onClick={() => open(item)}><ItemIcon item={item} /><strong>{item.name}</strong><span>{documentType(item)}</span></button>)}</div>}
            {items.length === 0 && <div className="ow-documents-state"><Folder size={24} strokeWidth={1.5} /><p>{search ? "No documents match your search." : "This folder is empty."}</p></div>}
            {query.hasNextPage && <button type="button" className="ow-documents-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</button>}
            {query.data?.pages.some(page => page.incomplete) && <p className="ow-documents-notice" role="status">Google couldn't search every drive. Some files may be missing.</p>}
          </div>
          {visible && selected && <aside className="ow-documents-detail" aria-label="Document details"><div className="ow-documents-detail-heading"><Info size={16} aria-hidden /><span>Details</span><button type="button" aria-label="Close document details" onClick={() => setSelected(null)}><X size={16} /></button></div><ItemIcon item={selected} /><h2>{selected.name}</h2><dl><dt>Type</dt><dd>{documentType(selected)}</dd><dt>Last modified</dt><dd>{date(selected.modifiedTime)}</dd><dt>Size</dt><dd>{size(selected.size)}</dd></dl>{selected.openUrl ? <a className="ow-documents-open" href={selected.openUrl} target="_blank" rel="noopener noreferrer">Open in {provider.label}<ExternalLink size={14} aria-hidden /></a> : <p>This file has no available link.</p>}</aside>}
        </div></>}
    </div>
  </section>
}
