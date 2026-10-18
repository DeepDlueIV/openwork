# Workbot's explicit Luna default

`workbotLunaDefault` is off by default on cloud and self-hosted deployments. It
also requires `workbot`. With it on, an organization without a saved model uses
an explicit GPT-6 Luna model from the configured runner's authorized catalog.
An exact canonical ID or exact display name identifies Luna; ambiguous aliases
are refused rather than choosing a provider arbitrarily. A saved organization
choice always wins, even when unavailable: Workbot never silently replaces it.
Slack and Automations retain their existing default policy.

## Readiness and recovery

Den's existing Manage → Workbot page shows **Default: GPT-6 Luna** and a compact
availability row. **Check availability** reads the runner catalog. The runner
marks a catalog verified only after its configured gateway accepts its model
key. Its configured fallback alone, an older runner, a missing key, or a failed
read cannot establish readiness. An empty authorized catalog never verifies
the legacy configured fallback (which remains listed for old clients).
The runner caches a successful gateway catalog for at most five minutes; Den
caches turn reads for one minute and bypasses its cache for an admin check.

This is an authenticated model-access check, not a paid completion, tool-call,
quota, balance, or provider-uptime guarantee. `/health` remains liveness, not
proof that an answer can run. Do not claim a production deployment is ready
from a localhost fixture or a green health response.

Before starting a new answer, Workbot checks the actual runner's verified
catalog for the explicit model. When it cannot verify that model, it does not
send on a different model. The failure asks the person to have their workspace
admin check the model. The edit route preflights before removing later turns.
History reads, files, active turns and stored model choices are not removed by
this rollout. Turning off `workbotLunaDefault` restores the old next-turn
routing and hides the new readiness row; it does not clear organization
metadata or restart conversations. Workbot's existing Den-session cache can
delay a changed model or rollout by up to 30 seconds. Existing accepted turns retain their
runner-stored model, including when resumed after interruption.

## Deployment owner confirmation before Monday

No environment or rollout is changed by this work. The deployment owner must
confirm these names on the intended deployment, privately, without copying
values or credentials into a PR, log, screenshot, or chat:

- Runner model route and its Luna binding: `HEADLESS_MODEL_PROTOCOL`,
  `HEADLESS_MODEL_BASE_URL`, `HEADLESS_MODEL`, `HEADLESS_MODEL_API_KEY`.
- Den's runner connection: `DEN_HEADLESS_RUNNER_URL`,
  `DEN_HEADLESS_RUNNER_TOKEN`.
- Workbot's runner connection: `WORKBOT_RUNNER_URL`, `WORKBOT_RUNNER_TOKEN`.
- Workbot's Den connection: `WORKBOT_DEN_API_URL`.
- Existing cost-exposure controls to review, not change here:
  `HEADLESS_MAX_CONCURRENT_TURNS`, `HEADLESS_MAX_STEPS`,
  `HEADLESS_MAX_OUTPUT_TOKENS`.

Confirm that Den and Workbot point at the same intended runner and that its
authorized alias really maps to Luna. Confirm the runner default as well:
conversation naming uses that configured model independently of answer routing.
Then the owner can check the actual admin readiness state and run a separately
approved completion before deciding whether to enable the rollout. A missing
or ambiguous Luna alias must remain unavailable; do not substitute a provider
or turn on the feature to conceal a readiness failure.

## Shared-key usage risk — budget system deferred

The current runner uses one deployment model key unless a caller supplies its
own. Its MCP token scopes connected-app access; that token is not a per-member
inference credential or a spend allowance.

Existing protections are not durable monetary budgets:

- Workbot's 30-message/10-minute/member throttle lives in a process-local Map;
  restarting or scaling the app does not preserve a single shared allowance.
- Den's 120 run-token throttle is **already database-backed**, keyed by
  organization and user (`checkRateLimit` / `RateLimitTable`). It survives app
  process restarts. It limits token minting, not inference tokens or dollars.
- Runner concurrency defaults to 32. Step count is unbounded by default and
  output length is bounded per model call, not per member or billing period.
  Greetings, retries, resumed turns, background tasks and conversation naming
  can consume inference beyond one visible send.

The Gateway's existing paid usage limits require an authenticated organization
and member scope plus admission snapshots and idempotent settlement. Free
member allowances require the member's active inference key, joined membership
and free-policy checks; they are a distinct entitlement, not a general budget
for the runner's shared credential. Neither can safely be charged to a member
by adding an untrusted header or by counting Workbot sends. Reusing them here
would need trusted delegation for every model call, including helper work,
and defined accounting on crashes, retries, missing usage and concurrent work.
That is not a small safe routing change, so this change adds no billing system
and claims no durable per-member spend protection.

Options for the owner:

1. Keep this rollout off until shared-key exposure is explicitly accepted and
   the actual provider-side cap, alerting and operating limits are confirmed.
   Those controls are deployment-wide, not member fairness or a hard guarantee.
2. Follow up with member-scoped Gateway delegation and reuse its existing
   usage-limit admission/settlement primitives at each inference request.
   Define what greetings and helper work debit and how concurrent overshoot is
   bounded. Treat unknown accounting as blocked, not free usage.
3. If only abuse throttling is required, separately reuse Den's durable rate
   limit primitive for member turn admission across replicas. Name it a request
   throttle, not a monetary or token budget; it does not address unlimited steps.

No new schema, migration, provider call, credential lookup or production data
is needed for this implementation or its deterministic local tests.
