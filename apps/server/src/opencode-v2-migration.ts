import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importNodeSqlite } from "./runtime-db.js";
import {
  createManagedOpencodeV2Server, OpencodeV2ResponseTooLargeError, type ManagedOpencodeV2Server, type OpencodeV2Connection,
} from "./managed-opencode-v2.js";
import { nativeSession } from "./opencode-v2-session-home.js";

export interface EngineV2MigrationStatus {
  state: "idle" | "running" | "completed" | "error";
  /**
   * While running: `starting` until the history snapshot is counted,
   * `converting` while the engine converts it (counts do not move), then
   * `copying` as chats are imported. Lets clients show indeterminate progress
   * instead of a stalled "0 of N".
   */
  phase?: "starting" | "converting" | "copying";
  imported: number;
  skipped: number;
  total: number;
  /** ISO time the current migration started. */
  startedAt?: string;
  error?: string;
  /** Copy of the v2 chat database taken before this migration wrote to it. */
  backupPath?: string;
  /** Chats left in v1 because they could not be copied; the other chats are still copied. */
  notCopied?: ChatNotCopied[];
}

export interface ChatNotCopied {
  id: string;
  title: string;
  /**
   * `too_large`: its export is over MAX_CHAT_EXPORT_BYTES. `rejected`: the
   * converter or v2 refused this chat. `stopped`: the migration process died
   * while copying it, so later migrations leave it out.
   */
  reason: "too_large" | "rejected" | "stopped";
}

/** Backups of the v2 chat database kept on disk; older ones are removed. */
const KEPT_V2_BACKUPS = 2;
/** Room left free after a migration so the computer keeps working. */
const FREE_SPACE_MARGIN_BYTES = 1024 ** 3;
/**
 * A chat is held in memory several times while it is copied (the export text,
 * the parsed chat, the import body). Electron's V8 heap is capped at 4 GiB in
 * every process, a separate one included, so larger chats stay in v1.
 */
const MAX_CHAT_EXPORT_BYTES = 256 * 1024 ** 2;
/** In `storageDir`: chats a migration process died on, which later migrations leave in v1. */
const STOPPED_CHATS_FILE = "chats-not-copied.json";

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

/** A SQLite database with its write-ahead log, as it would be snapshotted. */
async function databaseSize(path: string): Promise<number> {
  return (await fileSize(path)) + (await fileSize(`${path}-wal`));
}

export function conversionTimeoutMs(snapshotBytes: number): number {
  return 10 * 60_000 + Math.ceil(snapshotBytes / 1024 ** 3) * 3 * 60_000;
}

function formatGigabytes(bytes: number): string {
  return `${Math.max(0.1, Math.ceil((bytes / 1024 ** 3) * 10) / 10)} GB`;
}

/**
 * Refuse before writing anything when the snapshot and backup would not fit.
 * Hosts without statfs skip the check rather than block the migration.
 */
export async function ensureMigrationDiskSpace(options: { directory: string; neededBytes: number }): Promise<void> {
  let available: number;
  try {
    const fs = await statfs(options.directory);
    available = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return;
  }
  const needed = options.neededBytes + FREE_SPACE_MARGIN_BYTES;
  if (available >= needed) return;
  throw new Error(
    `Not enough free disk space to upgrade safely. Free up about ${formatGigabytes(needed - available)} and try again. Nothing was changed.`,
  );
}

/**
 * Keep a copy of the v2 chat database before a migration imports into it.
 * v1 history is never written, so this is the only data a migration can change.
 */
export async function backupV2Database(options: { database: string; directory: string; now?: Date }): Promise<string | undefined> {
  try { await access(options.database); } catch { return undefined; }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = join(options.directory, `opencode-v2-${stamp}.db`);
  await snapshotV1Database(options.database, destination);
  const backups = (await readdir(options.directory))
    .filter((name) => /^opencode-v2-.+\.db$/.test(name))
    .sort()
    .reverse();
  for (const old of backups.slice(KEPT_V2_BACKUPS)) {
    await rm(join(options.directory, old), { force: true });
  }
  return destination;
}

export function opencodeV1DatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB === ":memory:") throw new Error("In-memory OpenCode history cannot be migrated.");
  if (env.OPENCODE_DB?.trim()) return resolve(env.OPENCODE_DB);
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "opencode.db");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SQLite's snapshot includes the WAL. Never copy a live database file directly. */
export async function snapshotV1Database(source: string, destination: string): Promise<void> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(source, { readonly: true });
    try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
    finally { db.close(); }
  } else {
    // Electron runs the server in-process. Yield between backup batches so a
    // large history does not freeze the desktop main thread.
    const { DatabaseSync, backup } = await importNodeSqlite();
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, destination); } finally { db.close(); }
  }
  await chmod(destination, 0o600);
}

/** Key OpenCode v2 sets in a database it has already converted (`kv` table). */
const V2_CONVERSION_MARKER = "migration.v1-v2";

/**
 * A v1 database that an OpenCode v2 build once opened directly carries a
 * "conversion completed" marker from that day. The converter then skips its
 * work and exports that stale projection, so every chat added since arrives
 * empty. Clear the marker in the private snapshot (never the original) so the
 * converter rebuilds from the v1 tables, which are the source of truth.
 */
export async function clearStaleConversionMarker(database: string): Promise<boolean> {
  const db = typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database)
    : new (await importNodeSqlite()).DatabaseSync(database);
  try {
    const table: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get();
    if (!isRecord(table)) return false;
    const marker: unknown = db.prepare("SELECT key FROM kv WHERE key = ?").get(V2_CONVERSION_MARKER);
    if (!isRecord(marker)) return false;
    db.prepare("DELETE FROM kv WHERE key = ?").run(V2_CONVERSION_MARKER);
    return true;
  } finally { db.close(); }
}

type MigrationSession = { id: string; title: string; directory: string; parentId: string | null };

export async function readMigrationSessions(database: string): Promise<MigrationSession[]> {
  const db = typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
  try {
    const rows: unknown[] = db.prepare("SELECT id, title, directory, parent_id FROM session ORDER BY time_created, id").all();
    return rows.map((row) => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.directory !== "string"
        || !isAbsolute(row.directory) || (row.parent_id !== null && typeof row.parent_id !== "string")) {
        throw new Error("OpenCode v1 history contains an invalid session. The original database was not changed.");
      }
      return { id: row.id, title: typeof row.title === "string" ? row.title : "", directory: row.directory, parentId: row.parent_id };
    });
  } finally { db.close(); }
}

async function readStoppedChats(storageDir: string): Promise<Map<string, string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(storageDir, STOPPED_CHATS_FILE), "utf8")); } catch { return new Map(); }
  if (!Array.isArray(parsed)) return new Map();
  return new Map(parsed.filter(isRecord).filter((chat) => typeof chat.id === "string")
    .map((chat) => [String(chat.id), typeof chat.title === "string" ? chat.title : ""]));
}

/** Remember a chat a migration process died on, so the next migration copies the others. */
async function rememberStoppedChat(storageDir: string, chat: { id: string; title: string }): Promise<void> {
  const chats = await readStoppedChats(storageDir);
  chats.set(chat.id, chat.title);
  const path = join(storageDir, STOPPED_CHATS_FILE);
  await writeFile(`${path}.tmp`, JSON.stringify([...chats].map(([id, title]) => ({ id, title }))), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** What a history migration needs besides its target engine and progress reporting. */
export interface MigrationRequest {
  source: string;
  storageDir: string;
  bin: string;
  /** The live v2 chat database, copied into `directory` before any chat is imported. */
  backup?: { database: string; directory: string };
}

/** The private snapshot folder and converter a migration creates and removes again. */
export interface MigrationScratch {
  directory: string;
  converterPid?: number;
}

/** Let the pinned engine transform a private snapshot, then use its native import API. */
export async function migrateOpencodeV1History(options: MigrationRequest & {
  target: Pick<ManagedOpencodeV2Server, "fetchJson">;
  progress: (status: EngineV2MigrationStatus) => void;
  /** Lets a supervising process remove the scratch if this one dies before its own cleanup. */
  scratch?: (scratch: MigrationScratch) => void;
  /** Called (and awaited) before each chat is exported, so a supervisor knows which chat a crash was on. */
  copying?: (chat: { id: string; title: string }) => Promise<void> | void;
}): Promise<void> {
  await mkdir(options.storageDir, { recursive: true, mode: 0o700 });
  // Only one migration runs at a time, so any other snapshot folder is left
  // over from a migration that was killed before it could clean up (~ the
  // size of the v1 history each).
  for (const name of await readdir(options.storageDir)) {
    if (name.startsWith("migration-")) await rm(join(options.storageDir, name), { recursive: true, force: true });
  }
  const root = await mkdtemp(join(options.storageDir, "migration-"));
  options.scratch?.({ directory: root });
  let converter: ManagedOpencodeV2Server | undefined;
  const status: EngineV2MigrationStatus = { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0 };
  const notCopied: ChatNotCopied[] = [];
  try {
    const database = join(root, "opencode.db");
    try { await access(options.source); } catch { throw new Error("No v1 chat history found for this profile. Create a v1 chat before migrating."); }
    // The snapshot (about the size of v1 history) and the v2 backup are both
    // written next to OpenWork's data; a full disk mid-copy is the one way a
    // migration could hurt the computer, so check before writing anything.
    await ensureMigrationDiskSpace({
      directory: options.storageDir,
      neededBytes: (await databaseSize(options.source)) + (options.backup ? await databaseSize(options.backup.database) : 0),
    });
    await snapshotV1Database(options.source, database);
    await clearStaleConversionMarker(database);
    const sessions = await readMigrationSessions(database);
    status.total = sessions.length;
    status.phase = "converting";
    options.progress({ ...status, notCopied: [...notCopied] });
    if (sessions.length) {
      // No user config, credentials, plugins, or previous preview database in the converter.
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      converter = await createManagedOpencodeV2Server({ bin: options.bin, rootDir: root, env: {
        HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1",
      } });
      options.scratch?.({ directory: root, converterPid: converter.childPid });
      // Conversion time grows with history size: 10 minutes, plus 3 per GB of snapshot.
      const deadline = Date.now() + conversionTimeoutMs(await fileSize(database));
      while (true) {
        const result = await converter.fetchJson("/api/experimental/migration/v1");
        if (result.status !== 200 || !isRecord(result.json)) throw new Error("Could not verify OpenCode's history conversion.");
        if (result.json.status === "completed") break;
        if (result.json.status === "error") throw new Error("OpenCode could not convert the history snapshot. Your v1 history is unchanged.");
        if (Date.now() > deadline) throw new Error("History conversion timed out. Retry migration.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (options.backup) {
        const backupPath = await backupV2Database(options.backup);
        if (backupPath) status.backupPath = backupPath;
      }
      status.phase = "copying";
      options.progress({ ...status, notCopied: [...notCopied] });
      const stopped = await readStoppedChats(options.storageDir);
      const leaveInV1 = (session: MigrationSession, reason: ChatNotCopied["reason"]) => {
        notCopied.push({ id: session.id, title: session.title, reason });
      };
      const exporter = converter;
      // A problem with one chat leaves that chat in v1 and the others are still
      // copied. A converter or v2 that fails (5xx) or cannot be reached stops the run.
      const copyChat = async (session: MigrationSession): Promise<void> => {
        await options.copying?.({ id: session.id, title: session.title });
        let exported: { status: number; json: unknown };
        try {
          exported = await exporter.fetchJson(`/api/experimental/session/${encodeURIComponent(session.id)}/export`, {
            directory: session.directory, maxResponseBytes: MAX_CHAT_EXPORT_BYTES,
          });
        } catch (error) {
          if (error instanceof OpencodeV2ResponseTooLargeError) return leaveInV1(session, "too_large");
          throw error;
        }
        if (exported.status >= 500) {
          throw new Error("Could not export a converted chat. Retry migration; existing v2 chats will be skipped.");
        }
        if (exported.status !== 200 || !isRecord(exported.json) || !isRecord(exported.json.data)) return leaveInV1(session, "rejected");
        const result = await options.target.fetchJson("/api/experimental/session/import", {
          method: "POST", directory: session.directory,
          body: { ...exported.json.data, location: { directory: session.directory } }, timeoutMs: 30_000,
        });
        if (result.status === 409) status.skipped++;
        else if (result.status === 200) status.imported++;
        else if (result.status >= 400 && result.status < 500) leaveInV1(session, "rejected");
        else throw new Error(`Could not import a chat (${result.status}). Retry migration; existing v2 chats will be skipped.`);
      };
      const pending = new Map(sessions.map((session) => [session.id, session]));
      while (pending.size) {
        let advanced = false;
        for (const session of pending.values()) {
          if (session.parentId && pending.has(session.parentId)) continue;
          // A chat an earlier run already copied is skipped before it is
          // exported again; the import's own duplicate check stays the backstop.
          const existing = await options.target.fetchJson(`/api/session/${encodeURIComponent(session.id)}`, { directory: session.directory, timeoutMs: 30_000 });
          if (existing.status === 200 && nativeSession(existing.json)?.id === session.id) status.skipped++;
          else if (stopped.has(session.id)) leaveInV1(session, "stopped");
          else await copyChat(session);
          pending.delete(session.id);
          advanced = true;
          options.progress({ ...status, notCopied: [...notCopied] });
        }
        if (!advanced) throw new Error("History contains circular parent chats. Your v1 history is unchanged.");
      }
    }
    options.progress({ ...status, notCopied: [...notCopied], state: "completed", phase: undefined });
  } catch (error) {
    options.progress({ ...status, notCopied: [...notCopied], state: "error", phase: undefined, error: error instanceof Error ? error.message : "Migration failed. Retry migration." });
  } finally {
    try { await converter?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

/** The first message the migration process receives. */
export interface MigrationProcessRequest extends MigrationRequest {
  target: OpencodeV2Connection;
}

/** What the migration process reports back. */
export type MigrationProcessMessage =
  | { type: "progress"; status: EngineV2MigrationStatus }
  | { type: "scratch"; scratch: MigrationScratch }
  | { type: "copying"; chat: { id: string; title: string } };

function isMigrationProcessMessage(value: unknown): value is MigrationProcessMessage {
  return isRecord(value) && ((value.type === "progress" && isRecord(value.status))
    || (value.type === "scratch" && isRecord(value.scratch) && typeof value.scratch.directory === "string")
    || (value.type === "copying" && isRecord(value.chat) && typeof value.chat.id === "string" && typeof value.chat.title === "string"));
}

/**
 * Electron runs the OpenWork server in its main process, where a migration
 * that runs out of memory quits the whole app, and again on every retry.
 * There the migration runs in its own Node process instead: a crash ends only
 * that process and is reported as a failed migration, and the snapshot and
 * converter it leaves behind are removed here. A separate process gets no more
 * memory (Electron caps every V8 heap at 4 GiB), so the chat it died on is
 * remembered and the next migration copies the others.
 */
export async function runOpencodeV1HistoryMigration(options: MigrationRequest & {
  target: Pick<ManagedOpencodeV2Server, "fetchJson" | "url" | "username" | "password">;
  progress: (status: EngineV2MigrationStatus) => void;
}): Promise<void> {
  if (typeof process.versions.electron !== "string") return migrateOpencodeV1History(options);
  const { target, progress, ...migration } = options;
  let last: EngineV2MigrationStatus = { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0 };
  let scratch: MigrationScratch | undefined;
  let copying: { id: string; title: string } | undefined;
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "opencode-v2-migration-process.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "json",
    windowsHide: true,
  });
  child.on("message", (message) => {
    if (!isMigrationProcessMessage(message)) return;
    if (message.type === "scratch") {
      scratch = message.scratch;
      return;
    }
    if (message.type === "copying") {
      copying = message.chat;
      return;
    }
    // Progress follows every finished chat: a crash after it was not that chat's doing.
    copying = undefined;
    last = message.status;
    progress(message.status);
  });
  // A failed spawn can emit several errors (spawn, then the queued send); an
  // unhandled one would throw in the very process this protects.
  const ended = new Promise<{ code: number | null; reason: string }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, reason: error.message }));
    child.once("close", (code, signal) => resolve({ code, reason: signal ?? `exit ${String(code)}` }));
  });
  child.send({
    ...migration, target: { url: target.url, username: target.username, password: target.password },
  } satisfies MigrationProcessRequest);
  const { code, reason } = await ended;
  if (code !== 0 && scratch) {
    // The process died before its own cleanup ran.
    if (scratch.converterPid) {
      try { process.kill(scratch.converterPid); } catch { /* already gone */ }
    }
    await rm(scratch.directory, { recursive: true, force: true });
  }
  if (last.state === "completed" || last.state === "error") return;
  if (copying) {
    try { await rememberStoppedChat(migration.storageDir, copying); } catch { copying = undefined; }
  }
  progress({
    ...last, state: "error", phase: undefined,
    error: copying
      ? `Chat migration stopped while copying "${copying.title || copying.id}" (${reason}). Retry migration to copy the other chats; that chat stays in OpenCode v1.`
      : `Chat migration stopped unexpectedly (${reason}). Retry migration; existing v2 chats will be skipped.`,
  });
}
