import type { Me } from "./host"

/** A disabled workspace is a policy decision, not a failed sign-in. Only platform admins can change its rollout. */
export function WorkspaceAccess({ me }: { me: Me }) {
  const features = me.denUrl && me.organizationId
    ? new URL(`/admin/organizations/${encodeURIComponent(me.organizationId)}/features`, me.denUrl).toString()
    : null
  return (
    <main className="workbot grid h-full place-items-center px-6 text-[var(--wb-text)]" data-testid="workbot-workspace-access">
      <section className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex items-center gap-2 text-sm font-medium"><img src="/favicon.svg" alt="" width={20} height={20} />Workbot</div>
        <h1 className="text-lg font-semibold tracking-tight">Workbot is off for {me.organizationName}</h1>
        <p className="text-sm text-[var(--wb-muted)]">{me.canEnableWorkbot ? "Turn on Workbot in this workspace’s feature settings. If the switch is locked, ask your installation administrator." : "Ask your workspace owner or platform administrator to turn on Workbot for this workspace."}</p>
        {me.canEnableWorkbot && features ? (
          <a href={features} className="rounded-lg bg-[var(--wb-ink)] px-4 py-2.5 text-center text-sm font-medium text-[var(--wb-on-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]">Open workspace feature settings</a>
        ) : (
          <a href="/auth/login" className="rounded-lg bg-[var(--wb-ink)] px-4 py-2.5 text-center text-sm font-medium text-[var(--wb-on-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]">Choose another workspace</a>
        )}
        {me.canEnableWorkbot && features ? <a href="/auth/login" className="text-sm underline underline-offset-4">Choose another workspace</a> : null}
      </section>
    </main>
  )
}
