import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { reviewWorld } from "../worlds/evidence-review.ts";

// Change-specific proof for the PR proof pipeline: it drives the production
// review app over HTTP with isolated synthetic records. Hosted Blob upload and
// Vercel sign-in remain separate trusted-boundary checks.
test("a selected PR proof is readable without presenting unrelated smoke evidence", async ({ evidence }) => {
  const contract = fileURLToPath(new URL("../../.github/scripts/pr-proof-review-build.test.mjs", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--test", contract], { timeout: 30_000 });
  expect(result.stdout).toMatch(/(?:fail 0|# fail 0)/);
  evidence.recordAssertionEvidence(
    "Review preparation happens only when a proof needs its production app",
    "The build contract verifies no build for unused review worlds, one fresh checkout build per worker when requested, failed builds prevent serving, and only the secret-free normal proof lane opts in. The production HTTP fixture below then opens the real review app.",
    true,
  );
  await using world = await reviewWorld();
  console.log("placement: local (isolated production review app; synthetic records)");
  const response = await fetch(`${world.baseUrl}/r/${world.passed}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private");
  const html = await response.text();
  expect(html).toContain("Sharing a skill, from link to access");
  expect(html).toContain("A shared skill can be opened");
  expect(html).toContain("The owner can revoke a link");
  expect(html).not.toContain("packaged desktop smoke");
  evidence.recordAssertionEvidence(
    "The selected proof report is readable and scoped to its supplied records",
    "The production-built local review page returned 200 with private caching, rendered both selected synthetic proof records, and contained no packaged-smoke fallback.",
    true,
  );

  const missing = await fetch(`${world.baseUrl}/r/${"0".repeat(32)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(missing.status).toBe(404);
  evidence.recordAssertionEvidence(
    "Unselected report identities are unavailable",
    "An unknown report identity returned 404 rather than another run's evidence.",
    true,
  );
});
