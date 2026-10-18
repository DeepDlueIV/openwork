import { WorkbotScreen, DOCUMENT_RECOVERY_MS, type WorkbotHost } from "@openwork-ee/workbot-ui"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { createHost, fetchMe, signIn, type Me } from "./host"
import "./styles.css"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
const action = "rounded-full bg-[var(--wb-chip)] px-4 py-2 text-[14px] text-[var(--wb-text)] focus-visible:outline focus-visible:outline-2"
const sameIdentity = (left: Me, right: Me) => left.userId === right.userId && left.organizationId === right.organizationId

function Signed({ me, authorization, refreshIdentity }: { me: Me; authorization?: WorkbotHost["documentAuthorization"]; refreshIdentity(): Promise<Me | null> }) {
  const host = useMemo(() => createHost(me, { authorization, refreshIdentity }), [me, authorization, refreshIdentity])
  return <WorkbotScreen host={host} />
}

function App() {
  const me = useQuery({ queryKey: ["workbot", "me"], queryFn: fetchMe, staleTime: 60_000, refetchOnReconnect: "always" })
  const [owner, setOwner] = useState<Me | null>(null)
  const [until, setUntil] = useState<number | null>(null)
  const changedIdentity = owner !== null && me.data != null && !sameIdentity(owner, me.data)
  const identityUnavailable = me.isError || me.failureCount > 0
  const verified = me.isSuccess && !identityUnavailable && me.data != null && !changedIdentity
  const blocked = owner !== null && !verified
  useEffect(() => {
    // A successful response for another person must not replace a draft's owner.
    const next = me.data
    if (!me.isSuccess || identityUnavailable || !next) return
    setOwner(current => current === null || sameIdentity(current, next) ? next : current)
  }, [me.isSuccess, me.data, identityUnavailable, owner])
  useEffect(() => {
    if (!blocked) { setUntil(null); return }
    setUntil(current => current ?? Date.now() + DOCUMENT_RECOVERY_MS)
  }, [blocked])
  useEffect(() => {
    if (until === null) return
    const timer = setTimeout(() => setOwner(null), Math.max(0, until - Date.now()))
    return () => clearTimeout(timer)
  }, [until])
  useEffect(() => {
    if (owner === null && me.isSuccess && me.data === null) signIn()
  }, [owner, me.isSuccess, me.data])
  const refreshIdentity = useCallback(async () => {
    const result = await me.refetch()
    return result.isSuccess ? result.data ?? null : null
  }, [me.refetch])
  if (owner !== null) {
    const authorization = blocked ? identityUnavailable ? "blocked" : "signin" : undefined
    // Hidden, not conditionally removed: auth revalidation cannot run editor teardown.
    return <>
      <div className="h-full" hidden={blocked} data-workbot-retained-owner><Signed key={JSON.stringify([owner.organizationId, owner.userId])} me={owner} authorization={authorization} refreshIdentity={refreshIdentity} /></div>
      {blocked && <main className="workbot grid h-full place-items-center px-6 text-center" role="status" aria-label="Workspace sign-in recovery"><div className="flex max-w-sm flex-col items-center gap-3">
        <p className="text-[14px] text-[var(--wb-text)]">{changedIdentity ? "The signed-in account or workspace changed. Retained documents are locked." : identityUnavailable ? "Couldn't verify this workspace. Retained documents are locked." : "Sign in again to restore this workspace."}</p>
        <span className="text-[13px] text-[var(--wb-muted)]">Recovery is held here for at most 15 minutes.</span>
        <a className={action} href={`/auth/login?return=${encodeURIComponent(window.location.pathname + window.location.search)}`} target="_blank" rel="noopener noreferrer">Sign in again</a>
        <button type="button" className={action} disabled={me.isFetching} onClick={() => void me.refetch()}>Check sign-in</button>
      </div></main>}
    </>
  }
  if (me.isError) return <main className="workbot grid h-full place-items-center px-6 text-center"><div className="max-w-sm"><p className="text-[14px] text-[var(--wb-text)]">Workbot can't reach OpenWork right now.</p><button type="button" className={action} onClick={() => void me.refetch()}>Try again</button></div></main>
  return null
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}
