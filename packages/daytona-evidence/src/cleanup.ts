import { DaytonaApi } from "./api.ts";
import { DAYTONA_BASE_PREFIX, DAYTONA_BASE_SNAPSHOT, DAYTONA_IMAGE_PREFIX, DAYTONA_TEMPLATE_PREFIX } from "./builder.ts";
import { CAPTURE_KIND, CHECKPOINT_PREFIX, COPY_KIND } from "./checkpoints.ts";
import { EVIDENCE_KIND } from "./world.ts";

/**
 * Daytona has no snapshot TTL, so this reclaims what evidence builds leave behind.
 * The organization's snapshot quota (100) is shared with releases and dev
 * builds, and CI makes dozens of these an hour, so they are kept briefly.
 * Only names and labels this package creates are touched.
 * - commit worlds: after two hours unused (CI uses them within minutes of a push);
 * - warm images: after a week, keeping the newest;
 * - superseded base images (an older recipe) and their plain parents: at once;
 * - checkpoints: after 14 hours (they can be opened for 12), and beyond the
 *   newest 30 at once;
 * - test worlds, builders, capture forks and reviewer copies: after two hours
 *   (they stop and delete themselves sooner).
 */
const WORLD_MAX_IDLE_MS = 2 * 3600_000;
const IMAGE_MAX_AGE_MS = 7 * 24 * 3600_000;
const SANDBOX_MAX_AGE_MS = 2 * 3600_000;
const CHECKPOINT_MAX_AGE_MS = 14 * 3600_000;
const CHECKPOINT_MAX_COUNT = 30;

export interface CleanupResult { deletedSnapshots: string[]; deletedSandboxes: string[] }

export async function cleanupDaytonaEvidence(api = new DaytonaApi(), { dryRun = false, now = Date.now() } = {}): Promise<CleanupResult> {
  const result: CleanupResult = { deletedSnapshots: [], deletedSandboxes: [] };
  const age = (createdAt?: string) => createdAt ? now - Date.parse(createdAt) : 0;
  const snapshots = await api.listSnapshots();
  const newestFirst = (a: { createdAt?: string }, b: { createdAt?: string }) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0");
  const images = snapshots.filter((snapshot) => snapshot.name.startsWith(DAYTONA_IMAGE_PREFIX)).sort(newestFirst);
  const checkpoints = snapshots.filter((snapshot) => snapshot.name.startsWith(CHECKPOINT_PREFIX)).sort(newestFirst);
  const expired = [
    ...snapshots.filter((snapshot) => snapshot.name.startsWith(DAYTONA_TEMPLATE_PREFIX)
      && age(snapshot.lastUsedAt ?? snapshot.createdAt) > WORLD_MAX_IDLE_MS),
    ...checkpoints.filter((snapshot, index) => index >= CHECKPOINT_MAX_COUNT || age(snapshot.createdAt) > CHECKPOINT_MAX_AGE_MS),
    ...images.slice(1).filter((snapshot) => age(snapshot.createdAt) > IMAGE_MAX_AGE_MS),
    ...snapshots.filter((snapshot) => snapshot.name.startsWith(DAYTONA_BASE_PREFIX)
      && snapshot.name !== DAYTONA_BASE_SNAPSHOT && snapshot.name !== `${DAYTONA_BASE_SNAPSHOT}-plain`),
  ];
  for (const snapshot of expired) {
    if (!dryRun) await api.deleteSnapshot(snapshot.id);
    result.deletedSnapshots.push(snapshot.name);
  }
  for (const kind of [EVIDENCE_KIND, "openwork-daytona-builder-v1", CAPTURE_KIND, COPY_KIND]) {
    for (const sandbox of await api.listSandboxes({ kind })) {
      if (age(sandbox.createdAt) <= SANDBOX_MAX_AGE_MS) continue;
      if (!dryRun) await api.deleteSandbox(sandbox.id);
      result.deletedSandboxes.push(sandbox.name);
    }
  }
  return result;
}
