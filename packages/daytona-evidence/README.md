# @openwork/daytona-evidence

The web evidence world (`core-chat`, tests tagged `checkpoints`) on Daytona
Linux VMs, selected with `OPENWORK_EVIDENCE_PROVIDER=daytona`. It runs the same
steps inside the VM as `@openwork/freestyle`'s evidence builder.

Layers, each cached as a Daytona snapshot:

| Layer | Contents | Saved as |
|---|---|---|
| `ow-dy-base-ubuntu2404-*` | Ubuntu 24.04 + Node 24 + Bun, 4 CPU / 8 GB / 10 GB | files |
| `ow-dy-evidence-image-v1-*` | tools, Chrome, MySQL, full install at a dev commit | files |
| `ow-dy-evidence-web-v1-*` | this commit built, booted and signed in | files and memory |

A test starts a copy of the commit's world; its processes resume where the
snapshot was taken. The runner drives Chrome through Daytona's private URL for
port 8081 (Daytona token + the in-VM gateway's access cookie). Port 8080 is the
viewer.

- Needs `DAYTONA_API_KEY` for an organization with Linux VMs in
  `OPENWORK_DAYTONA_EVIDENCE_REGION` (default `us-west-3`).
- Builds: `node scripts/prepare-evidence-web.ts` with the provider set.
- Required snapshot saves retry only a definite `Snapshot quota exceeded` rejection,
  for at most 17 attempts over 16 minutes (including provider call time). Jittered
  waits give the 15-minute cleanup job and other jobs' teardown time to free
  capacity; a call already in flight can finish after the retry deadline.
  Diagnostics distinguish exhausted capacity from guest build/test failures.
  The provider enforces the current key's account quota; no fixed quota of 100
  is assumed and retries never delete dev/release snapshots to make room.
- Optional checkpoint saves do not wait for quota recovery. Their rejected save
  promise remains a checkpoint failure, not a successful save or test verdict.
- Cleanup: `node scripts/cleanup-daytona-evidence.ts [--dry-run]`, every 15 minutes in CI.
  Candidates include commit worlds unused for two hours and checkpoints beyond
  the newest 30 or older than 14 hours. The current base and newest warm image
  and world (including the newest active fallback) are retained. Active
  sandboxes, pending snapshots, and snapshots referenced by any sandbox are
  protected. Builders/capture forks block snapshot reclamation entirely, even
  when stopped (cold saves stop their builder before snapshotting). Cleanup never
  deletes those builders/forks; their controller/provider TTL owns teardown.
  Only owned terminal worlds/copies idle for two hours are deleted, after rechecking.
  Invalid/incomplete inventory aborts cleanup before deletion.
- This is backpressure, not an atomic quota reservation: concurrent producers
  can still fill the account. There is no aggressive headroom eviction or
  distributed lease in this change. A full account with no safe candidates
  fails with a quota-specific diagnostic after the bounded wait.
