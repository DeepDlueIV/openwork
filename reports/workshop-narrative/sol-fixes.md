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

## Second committed-head full run

Head: `2e695fb553`. Same native command and fresh-world placement, with the verified private Python interpreter supplied through `OPENWORK_WORKSHOP_PYTHON`.

**INCOMPLETE — native exit 1; 11 scene PASS, 1 FAIL, 0 BLOCKED.** Native test count: 0 passed, 1 failed, 0 skipped. Duration: 664 seconds including native lifecycle; world duration: 654,702 ms. Available-request usage: 5,869,158 tokens, $24.008136 estimate (not billed). All 181 completed requests reported `fast`; aggregate limits passed.

T01 and T05 now pass. T05's actual downloaded presentation contains **11 slides** and independently opens with python-pptx. Download and validation hash: `2fa54ea3dc66cd320b4c6e723f3c3e61f15e95b7e32c59913b624cd56cbd0230`. Original bytes and synthetic business/audit readbacks remain private.

The only native failure is T10: `Model must actually register the observed schedule`. Its retained fixture audit shows a completed `news_schedule_create` returning `job-1`, with the business title in input field `name`. The observer incorrectly treated every direct tool's `input.name` as the operation identity. This hid a legitimate direct registration and could also falsely accept a forged operation name on an unrelated tool.

Focused regressions reproduced **both errors red**, then passed after restricting operation-name unwrapping to the recognized generic `execute_capability` dispatcher. Direct tools keep their actual operation name and business input; wrong job IDs and error-status calls remain rejected. No schedule assertion was removed or replaced with mere state existence. Follow-up full focused suite: **105 passed, 0 failed/skipped**; typecheck and spec lint clean.

These results do not retroactively change the second native run's FAIL. A fresh full run is still required.

### Independent acceptance review (stricter than the native count)

The second bundle independently corroborates nine passing business outcomes, including the actual T01 full comparison/threaded draft and T05 downloaded 11-slide artifact. **Do not describe all eleven native PASS rows as audited acceptance.** T02 remains withheld because its final Latest result view shows warehouse picking rather than the cold-storage rerun, and the second bundle does not retain full native receipt/snapshot ordering. T03's recipient execution is recorded, but its visible output says no documented match despite Atlas 2's explicitly documented line-side use case. Full native grants/output digests also cannot be independently recomputed from that bundle.

Follow-up semantic regressions reject request echoes plus generic facts, raw-source-only answers, and an unqualified no-documented-match recommendation for a documented use case. All three new regression groups failed against the permissive checker and pass after excluding echoed inputs/raw sources from assessment and requiring an Atlas 2 line-side match. The common T02 prompt now requires general documented-use-case handling, including punctuation/hyphenation, without confusing missing site parameters with no documented use case. This is shared with the forthcoming Qwen baseline. The latest-result investigation found **no product selection bug**: original API logs show a second saved warehouse-picking execution after the cold-storage rerun. Authoring receipts are not saved snapshot history. A disposable no-paid API regression confirms chronological latest-result selection across REST and MCP executions (1 passed, 0 failed/skipped); its exploratory failed expectation was a test assumption, not a product red→green fix. The witness now requires the requested owner/recipient execution to equal the actual latest snapshot, with exact result digest equality. Superseded owner results and mismatched recipient results each reproduced red→green. Docshot gates also require the actual requested input to be visible. Current focused total: **111 passed, 0 failed/skipped**; **280-file** typecheck and spec lint clean. Native reports now record the exact Git head plus shared proof/fixture and scene-prompt digests, and refuse a source change during the paid run. Additional private retention now includes the native receipt/snapshot/grant/boundary responses and safe actor metadata, not whole conversations or credentials.

## Third committed-head full run

Head: `b188bbdfa2`. **INCOMPLETE — native exit 1; 9 scene PASS, 1 FAIL, 2 BLOCKED.** Native test: 0 passed, 1 failed, 0 skipped. Duration: 927 seconds including lifecycle; world duration: 916,098 ms. Available-request usage: 5,881,941 tokens and $24.202068 estimate, not billed cost. All 166 completed requests reported `fast`. Aggregate limits passed. Fourteen fresh Docshots and review receipts remain private.

- T10 now passes the unchanged registration/due-execution requirements.
- T02/T03 are withheld by the stronger semantic contract: both latest saved executions are real, correctly attributed and source-backed, but the generated code filters its assessment to the single product named in the rerun input. Native receipts, snapshots and ACL readbacks are now retained. The shared prompt will explicitly require both products in every comparison, rather than removing that existing assertion.
- T07 created and read back the Windows request with the correct required Application field, but the assistant never finalized and was stopped at the unchanged scene bound. The last upstream exchange ended in ~3.5 seconds; the old proxy only attested EOF, not a required protocol terminal. Existing retained data cannot name the final local tool or distinguish a pending interaction from engine finalization or incomplete protocol delivery. No timeout-only fix or product-cause claim is justified.

Bounded diagnostic work before further full paid verification: allowlisted message/tool/status metadata captured **before stop**, no text/arguments/results/credential snapshots; pending permission/question IDs only; upstream terminal events and function names/call IDs only. Free regressions distinguish a normal terminal, missing terminal at EOF, failed/incomplete responses, and a pending local tool/question. A separate opt-in **T07-only diagnostic** is not a replacement for any of the twelve full-matrix scenes and cannot establish workshop acceptance. Free validation: **133 tests passed, 0 failed/skipped**, **283-file typecheck clean**, spec lint clean. Missing-terminal EOF was reproduced red→green; successful EOF is now distinct from verified `response.completed` or Chat Completions finish-plus-DONE. This does not establish the earlier T07 cause.

## Publication and remaining work

Pending: a fresh committed-head Sol run after these bounded corrections, acceptance audit, protected evidence publication, then a separate stacked Qwen branch and unchanged fixed baseline. The normal CI producer currently triggers only for PRs targeting `dev`, while this PR intentionally targets the demo branch; no approved local-evidence import route is configured. Do not retarget or manually publish merely to obtain links.

Drive access is unavailable (401/no credentials). No upload or sign-in has been attempted. Raw logs, tokens, native transcripts, and provider receipts remain private and must not be committed.
