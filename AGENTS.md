# AGENTS.md

OpenWork is a free, open-source desktop app (macOS, Windows, Linux) for doing
work with AI agents on your own files — an open-source alternative to Claude
Cowork and Codex, built on OpenCode, running any model from 50+ providers.
Desktop mode keeps files local; cloud is optional. Three surfaces live in this
repo:

* **Desktop app** (`apps/`, `packages/`) — local-first agent workspace: chat on
  files, skills, browser automation, scheduled automations, Anthropic-compatible
  plugins.
* **OpenWork MCP gateway** (`ee/apps/den-api`) — one URL
  (`api.openworklabs.com/mcp/agent`) that brings org-assigned skills, plugins,
  and connections (Google Workspace, Microsoft 365, MCPs) into Codex, Claude
  Code, Cursor, or any MCP client via `search_capabilities` /
  `execute_capability`.
* **OpenWork Den** (`ee/apps/den-*`) — the org control plane: provision
  inference, manage teams and access, set desktop policies, publish skills and
  plugins through marketplaces.

The app consumes OpenWork server surfaces (self-hosted or hosted) rather than
inventing parallel behavior. Anything OpenCode can do is available in OpenWork,
even before a dedicated UI exists.

## NoClip: continuity, recovery and reporting

* Keep `docs/noclip/WORK-STATE.md` current at meaningful checkpoints: task,
  repository/branch, exact source SHA, last verified stage and evidence URLs,
  pending/failed operations, and the next safe action. Never include secrets.
* After an interruption, failed response, context loss or a request to continue,
  read that checkpoint and reconcile it with the live branch, recent commits,
  working-tree changes, CI attempts, artifacts and releases before any write.
  Chat history and UI activity labels are not proof that an action completed.
* A missing tool response means the outcome is unknown, not that the operation
  failed. Inspect remote state before retrying a commit, tag, upload or release.
  Resume from the last verified checkpoint; rerun the interrupted stage and
  its dependent checks if their completion or integrity cannot be established.
* Repair or revert only identified incomplete/broken changes. Preserve verified
  work and unrelated changes; never reset branches, force-push, move published
  tags, delete user data or discard work merely because the conversation paused.
* Re-discover and actually try the necessary connector capability before
  claiming write access is unavailable. Stop and report a real permission block;
  do not widen permissions or change repository protection as a workaround.
* Give brief progress updates during long work and whenever a stage blocks.
  Finish with verified results, remaining limitations and direct download/run
  links. Distinguish compiled, installed, upgraded, GUI-tested and published.
  Do not imply work continues between turns or promise later delivery without
  an explicitly configured automation. Do not ask the user to read accessible
  logs that the agent can investigate itself.
* Once a recurring workflow is reliable and has repeatable successful evidence,
  propose a reusable skill with its trigger, inputs, checks and recovery rules.
  Do not create/install it without approval or codify an unstable process.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Generated API contracts

After changing Den routes, their shared schemas, or the feature registry, run
`pnpm den:contract` (also run by `pnpm features:sync`) and
include `packages/docs/openapi.json` and `packages/sdk/src/gen/**` in the same
commit. The command builds once and generates both outputs from one snapshot. It
prepares and removes a disposable local MySQL database automatically; start
MySQL with `pnpm dev:den:mysql`. It never uses `DATABASE_URL`; use
`OPENWORK_CONTRACT_MYSQL_URL` only for alternate localhost credentials.
After merging/rebasing `dev`, regenerate rather than choosing ours/theirs for
conflicted generated files. Never hand-edit them or regenerate a Drizzle migration
snapshot to resolve an API conflict.

Optional: `pnpm hooks:install` enables a pre-commit hook that skips unrelated
commits and regenerates/stages only contract outputs for API changes. It refuses
unstaged/untracked contract inputs or outputs, so finish partial staging first.
Hooks never commit, push, or change CI/Warden policy; CI remains authoritative.

## Coding

* pnpm only, never npm/yarn. TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
* Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
* New feature or a change users would notice? Declare it, off, in
  `packages/features/src/registry.ts` before writing the code, make it safe
  to turn off, then roll it out from `/admin`. Follow
  `.opencode/skills/add-a-feature`.
* Any user-facing UI (desktop app, Den web, MCP Apps, artifact views) follows
  `DESIGN.md`: read it before designing, cite its rule ids in PRs, and attach
  screenshots of new UI. The optional
  `.warden/skills/design-spec-review` skill can review these rules locally.

