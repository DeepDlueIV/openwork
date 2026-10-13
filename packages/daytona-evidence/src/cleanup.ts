import { DaytonaApi } from "./api.ts";
import { DAYTONA_BASE_PREFIX, DAYTONA_BASE_SNAPSHOT, DAYTONA_IMAGE_PREFIX, DAYTONA_TEMPLATE_PREFIX } from "./builder.ts";
import { EVIDENCE_KIND } from "./world.ts";

/**
 * Daytona has no snapshot TTL, so this reclaims what evidence builds leave behind.
 * Only names and labels this package creates are touched.
 * - commit worlds: after a day (CI uses them within minutes of a push);
 * - warm images: after a week, keeping the newest;
 * - superseded base images (an older recipe) and their plain parents: at once;
 * - test worlds and builders: after two hours (they stop and delete themselves sooner).
 */
const WORLD_MAX_AGE_MS = 24 * 3600_000;
const IMAGE_MAX_AGE_MS = 7 * 24 * 3600_000;
const SANDBOX_MAX_AGE_MS = 2 * 3600_000;

export interface CleanupResult { deletedSnapshots: string[]; deletedSandboxes: string[] }

export async function cleanupDaytonaEvidence(api = new DaytonaApi(), { dryRun = false, now = Date.now() } = {}): Promise<CleanupResult> {
  const result: CleanupResult = { deletedSnapshots: [], deletedSandboxes: [] };
  const age = (createdAt?: string) => createdAt ? now - Date.parse(createdAt) : 0;
  const snapshots = await api.listSnapshots();
  const images = snapshots.filter((snapshot) => snapshot.name.startsWith(DAYTONA_IMAGE_PREFIX))
    .sort((a, b) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0"));
  const expired = [
    ...snapshots.filter((snapshot) => snapshot.name.startsWith(DAYTONA_TEMPLATE_PREFIX) && age(snapshot.createdAt) > WORLD_MAX_AGE_MS),
    ...images.slice(1).filter((snapshot) => age(snapshot.createdAt) > IMAGE_MAX_AGE_MS),
    ...snapshots.filter((snapshot) => snapshot.name.startsWith(DAYTONA_BASE_PREFIX)
      && snapshot.name !== DAYTONA_BASE_SNAPSHOT && snapshot.name !== `${DAYTONA_BASE_SNAPSHOT}-plain`),
  ];
  for (const snapshot of expired) {
    if (!dryRun) await api.deleteSnapshot(snapshot.id);
    result.deletedSnapshots.push(snapshot.name);
  }
  for (const kind of [EVIDENCE_KIND, "openwork-daytona-builder-v1"]) {
    for (const sandbox of await api.listSandboxes({ kind })) {
      if (age(sandbox.createdAt) <= SANDBOX_MAX_AGE_MS) continue;
      if (!dryRun) await api.deleteSandbox(sandbox.id);
      result.deletedSandboxes.push(sandbox.name);
    }
  }
  return result;
}
