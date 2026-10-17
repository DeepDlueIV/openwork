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

## First committed-head full run

Head: `840cbf05ff`; draft stacked Sol PR: https://github.com/different-ai/openwork/pull/6112.

Command: `OPENWORK_WORKSHOP_NARRATIVE=1 OPENWORK_WORKSHOP_PROFILE=gpt-sol-fast OPENWORK_WORKSHOP_REPORT_DIR=<new-private-run-directory> OPENWORK_EVAL_MYSQL_URL=<owned-local-MySQL-base> pnpm evals:e2e workshop-narrative --local --surface web --engine v1`.

**INCOMPLETE — native exit 1; 10 scene PASS, 1 FAIL, 1 BLOCKED.** Native test count: 0 passed, 1 failed, 0 skipped. Duration: 713 seconds including native lifecycle; world report duration: 702,471 ms. Available-request usage: 5,681,157 tokens and $23.249812 estimate, not billed cost. All 166 completed inference requests reported `fast`; real tool preflight verified `gpt-6.1-sol` over Responses with requested priority and the Fast variant. Aggregate limits passed.

| Scene | First fixed Sol run |
|---|---|
| T10 news schedule and actual due execution | PASS |
| T01 saved comparison and threaded draft | FAIL — prompt requested customer-authored mail absent from the unchanged fixture; actual artifact requirements not met |
| T02 saved Workflow and changed-input execution | PASS |
| T03 real recipient execution and boundaries | PASS |
| T04 account report | PASS |
| T05 actual PowerPoint | BLOCKED — independent parser prerequisite unavailable; no downloaded-byte acceptance claim |
| T06 assigned Jira task | PASS |
| T07 required Windows Application field | PASS |
| T09 honest policy gap | PASS |
| T08 actual feedback UI/provider persistence | PASS |
| T11 same meeting rescheduled | PASS |
| T12 Confluence update/comment/threaded draft | PASS |

The run produced **14 actual Docshot PNGs and 14 review receipts**, including same-business-state accessibility before/after. They remain private pending approved publication; they do not turn the incomplete matrix into a pass. The run's raw disposable agent transcript store was removed at teardown, limiting retrospective tool-call enumeration. Follow-up instrumentation retains only owned synthetic business/audit readbacks and candidate PPTX bytes privately, not credentials or runtime configuration.

Follow-up corrections: clarify T01/T12 to the actual latest customer-related Inbox message, including internal staff correspondence; preserve full artifacts/readback/thread assertions. Validate the Python parser before paid work and download candidates by exact file ID. A real parser control validates an independent three-slide archive and rejects renamed text. The follow-up focused suite passes **102 tests, 0 failures/skips**; eval typecheck passes **278 files** and spec lint reports **0 errors**. Supply `OPENWORK_WORKSHOP_PYTHON=<private-Python-with-python-pptx>` (or a working `uvx`) for native runs; missing parser support now blocks setup before paid preflight.

## Publication and remaining work

Pending: a fresh committed-head Sol run after these bounded corrections, acceptance audit, protected evidence publication, then a separate stacked Qwen branch and unchanged fixed baseline. The normal CI producer currently triggers only for PRs targeting `dev`, while this PR intentionally targets the demo branch; no approved local-evidence import route is configured. Do not retarget or manually publish merely to obtain links.

Drive access is unavailable (401/no credentials). No upload or sign-in has been attempted. Raw logs, tokens, native transcripts, and provider receipts remain private and must not be committed.
