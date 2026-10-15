import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { proofArtifact, proofArtifactsForAttempt, selectProof } from "../../.github/scripts/pr-proof.mjs";
import { reviewWorld } from "../worlds/evidence-review.ts";

test("proof selection accepts normal Den paths and the selected report remains private", async ({ evidence }) => {
  const selection = selectProof([
    { filename: "ee/apps/den-web/app/(den)/dashboard/a file.ts", status: "modified" },
    { filename: "evals/specs/pr-proof-git-paths.e2e.test.ts", status: "added" },
  ]);
  // Any code change also runs the core journey (CORE_SPECS).
  expect(selection.specs).toEqual(["evals/specs/core-chat.e2e.test.ts", "evals/specs/pr-proof-git-paths.e2e.test.ts"]);
  evidence.recordAssertionEvidence(
    "Normal Git paths do not hide a newly added proof",
    "A Den path containing parentheses and a space was accepted, and the new E2E spec was selected beside the core journey every code change runs.",
    true,
  );

  await using world = await reviewWorld();
  const response = await fetch(`${world.baseUrl}/r/${world.passed}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private");
  evidence.recordAssertionEvidence(
    "Selected proof evidence remains private in the reviewer",
    "The production-built local review route returned 200 with private cache control for its isolated synthetic report.",
    true,
  );
});

test("a re-run of failed proof jobs publishes each spec's newest records", async ({ evidence }) => {
  const core = "evals/specs/core-chat.e2e.test.ts";
  const drive = "evals/specs/drive-files.e2e.test.ts";
  const specs = [core, drive];
  // "Re-run failed jobs": only the core journey ran again, so drive's records stay on attempt 1.
  const rerun = proofArtifactsForAttempt([{ name: proofArtifact(drive, 1) }, { name: proofArtifact(core, 2) }, { name: "logs" }], specs, 2);
  expect(rerun.expected && Object.fromEntries(rerun.expected)).toEqual({ [proofArtifact(core, 2)]: core, [proofArtifact(drive, 1)]: drive });
  // "Re-run all jobs": the newest attempt wins and the earlier records are ignored.
  const all = proofArtifactsForAttempt([1, 2].flatMap(attempt => specs.map(spec => ({ name: proofArtifact(spec, attempt) }))), specs, 2);
  expect(all.expected && new Set(all.expected.keys())).toEqual(new Set(specs.map(spec => proofArtifact(spec, 2))));
  evidence.recordAssertionEvidence(
    "A re-run publishes evidence instead of failing publication",
    "With the core journey re-run on attempt 2 and the other spec's passing records still on attempt 1, both records were chosen; after re-running every job, only attempt 2's records were chosen.",
    true,
  );

  expect(proofArtifactsForAttempt([{ name: proofArtifact(drive, 1) }], specs, 2).reason).toBe("required proof artifact is missing or duplicated");
  expect(proofArtifactsForAttempt([...specs.map(spec => ({ name: proofArtifact(spec, 1) })), { name: proofArtifact(core, 3) }], specs, 2).reason).toBe("unexpected proof artifact is present");
  expect(proofArtifactsForAttempt([...specs.map(spec => ({ name: proofArtifact(spec, 1) })), { name: proofArtifact("evals/specs/other.e2e.test.ts", 1) }], specs, 1).reason).toBe("unexpected proof artifact is present");
  expect(proofArtifactsForAttempt([...specs.map(spec => ({ name: proofArtifact(spec, 1) })), { name: proofArtifact(core, 1) }], specs, 1).reason).toBe("required proof artifact is missing or duplicated");
  evidence.recordAssertionEvidence(
    "Missing, future, foreign and duplicated records still publish nothing",
    "A spec with no records, a record from a later attempt, a record for a spec the PR did not select, and two records with one name were each refused.",
    true,
  );
});
