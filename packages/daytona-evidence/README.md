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

Core PR CI sets `OPENWORK_DAYTONA_EPHEMERAL_WORLD=1`: preparation warms only
base/image dependencies, then the journey reuses an active commit template or
builds a unique, private evidence VM and runs it directly. It does not save a
new commit template or wait on another run's template save. The launcher checks
its source SHA and runtime fingerprint before issuing access. Failed preparation
and normal teardown delete that run's VM; idle auto-stop/auto-delete and existing
owned-world cleanup cover abandoned runs. Reviewer checkpoints are unchanged.
Dev warm-up and other callers still save reusable running templates with the
existing layer locks. No fork-during-snapshot behavior is assumed.

- Needs `DAYTONA_API_KEY` for an organization with Linux VMs in
  `OPENWORK_DAYTONA_EVIDENCE_REGION` (default `us-west-3`).
- Builds: `node scripts/prepare-evidence-web.ts` with the provider set.
- Cleanup: `node scripts/cleanup-daytona-evidence.ts [--dry-run]`, every 15 minutes in CI.
  Commit worlds go after two unused hours and only the newest 30 checkpoints are
  kept, so CI stays under the organization's snapshot quota.
