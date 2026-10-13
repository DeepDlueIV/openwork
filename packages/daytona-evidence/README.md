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
- Cleanup: `node scripts/cleanup-daytona-evidence.ts [--dry-run]`, every 15 minutes in CI.
  Commit worlds go after two unused hours and only the newest 30 checkpoints are
  kept, so CI stays under the organization's snapshot quota.
