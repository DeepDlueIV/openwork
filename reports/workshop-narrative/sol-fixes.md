# Sol fix verification — in progress

The frozen red comparison at `69e44ec4a3` is unchanged. This stacked fix does **not** yet establish complete workshop acceptance. Qwen-specific fixes have not started.

## Mechanism regressions

- Jira Assignee: a dedicated accessible label fixes native role/label lookup without changing the visible business value. The recorded baseline lookup failed; the fixed headless browser suite passes both tests.
- Confluence: preserve Markdownify setext headings through real update/readback, retain version messages and minor-edit flags, and reject phantom history on invalid updates. Three baseline failures became four passing regression tests.
- Observer: correlate numeric-string Confluence IDs without losing them through JSON numeric parsing; actual-shaped regression failed before the fix and passed afterward.
- Workflow: readable viewers already execute manually via their own REST/MCP identity. Correct the inconsistent library availability projection; retain editor/manager scheduling restrictions in the client and server. The API regression checks distinct actors, persisted receipts, outsider denial, and forbidden viewer scheduling.
- Workflow witnesses: require exact canonical input digests, saved code/version/schema, retained output, actual full source reads, recipient paid provenance, Plugin/direct grants, and outsider list/detail/snapshot boundaries. Real metadata content objects and native text envelopes are covered.
- Feedback: use the existing landing form and backend. Only its external Plain transport is redirected to an owned persistent provider. The native UI proof submits negative feedback and independently compares authenticated HTTP and disk readback. No production send, fake submission API, or bot-check bypass.
- Inference: bounded concurrent delegates, per-request cancellation, and correct handling of successful Responses envelopes containing `error: null`.
- Docshots: actual `Shot.run`, `gate`, `captureUntil`, and schema-validated review receipts; same-business-state before/after capture requirement. Fresh full-narrative captures remain pending.

## Commands

```sh
pnpm --dir evals typecheck
node --test evals/worlds/workshop-narrative-contract.test.ts evals/worlds/workshop-comparison-semantics.test.ts evals/worlds/workshop-narrative-witnesses.test.ts evals/worlds/workshop-workflow-witness.test.ts worlds/lib/workshop-inference.test.ts apps/app/src/app/lib/workflow-run-access.test.ts
node --test evals/docs-shots/shots/workshop.test.ts evals/packages/labs/src/workshop-feedback.test.mjs evals/packages/labs/src/demo-atlassian-confluence.test.mjs
node --test evals/packages/labs/src/demo-workplace-ui.test.mjs
node --test evals/worlds/workshop-run-budget.test.ts
OPENWORK_EVAL_MYSQL_URL='<owned-local-MySQL-base>' pnpm evals:e2e workshop-feedback --local --engine v1
```

The focused suites reported 94, 10, 2, and 1 passing tests respectively; no skips. Evals typecheck passes (276 files). The Workflow API regression also passes under the Den package's development conditions. The multiline feedback UI proof initially failed because inputs were visible before React hydration and the name/email entry was lost; the native screenshot preserved that failure. Waiting for observed hydration before trusted input and asserting all three rendered values made the same proof pass (1 passed, 0 failed/skipped, 29 seconds). The red native record remains private and unchanged.

## Full run and publication

Pending: committed-head Sol FAST T01–T12 matrix, fresh per-scene Docshots, acceptance audit, protected evidence publication, then a separate stacked Qwen branch and unchanged fixed baseline.

Drive access is unavailable (401/no credentials). No upload or sign-in has been attempted. Raw logs, tokens, native transcripts, and provider receipts remain private and must not be committed.
