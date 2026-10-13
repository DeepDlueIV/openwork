# Admin organization inventory response ordering

Spec: `evals/specs/den-admin-organization-race.e2e.test.ts`.

This focused world isolates the Den admin navigation race encountered by the
native-Slack rollout journey, without starting Slack, inference, or app engines.
It uses real Den-web, Den API, a scratch database, two synthetic organizations,
and a platform-admin browser signed in through the real password endpoint.
Initial identity setup and transport instrumentation happen before the first act.
The denial cases later revoke actual server authority using supported Den endpoints.

## Witness

1. Visit `/admin` to warm its own overview cache. Observe the real HTTP 200
   overview: total organizations = 2, deferred organization rows = 0. Navigate
   to `/admin/features`; do not inject or modify browser storage.
2. Return to `/admin`, holding the actual overview response at Chrome's response
   boundary, after server authorization. Click **Organizations (2)** through the
   normal UI. Observe the real organization endpoint return HTTP 200 with two
   rows, and both rendered rows, while the older overview remains held.
3. Continue the original overview response unchanged. Sample the rendered rows
   for one second and require both rows to remain, with no busy state. Capture
   the before-release and after-release screens and count/status witnesses.

On the original row-race bug, the last step observes `rows: 0, busy: false`, and
the screen reports **page 1–0 of 2** with an empty filter. Starting a live
organization load supersedes older successful overview data. Merely reusing
cached tab data does not invalidate the overview.

## Denial witnesses

Each of HTTP 401 and HTTP 403 runs with both a failed and an aborted newer
organization read:

1. Warm `/admin` through its real overview, including its own sessionStorage cache.
2. Revoke both genuine credentials the browser carries (its cookie session and
   testkit's bearer session) with the real sign-out endpoint (401), or
   have a second synthetic platform admin remove its allowlist entry with the
   real admin DELETE endpoint (403). Click **Refresh**. Hold the genuine denial
   after Den authorization; do not replace its status, headers or body.
3. Click **Organizations (2)**, starting a newer component request. Either fail
   this request with a CDP connection reset, or hold it until clicking **Users**
   invokes the component's own AbortController. Require Chrome's
   `Network.loadingFailed` witness, including `canceled: true` for the latter.
   The newer request must deliver no HTTP response. Observe that the cached
   backoffice is still visible before releasing the older denial.
4. Release the original 401/403 unchanged. Require **Sign in required** or
   **Admin access required**, no backoffice/rows, and no persisted admin cache.
5. Reopen `/admin` through Next client navigation (same document/module cache),
   then through a full document reload (persisted cache), holding the next
   genuine denial each time. Require the empty loading skeleton, zero data rows
   and organization controls, and no cache before the denial reaches the component.
   The skeleton's static **User backoffice** heading is not an admin payload.

Overview 401/403 handling must run before the stale-data guard: it clears both
admin caches, changes access state and discards the payload. A newer organization
read is not a substitute authorization witness when it fails or is aborted. The
guard still discards stale successful overview data, preserving the row-race fix.

The fixture uses CDP response inspection/continuation, organization request
faults, network failure observation and read-only sessionStorage inspection.
It never fulfills fabricated bodies, mutates React state/storage, bypasses
authorization, or substitutes an identity. Evidence retains counts/statuses
and booleans, not cookies or response bodies. No `probe.eval`, raw CDP, or
filesystem access occurs in the spec.

The ordering rule preserves DESIGN.md P1 (truthful access state), P4 (existing
blocked state names the permission problem), and P11 (keep authorized newer rows).

Run: `pnpm evals:e2e den-admin-organization-race --local` when local execution is
approved. The world declares `[web]`, not `[appWeb]`; no app engine or `--surface`
selection is needed. The original native-Slack journey remains unchanged and
still requires nonempty, nonbusy inventory before typing its organization filter.
