// Runs one chat history migration in its own process; see runOpencodeV1HistoryMigration.
import { fetchOpencodeV2Json } from "./managed-opencode-v2.js";
import { migrateOpencodeV1History, type MigrationProcessMessage, type MigrationProcessRequest } from "./opencode-v2-migration.js";

function isRequest(value: unknown): value is MigrationProcessRequest {
  return typeof value === "object" && value !== null && "source" in value && "target" in value;
}

function send(message: MigrationProcessMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    // The supervisor may already be gone; the migration still cleans up after itself.
    process.send(message, undefined, undefined, () => resolve());
  });
}

process.once("message", async (message: unknown) => {
  if (!isRequest(message)) throw new Error("Invalid migration request");
  const { target, ...migration } = message;
  let reported = Promise.resolve();
  await migrateOpencodeV1History({
    ...migration,
    target: { fetchJson: (path, init) => fetchOpencodeV2Json(target, path, init) },
    progress: (status) => { reported = send({ type: "progress", status }); },
    scratch: (scratch) => { void send({ type: "scratch", scratch }); },
  });
  // The migration has cleaned up; exit once its final status is delivered.
  await reported;
  process.exit(0);
});
