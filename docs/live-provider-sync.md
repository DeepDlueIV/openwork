# Live provider sync (OpenCode v2)

`liveProviderSync` is one registry rollout, default **off**, available on cloud
and self-hosted deployments. It is not a second desktop preference or an
independent environment switch. Den resolves the registry for the signed-in
member's organization; an absent feature is off.

## Ownership

With the rollout enabled, the bundled OpenWork provider plugin owns the v2
AI Gateway catalog. It fetches the same member-visible inventory used by the
standalone `opencode-openwork` plugin and injects it through
`ctx.provider.transform`, not generated provider configuration. A changed
snapshot invokes `ctx.provider.reload()`. The pinned engine's
`provider.updated` / `model.updated` events invalidate the app's existing
provider-list query, including an already-open model picker. The adapter also
accepts `catalog.updated` for compatibility; that is **not** the event emitted
by OpenCode 2.0.26.

Den's SSE stream is an invalidation channel, not a second copy of inventory.
It sends `inventory.changed` with a content revision on connection and when
the member's effective inventory changes. The plugin refetches on every
invalidation and reconnect; an unchanged snapshot does not reload the engine.
A disconnected client can therefore recover without replay or a pub/sub
service. Heartbeats and a bounded reconnect loop detect broken streams.

### Revision dependency check

The revision is a member/org-scoped HMAC over batched persisted dependencies
in a repeatable-read, read-only transaction: providers, complete model config,
model groups and links, credential sets, access grants, the member's live team
memberships, relevant organization/member credentials, and the member's
gateway keys. Credential expiry and AWS client expiry add readiness booleans,
not the wall clock, so time-only loss of readiness also invalidates inventory.
The stream rechecks the current auth session, membership and uncached registry
rollout on every read. Only the opaque revision leaves Den.

This deliberately favors complete dependency coverage over `MAX(updated_at)`
or a stored provider counter: those miss indirect grant/team writes, deletions,
key rotations and config-only changes. It avoids per-provider summary/connect
calls, upstream requests and gateway-key issuance during revision checks.
Organization-indexed batches are cheaper than rebuilding every provider's
member summary, but still scale with the organization's stored catalog, and
unrelated provider edits can conservatively trigger a harmless refetch. This
is not a claim of constant-time revision checking.

The old server materialization/push/confirm and app refresh triggers remain
in place for the flag-off path and OpenCode v1. Local/legacy providers keep
their existing path; MCP synchronization is independent of this rollout.
The desktop reads the same `/v1/me/desktop-config` surface as organization
default models, then uses the server's effective v2 ownership status rather
than independently flipping the app when a cached rollout value changes.
On signed-in cold boot, late session hydration can activate the live source
through one watched-config rewrite that simultaneously removes old gateway
rows and registers the bundled plugin. This activation is one-way for that
engine lifetime.

## Credentials and account boundaries

Desktop uses its existing Den session, not a second device login. A private
loopback bridge exposes the current session only to the managed engine,
authenticated by a per-engine random capability passed in the child process
environment. The dormant bridge returns no session until live ownership is
selected, which permits late sign-in without giving a flag-off engine Den
credentials. No Den session token is written into `opencode.json`, plugin
options, a URL, or a command line. The capability is a credential too: never
log it. A loopback listener without authentication is not an acceptable
substitute.

The provider cache contains a gateway snapshot, including the gateway key,
just as the standalone plugin's private storage does. It must be account- and
organization-scoped. It is not repository data. Session replacement must
cancel the old stream and fence its pending fetches so one identity cannot
publish after another signs in. Den authorization continues to be enforced
on every inference request; a cached catalog does not grant access.

## Timing and limits

The target is roughly two seconds from a committed Den inventory change to
picker invalidation on a healthy local connection. The server checks every
two seconds, so this is an eventual-consistency target, not a strict
2,000 ms upper bound: database work, inventory requests, engine reload and
rendering add latency. Disconnected clients retain their last usable
snapshot until reconnection; they cannot truthfully promise zero staleness.
The important invariant is one active catalog owner and convergence after
every invalidation or reconnect, not an impossible guarantee of instantaneous
consistency during a network partition.

## Kill switch

The registry kill switch rejects new stream connections and causes active
streams to end on their next authorization/feature check. It does not cancel
an in-flight model request or delete chat history. The engine's selected
catalog owner must remain consistent for its lifetime: do not enable the old
writer alongside a still-loaded live plugin. At minimum, the next engine
start resolves the rollout again from fresh desktop-config hydration and
restores the complete legacy path when off. If Den cannot be verified, this
feature defaults off for the new engine while existing offline model-access
and permission policies are retained. A running engine may retain its last
snapshot until that restart;
revoked gateway access is still rejected by Den. Restart the engine to finish
a rollback immediately.

## Premise review

Reviewed against OpenCode `v2.0.26`, upstream commit
`9b4ec5714d481559990db0a816d5dec19541a814`:

1. **Reload notification — adapted.** `ctx.provider.reload()` forwards to the
   provider state reload. It publishes `provider.updated`, which also
   invalidates model state and publishes `model.updated`. The server event
   feed serializes these names unchanged. The desktop previously listened
   only for `catalog.updated`; that assumption does not hold at this pin.
2. **Composition — qualified.** Provider reload rebuilds all source transforms,
   then model transforms inspect the complete active provider inventory. The
   bundled final `ConfigPolicy` can remove providers. But the bundled
   `ConfigProvider` model transform runs after external model filters and can
   recreate explicitly configured models. Keeping live-owned providers out of
   generated config is a correctness and policy requirement, not an
   optimization. Preserve filter rules independently of mirrored models.
3. **Credential hand-off — adapted.** The standalone plugin expects its own
   OpenCode OAuth connection. Desktop instead supplies its current in-memory
   Den session through a dedicated loopback capability. This intentionally
   grants the trusted bundled plugin the member's Den session authority;
   it does not grant the broader OpenWork server host token. Desktop does
   not enable the standalone plugin's sign-in or MCP integration.

Upstream source: [provider state](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/provider.ts),
[model state](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/model.ts),
[config providers](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/config/plugin/provider.ts),
[policy](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/config/plugin/policy.ts).

## Verification

- `ee/apps/den-api/test/provider-inventory.test.ts`: dependency revisions,
  time-only readiness, SSE framing, heartbeats, cancellation and authorization
  failure.
- `packages/opencode-plugin/src/*.test.ts`: subscriptions shared by Locations,
  reconnects, retry convergence, idempotency and account/authentication fences;
  standalone sign-in and MCP regression coverage.
- `apps/server/test/live-provider-sync.test.ts`: on/off ownership, legacy
  polling isolation, generated-config filtering and the credential boundary.
- `apps/server/test/live-provider-sync-native.test.ts`: actual bundled plugin
  and filters on pinned v2, native events, unchanged config, reconnects,
  revocation, account replacement and sign-out. Run on both Bun and desktop
  Electron Node; absent engine binaries explicitly skip.
- `apps/app/tests/live-provider-sync*.test.ts` and
  `provider-catalog-live-events.test.ts`: effective-owner gating, session
  delivery and event invalidation without changing the flag-off path.
- `evals/proofs/live-provider-sync.proof.test.ts`: real Den administrator
  model enable/disable writes reaching the already-open v2 model picker,
  without navigation or periodic provider sync, with a five-second deadline.

## Compatibility

The standalone npm plugin retains its own device-login integration. The
desktop entry only supplies provider inventory; it must not duplicate desktop
MCP registration or add a second account selector. Provider/model transforms
compose with the bundled model policy filters, so live injection must not
bypass disabled providers, allowlists or denylists.
