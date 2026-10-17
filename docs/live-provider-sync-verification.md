# Live provider sync verification

PR: https://github.com/different-ai/openwork/pull/6111

## Initial red-run diagnosis

Reviewed head `acd799f153a30a1cd0aea95735779e7dda496e42` before changing code.
These are introduced issues in this PR, not claims of pre-existing failures.

### Incomplete lifecycle proof

- Run: `39002535209`, job `117308339879`.
- Exact executed command: `node evals/bin/evals.mjs proofs/live-provider-sync.proof.test.ts --local`
  (inside `xvfb-run -a` on the Linux CI runner).
- CI prerequisites completed: workspace installs, Den dependency builds,
  Chrome, MySQL and Redis.
- Exit: **2**; **0 passed, 0 failed, 1 skipped**; verdict **Incomplete**.
- First actionable failure: the spec required an external `opencode2` command
  before allocating its world. That command is not on the CI runner's PATH,
  despite the managed v2 runtime supporting installation of its pinned engine.
- Inspected the uploaded CLI result in artifact
  `pr-proof-1-80b6d9e7974cb4abe1e8570ba4945591f0b94315c7beed6141b5122265c50e3c`.
  There are no lifecycle screenshots because the test never allocated a world.
- Reproduced the same command on the same SHA with the CI-equivalent absence
  of `opencode2` on PATH, retaining all other installed prerequisites:
  **exit 2; 0 passed, 0 failed, 1 skipped**, verdict **Incomplete**.
  The reproduction's CLI result is
  `evals/results/.testkit/cli-run-1792212122514-28442.json`.
- The evidence preview failure follows this incomplete proof; a skipped test
  is not passing evidence. No test assertion or deadline needs relaxing.

### Security review

Inspected the actual `warden-findings` artifact from run `39002535208` and
its clearance report. Warden completed analysis with **1 high + 1 medium**
finding, and `warden-clear` correctly failed:

1. The provider-session capability in the engine's initial environment is
   inherited by shell tools, permitting redemption for the Den bearer token.
   Merely clearing a later JavaScript environment value is not enough to
   establish a safe subprocess boundary.
2. Hashing every organization provider into a member's inventory revision
   reveals changes to inaccessible providers through SSE invalidations.
   Revision dependencies must reflect caller-visible state only while still
   detecting indirect grants and revocations.

Both findings are being fixed with regression coverage. No baseline exception,
manual clearance, timeout increase, assertion weakening or rollout change is
used to make these checks green.

## Additional independent review findings

A separate read-only reviewer identified three further introduced regressions:

- Real membership removal is HTTP 404 `organization_not_found`, not the
  synthetic HTTP 403 in the original plugin tests. Treating every 404 as a
  feature kill could retain revoked snapshots indefinitely. Revocation now
  needs a distinct clear-and-retry path, including same-session regrant.
- A v1 routing transition could join an in-flight live-owned provider-sync pass
  and lose the only requested legacy restoration. Reproduced with
  `bun test apps/server/test/live-provider-sync-transition-race.test.ts` on
  the original implementation: **exit 1; 0 passed, 1 failed**, first failure
  `the old live pass cannot swallow the ownership transition` (`1 !== 2`).
  An explicit ownership-transition trailing reconciliation fixes the witness:
  **exit 0; 1 passed, 0 failed** without another manual gesture or timer.
- Removing static Gateway config also omitted its quota-response no-retry
  hook. Live mode now resolves current native provider settings in the quota
  hook instead of maintaining a second inventory. Static/live parity,
  changed-endpoint handling and foreign-response rejection are covered by
  `apps/server/test/live-provider-sync-quota.test.ts`.

## Startup defects exposed by the expanded proof

The first no-v2-PATH invocation also removed the co-located v1 bootstrap
executable; all three cases failed world preparation. Corrected the test
invocation to retain v1, as CI does. This was an invocation/prerequisite error,
not evidence of a passing product or an assertion to relax.

Subsequent full cold runs exposed empty native inventories in later Locations.
An isolated passing run was not classified as proof of flakiness. A native
regression created actual sessions in two unrelated, unprepared workspaces:
the first Location worked while those workspaces stayed empty. The first ESM
graph consumed the private descriptor, and other Location-scoped graphs had
independent, empty credential closures. A canonical credential-free CJS broker
now shares its frozen request API through native require's process-wide cache.
The credential remains private and the descriptor closes before tools run.
The same native regression now passes in all Locations, with one shared stream.

CI now selects the existing pinned-binary provisioner for this v2-only proof.
Executable download/version/integrity checks happen before the cold worlds,
which still have independent organizations, homes, caches, databases, engines,
workspaces and browser documents. Only verified executables are reused. No
proof timeout was raised. `run-parity-proof.test.mjs` checks preparation order,
v2-only selection and preservation of failure/incomplete verdicts.

The final read-only review also found an unchanged-credential-event recovery
race in standalone use. Its denial subscription was aborted, then an early
return prevented recreating it. Extended tests reproduced **0 passed, 2 failed**
(exit 1) for 403/404; restoring only the retry rail, without clearing authority,
passes **2/0/0** (exit 0). The reviewer found no remaining actionable findings
after inspecting that fix; this is source review, not independent test execution.

## Scenario matrix

All fixtures use isolated seeded organizations or synthetic localhost native
fixtures; none mutate a real user's organization.

| Requested scenario | Coverage/result |
| --- | --- |
| 1. Add provider/model exactly once | Real Den → open-picker proof, three cold organizations |
| 2. Delete provider, no resurrection | Same proof; subsequent inventory mutation plus repeated absence/sibling observations |
| 3. Disable/re-enable provider | Same proof; exact original aliases restored once |
| 4. Add model | Same proof; exact aliases/counts and siblings retained |
| 5. Remove model | Same proof; removed alias absent, two original siblings retained |
| 6. Rename model metadata | Arbitrary catalog-model rename API **unsupported**. Real provider-name metadata update is proved in the picker; native model metadata and real-DB revision metadata changes are separately tested |
| 7. Disable/re-enable model | No independent per-model status API. Supported single-model group disable/re-enable is proved without disabling unrelated siblings |
| 8. Entitlements/isolation | Real member/team revoke/regrant and audience changes in picker proof; negative member reads; real-DB cross-org/private-resource revision and SSE isolation tests |
| 9. Rapid bursts | Real acknowledged Den writes without waiting for intermediate picker states; exact latest rows/no duplicates; held-old-fetch native race |
| 10. Disconnect/reconnect/duplicates | Real-engine native stream fixture; full replacement after missed updates and duplicate-event no-op; no frontend cache injection |
| 11. Cold/warm cache | Three cold real-Den profiles; persistent native cache restart during outage; connected revocation clears stale models |
| 12. Ownership/flag transitions/v1 | Actual managed v2 OFF→ON, ON→OFF restart/legacy restoration, unchanged-config and no-overlap assertions; blocked in-flight restoration regression. V1 routing/config and legacy sync are tested; not a separate v1 inference journey |
| 13. Sign-out/account/org switch | Actual native model/credential replacement, held old-account fetch fence, sign-out/cache removal |
| 14. Unavailable Den/invalid auth | Native transient 503/cache/retry/recovery; actual 401 and membership 403/404/regrant. Fresh rollout verification unavailable defaults new engines to legacy, not an unverified live grant |

## Local results

- Exact CI provisioned command:
  `node evals/scripts/run-parity-proof.mjs evals/proofs/live-provider-sync.proof.test.ts`
  with external `opencode2` absent from PATH and v1 available.
- Placement: **local**; real appWeb + Den + pinned OpenCode **2.0.26**.
- **Exit 0; 3 passed, 0 failed, 0 skipped**; 206.05 seconds.
- CLI receipt: `evals/results/.testkit/cli-run-1792214304532-94671.json`.
- Three runs each record **18 acknowledged mutations**, exact model IDs/names,
  absence/sibling preservation, and unchanged document/route/open picker.
- 54 timed observations: 51 visible picker transitions plus three negative-scope
  observations where the signed-in member's picker correctly remains unchanged.
- Visible-transition latency: **1,015–2,048 ms**, median **1,530 ms**. Including
  negative-scope observations: 11–2,048 ms, median 1,529.5 ms. These are local
  ACK-to-observation measurements, not a production SLA or a best-case sample.
- Plugin tests: **125/0/0**. Den unit + real-DB isolation tests: **17/0/0**.
- Native lifecycle and managed/new-workspace tests pass separately on Bun and
  Electron Node with both manifest-provisioned and installed 2.0.26 binaries
  (eight commands, each exit 0, one framework test passed, no skips). Named
  scenarios within each framework test are not separately counted as tests.
- Real model-approved shell boundary passes on macOS and Linux ARM64/Bun,
  including Linux `/proc` checks. The Linux fixture uses Bun's node-compatible
  runner for its shell inspection script. No inherited credential or readable
  descriptor, and bridge redemption returns 401 before/after activation.
- Full server build, package typechecks, eval lint/typecheck and generated
  feature/Helm/OpenAPI/SDK synchronization pass. CI results are authoritative
  only for their recorded pushed SHA; final head/check status is reported on
  the PR after the pipeline completes.

## Limits

No production latency/load measurement, packaged Windows/macOS release smoke,
or v1 inference parity claim is made by this proof. An offline catalog can be
stale; it converges after reconnection, and a verified auth revocation clears
it. A running engine retains its selected single owner through a kill; the
next engine start freshly resolves the rollout and restores legacy when off.
