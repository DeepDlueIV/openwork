# OpenWork Web session sandboxes — issue #5914

Status: **blocked design; not implemented or available for rollout**.
Inspected against `origin/dev` at `fa18c46d70` on 2026-10-14.
This document records the current runtime boundaries and the decisions needed
before replacing persistent member workers. It is not an isolation guarantee,
an installer instruction, or a claim that a provider has been provisioned.

## Current behavior

OpenWork Web runs native OpenCode sessions inside an OpenWork server on a
member's Cloud worker. It does **not** currently allocate a clean computer for
each Web conversation. Workspace IDs and native session IDs do not identify
independent OS security boundaries.

| Boundary | Current implementation | Consequence for #5914 |
| --- | --- | --- |
| Worker ownership | `ee/apps/den-api/src/routes/cloud/index.ts`: `databaseCloudWorkerStore.getCloudWorker`, `ensureMemberCloudWorker` | Lookup and first-use convergence are by organization and user, not conversation. Changing only the instance name cannot create a per-session route. |
| Web routing | `ee/apps/den-gateway/src/app.ts`: `resolveFromDenApi`, `resolveInstance`, `handleProxy` | Resolution sends the member bearer to `/v1/cloud/gateway/resolve`; the ready cache is keyed by that bearer. Requests for two session IDs currently resolve to the same worker. |
| Non-session APIs | `ee/apps/den-gateway/src/app.ts`: `proxyPathNamespaces`, `alwaysProxyPathPrefixes` | Workspaces, files, environment, approvals, engine events, settings, terminals and runtime APIs also go to the member worker. A session-only URL rewrite leaves these operations ambiguous. |
| Runtime records | `ee/packages/den-db/src/schema/workers.ts`: `CloudRuntimeInstanceTable`, `WorkerTokenTable` | An instance is unique by worker ID, and client/host/activity credentials belong to that worker. There is no Web conversation-to-worker allocation record here. |
| Files and checkpoints | `ee/packages/cloud-runtime/src/orchestrator/orchestrator.ts`: `workerVolumeSubpaths`, `storageAttachments` | Persistent data uses `workers/<workerId>/workspace` and `workers/<workerId>/data` on the configured volume. Two native sessions on that worker inherit the same mounts. |
| Native history | `ee/packages/cloud-runtime/src/bootstrap/openwork-runtime.ts`: `checkpointEnvironmentScript`, `flush_checkpoint`, `hydrate_checkpoint` | History is in the engine's local SQLite state and periodic worker checkpoints, not an independent Den Web transcript archive. Checkpoints include the runtime workspace and engine state. |
| Idle lifecycle | `ee/apps/den-api/src/workers/cloud-lifecycle.ts`: `listIdleWorkers`, `reserveIdleStop`; orchestrator `stop` | Idle policy is worker-scoped. Stop preserves the sandbox disk and volumes for wake; it is not destruction or a fresh environment. |
| Destruction | Orchestrator `deprovision`, `eraseWorkerData` | Deprovision destroys compute **and erases worker workspace/data subpaths**. It is not an archive-then-destroy operation. Destruction/erasure failures are logged rather than durably tracked as pending cleanup. |
| MCP Cloud sessions | `ee/apps/den-api/src/mcp/remote-session-capabilities.ts`: `defaultResolveRuntime`, `resolveRemoteSessionWorkspace` | Cloud create/read/send resolve the same member worker. Browser-only changes would leave a second admission/control path on the old lifecycle. |

The root `ARCHITECTURE.md` does not exist in this revision. The app's active
route/state ownership is documented in
[`apps/app/src/react-app/ARCHITECTURE.md`](../apps/app/src/react-app/ARCHITECTURE.md).
[`session-offloading-architecture.md`](session-offloading-architecture.md)
describes registered/desktop delivery, not a Web sandbox allocation protocol.
[`remote-chat-over-mcp-architecture.md`](remote-chat-over-mcp-architecture.md)
describes the existing Cloud worker path and is marked as a proposal.

### A different existing execution model

[`ee/apps/headless-runner/README.md`](../ee/apps/headless-runner/README.md)
already separates conversation storage from an optional computer.
`ee/packages/headless-computer/src/computer.ts` uses the existing
`@openwork/sandbox` provider contract: one VM identity per session, no worker
mounts, an empty environment, and no exposed ports. Provider credentials stay
outside the VM. Saved files are separately scoped by session.

This is a useful abstraction to reuse, **not an implementation of #5914**:

- OpenWork Web currently uses the native OpenCode/OpenWork server contract,
  not the headless runner's turn API.
- Headless computers pause on idle and have a retention window; they are not
  destroyed after every completed turn.
- Headless tools and session storage are not interchangeable with native
  OpenCode plugins, permissions, terminals and workspace APIs.
- An idle timer alone does not establish reliable cleanup after process death.

## Decisions required before implementation

### 1. Which session engine and durable history contract?

**Recommendation: keep native OpenCode for this issue**, because the request is
for isolation of the existing Web execution surface, not an engine migration.
Reuse `CloudRuntimeOrchestrator` and `SandboxProvider` for compute. Add an
owner-scoped Web conversation/allocation record and a separately readable,
versioned transcript/artifact archive before enabling destructive lifecycle.
Do not use the registered-desktop command receipt tables as a replacement
conversation database: bounded summaries/control receipts are not the native
history or the user's files.

An owner must approve where that archive lives, its retention/deletion policy,
and whether reopening an ended conversation is read-only or creates a new
clean execution generation. This is a data-ownership contract: preserving
messages while destroying an untrusted filesystem cannot be implemented by
restoring the current whole-worker checkpoint into the next clean sandbox.

The alternative is an explicit Web engine migration to the headless runner,
reusing its credentialless computer and saved-file contracts. That requires a
separate parity decision, not a hidden fallback when native provisioning fails.

### 2. What ends a conversation's execution lifetime?

A completed assistant turn is not necessarily the end of a conversation.
People send follow-ups, answer approval questions, and leave background work
running. Closing a browser tab is not a reliable termination signal either.

**Recommended policy for approval:** explicit end or a configured inactivity
lease ends an execution generation; a model turn finishing does not. Running
turns, outstanding approvals/questions, admitted uploads and owned background
jobs prevent idle teardown. Reopening history must not implicitly restore a
terminated machine or auto-rerun a prompt. If a follow-up creates a clean
generation, the UI must report the loss of temporary files/processes honestly.
Confirm which inputs and explicitly saved outputs may be copied into it.

These decisions cannot be replaced by choosing a shorter provider auto-delete
time. Auto-delete can otherwise remove the only history before it is archived.

## Required implementation boundaries

The following is a proposed implementation sequence, not shipped behavior.

1. **Declare `webSessionSandboxes`, cloud-only, default false, before feature
   code.** Do not add an unused registry entry just to advertise this design.
   Generate Helm/Den/SDK contracts with `pnpm features:sync` / `pnpm den:contract`
   when the implementation adds the feature and routes. Self-hosted support is
   a separate supported-provider/storage rollout, not implied by Web opt-in.
2. **Durable admission before provider effects.** Allocate an owner-bound
   conversation ID and generation with a unique idempotency key before
   provisioning or native session creation. Record native workspace/session
   receipts. Compare retry arguments; do not repeat an uncertain creation or
   prompt send. Concurrent replicas must converge through the database, not
   an in-memory promise map alone.
3. **One compute allocation per admitted generation.** Give it a distinct
   worker/provider identity and host/client/activity credentials. No shared
   workspace/data mount or checkpoint from another session. The provider key,
   archive-store credentials and other sessions' endpoints must not enter the
   guest. Audit model/MCP credential materialization and persistence exclusions;
   separate token strings alone do not make copied member/provider API keys
   session-revocable. Do not promise protection from authorized external
   side effects or a provider compromise.
4. **End-to-end routing before exposing admission.** Authorize organization,
   current membership, owner, conversation and generation on every control or
   data request. Bind session-scoped files, approvals, terminals and events to
   that allocation. Route workspace-level preferences and the conversation
   index through the control plane. Cache by authenticated allocation and
   generation, with revocation semantics; a caller-selected session ID is not
   authority. Two tabs/split chats must never share an implicit "active worker"
   slot. Apply the same binding to MCP Cloud create/list/read/send/stop.
5. **History outlives compute.** Persist transcript and saved artifacts outside
   the guest; test reads/downloads after the VM is confirmed absent. Archive
   commit must be acknowledged before planned destruction. Never restore the
   whole old filesystem to claim a fresh environment. Define crash recovery's
   last acknowledged durable point and explicitly surface incomplete history.
6. **Separate compute teardown from user-data deletion.** Existing
   `deprovision()` is a worker deletion primitive and must not be called as the
   session archive operation. Persist cleanup intent and stage results, revoke
   the allocation's credentials/routes, then retry provider destruction and
   temporary storage erasure with bounded backoff. A reconciler must recover
   after process crashes, lost responses, provider timeouts and orphan creates.
   Report cleanup pending until absence is confirmed; never infer successful
   destruction from a logged/caught error.
7. **Kill switch without security downgrade.** Disabling the feature prevents
   new isolated admissions. Existing isolated conversations keep their binding,
   history reads, archive and cleanup. They must never be redirected to the
   legacy shared worker. Legacy conversations remain on their old worker until
   an explicit migration; no workspace-wide checkpoint import into a clean
   session. Running generations drain under their original protocol.

## Verification required to close #5914

Use headless Web and a deterministic provider witness first, then an explicitly
authorized disposable provider project. A fake provider's disjoint maps do not
prove OS/filesystem/process isolation or live cleanup.

- With the feature off, existing Web/MCP worker behavior is unchanged. With it
  on but the provider, archive or required image unavailable, admission reports
  a recoverable blocked state; it never executes in a shared worker.
- In one workspace and member account, start two real native sessions. Witness
  distinct provider references, worker credentials and storage scopes. Write a
  unique file, install a dependency, set an environment variable, start a
  background process and bind a port in A. B cannot observe any of them and can
  independently bind the same port. Repeat with sequential sessions.
- Negative ownership tests cover another member, another organization, a
  removed member, forged headers/session IDs, a stale generation and a copied
  old route credential. Include the event stream, files, terminal and MCP
  controls, not only the chat prompt URL.
- Finish/end A and expire B through the supported lease path. Confirm provider
  resources are absent, tokens/routes no longer work, and archived messages and
  saved artifact bytes remain readable by their owner. Archive failure must
  block planned destruction and remain recoverable; arbitrary guest secret
  files must not become saved artifacts automatically.
- Crash at each admission/archive/cleanup boundary; retry after an ambiguous
  provider response, then restart the API on another replica. Verify one
  allocation, no duplicated prompt effects, recoverable cleanup and no cross-
  session restoration. Turning the feature off mid-run must preserve binding.
- Measure request-to-ready latency, including provider create, runtime boot,
  health, credential delivery and native-session admission. Record cold/warm
  sample counts and percentiles. A provider's advertised VM create time is not
  evidence for the issue's <500 ms end-to-end target.

## Investigation checks (not feature acceptance tests)

Two local, browser-less probes exercised the actual gateway/orchestrator
functions with synthetic HTTP/provider witnesses:

- `createGatewayApp`: two different native-session message-read paths returned
  200/200, issued one member resolution, and used the same upstream and worker
  client/host credentials. No real session or model was started. This confirms
  the current routing boundary; it does not prove isolation.
- `createCloudRuntimeOrchestrator`: `stop` called only provider stop;
  `deprovision` called provider destroy and erasure of both
  `workers/<workerId>/workspace` and `workers/<workerId>/data`. The provider
  witness recorded effects without touching a VM or a volume.

`pnpm --filter @openwork-ee/cloud-runtime... --filter @openwork-ee/den-gateway... -r build`
passed for the four selected packages (sandbox, utils, cloud-runtime and
Den gateway). These packages are unmodified; this only verifies the inspected
baseline builds. `git diff --check` passed. No new regression/E2E test is claimed,
no UI was changed, and no headless Web/provider integration journey was run.
No contract regeneration is needed for these documentation-only changes.

## Outcome of this investigation

No lifecycle, routing, schema, UI, feature registry or infrastructure behavior
was changed. No live sandbox was created or destroyed. The issue is **not
implemented**, and the two-isolated-sessions, retained-history-after-destruction
and latency acceptance tests have **not passed**. The precise blocking decision
is approval of the native-engine archive/reopen contract and execution-lifetime
policy above. After that, the missing admission/archive/routing/reconciliation
work is implementation work, not an operator configuration toggle.
