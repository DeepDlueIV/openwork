# Admin organization inventory response ordering

Spec: `evals/specs/den-admin-organization-race.e2e.test.ts`.

This focused world isolates the Den admin navigation race encountered by the
native-Slack rollout journey, without starting Slack, inference, or app engines.
It uses real Den-web, Den API, a scratch database, two synthetic organizations,
and a platform-admin browser signed in through the real password endpoint.
All identity setup and transport instrumentation happen before the first act.

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

The transport only uses CDP response inspection and continuation. It does not
fulfill fabricated bodies, mutate React state, bypass authorization, or reseed
identity after user actions. Evidence retains counts/statuses, not cookies or
response bodies. No `probe.eval`, raw CDP, or filesystem access occurs in the spec.

On the unfixed product, the last step observes `rows: 0, busy: false`, and the
screen reports **page 1–0 of 2** with an empty filter. Starting a live organization
load now supersedes the pending overview; the live load retains its existing
401/403 handling. Merely reusing cached tab data does not invalidate the overview.
This implements DESIGN.md P1 (truthful state) and P11 (keep the user's rows).

Run: `pnpm evals:e2e den-admin-organization-race --local` when local execution is
approved. The world declares `[web]`, not `[appWeb]`; no app engine or `--surface`
selection is needed. The original native-Slack journey remains unchanged and
still requires nonempty, nonbusy inventory before typing its organization filter.
