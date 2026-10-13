import assert from "node:assert/strict";
import { test } from "node:test";
import { DaytonaApi, daytonaConfig, DEFAULT_EVIDENCE_REGION, trimTrailingSlashes } from "./api.ts";
import { DAYTONA_BASE_SNAPSHOT } from "./builder.ts";
import { cleanupDaytonaEvidence } from "./cleanup.ts";

test("config needs a key, defaults the API and the VM region", () => {
  assert.throws(() => daytonaConfig({}), /DAYTONA_API_KEY is not set/);
  assert.deepEqual(daytonaConfig({ DAYTONA_API_KEY: " k " }), { apiKey: "k", apiUrl: "https://app.daytona.io/api", region: DEFAULT_EVIDENCE_REGION });
  assert.equal(daytonaConfig({ DAYTONA_API_KEY: "k", DAYTONA_API_URL: "https://x.test/api/", OPENWORK_DAYTONA_EVIDENCE_REGION: "eu" }).apiUrl, "https://x.test/api");
});

test("API errors never echo long token-like values", async () => {
  const api = new DaytonaApi({ apiKey: "k", apiUrl: "https://x.test/api", region: "r" },
    async () => new Response(JSON.stringify({ message: `bad token ${"a".repeat(40)}` }), { status: 400 }));
  await assert.rejects(api.getSnapshot("s"), (error: Error) => !error.message.includes("a".repeat(40)) && error.message.includes("[redacted]"));
});

test("cleanup only removes expired evidence snapshots and sandboxes it owns", async () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now - hours * 3600_000).toISOString();
  const snapshots = [
    { id: "1", name: "ow-dy-evidence-web-v1-old", state: "active", createdAt: hoursAgo(30) },
    { id: "2", name: "ow-dy-evidence-web-v1-new", state: "active", createdAt: hoursAgo(2) },
    { id: "3", name: "ow-dy-evidence-image-v1-newest", state: "active", createdAt: hoursAgo(400) },
    { id: "4", name: "ow-dy-evidence-image-v1-older", state: "active", createdAt: hoursAgo(500) },
    { id: "5", name: "openwork-eval-vnc", state: "active", createdAt: hoursAgo(5000) },
    { id: "6", name: DAYTONA_BASE_SNAPSHOT, state: "active", createdAt: hoursAgo(5000) },
    { id: "7", name: `${DAYTONA_BASE_SNAPSHOT}-plain`, state: "active", createdAt: hoursAgo(5000) },
    { id: "8", name: "ow-dy-base-ubuntu2404-v1", state: "active", createdAt: hoursAgo(1) },
  ];
  const sandboxes: Record<string, { id: string; name: string; state: string; labels: Record<string, string>; createdAt: string }[]> = {
    "openwork-daytona-evidence-v1": [{ id: "a", name: "world-old", state: "started", labels: {}, createdAt: hoursAgo(3) }, { id: "b", name: "world-new", state: "started", labels: {}, createdAt: hoursAgo(1) }],
    "openwork-daytona-builder-v1": [],
  };
  const fake = { listSnapshots: async () => snapshots,
    listSandboxes: async (match: Record<string, string>) => sandboxes[match.kind] ?? [],
    deleteSnapshot: async () => { throw new Error("dry run must not delete"); },
    deleteSandbox: async () => { throw new Error("dry run must not delete"); } };
  // A structural fake of the two list calls and two deletes cleanup uses.
  const result = await cleanupDaytonaEvidence(Object.assign(Object.create(DaytonaApi.prototype), fake), { dryRun: true, now });
  assert.deepEqual(result, { deletedSnapshots: ["ow-dy-evidence-web-v1-old", "ow-dy-evidence-image-v1-older", "ow-dy-base-ubuntu2404-v1"], deletedSandboxes: ["world-old"] });
});

test("trailing slashes are trimmed in linear time", () => {
  assert.equal(trimTrailingSlashes("https://x.test/api///"), "https://x.test/api");
  assert.equal(trimTrailingSlashes("/".repeat(100_000)), "");
});
