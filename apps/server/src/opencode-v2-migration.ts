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
  /** Chats copied without their largest outputs and attachments; the full versions stay in v1. */
  trimmed?: Array<{ id: string; title: string }>;
}

export interface ChatNotCopied {
  id: string;
  title: string;
  /**
   * `too_large`: its export is over MAX_CHAT_EXPORT_BYTES, even trimmed.
   * `rejected`: the converter or v2 refused this chat. `stopped`: the migration
   * process died while copying it, and again while copying it trimmed.
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
/** A chat too large to copy whole is copied with its largest values replaced until it is under this. */
const TRIMMED_CHAT_BYTES = 128 * 1024 ** 2;
/** Trimming replaces string values at least this long; titles, paths and ids stay. */
const TRIMMED_VALUE_MIN_CHARS = 4 * 1024;
const TRIMMED_VALUE_NOTE = "Left out when this chat was upgraded to OpenCode v2 because it was too large. The full version is in OpenCode v1.";
/** A replaced `url` stays a URL: a small text file holding the note, so a file or image part stays valid. */
const TRIMMED_URL = `data:text/plain;base64,${Buffer.from(TRIMMED_VALUE_NOTE).toString("base64")}`;
/** A trimmed snapshot never needs accounts or credentials. */
const ACCOUNT_TABLES = new Set(["account", "account_state", "control_account", "credential"]);

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

/**
 * Whether v1 has a chat created at or after `since` (ms): one that no finished
 * migration copied, so v2 cannot open it. A missing or unreadable database has none.
 */
export async function hasV1ChatsSince(database: string, since: number): Promise<boolean> {
  try {
    await access(database);
    const db = typeof process.versions.bun === "string"
      ? new (await import("bun:sqlite")).Database(database, { readonly: true })
      : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
    try {
      return isRecord(db.prepare("SELECT 1 AS found FROM session WHERE time_created >= ? LIMIT 1").get(since));
    } finally { db.close(); }
  } catch {
    return false;
  }
}

/** The calls a trimmed snapshot needs, from bun:sqlite or node:sqlite. */
interface SnapshotDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: Array<string | number>): unknown[];
    get(...params: Array<string | number>): unknown;
    run(...params: Array<string | number>): unknown;
  };
  close(): void;
}

async function openSnapshotDatabase(path: string): Promise<SnapshotDatabase> {
  return typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(path)
    : new (await importNodeSqlite()).DatabaseSync(path);
}

function stringColumn(row: unknown, key: string): string {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "string" ? value : "";
}

function numberColumn(row: unknown, key: string): number {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A second private snapshot for chats too large to copy whole: only those
 * chats, the session rows of their parents (so a sub-chat keeps its parent)
 * and the rows the schema needs, with each chat trimmed. The v1 database is
 * only read, in one transaction.
 */
async function writeTrimmedSnapshot(source: string, destination: string, chatIds: string[]): Promise<void> {
  const db = await openSnapshotDatabase(destination);
  try {
    // Tables are created in schema order, not dependency order.
    db.exec("PRAGMA foreign_keys = OFF");
    const uri = `file:${source.replace(/[%?#]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}?mode=ro`;
    db.exec(`ATTACH DATABASE '${uri.replaceAll("'", "''")}' AS src`);
    db.exec("BEGIN");
    const objects = db.prepare("SELECT type, name, sql FROM src.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const tables = objects.filter((row) => stringColumn(row, "type") === "table");
    if (!tables.some((row) => stringColumn(row, "name") === "session")) throw new Error("The v1 history could not be read.");
    db.exec("CREATE TEMP TABLE pick (id TEXT PRIMARY KEY, chat INTEGER NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO temp.pick (id, chat) SELECT value, 1 FROM json_each(?)").run(JSON.stringify(chatIds));
    db.exec(`WITH RECURSIVE up(id) AS (
        SELECT parent_id FROM src.session WHERE id IN (SELECT id FROM temp.pick) AND parent_id IS NOT NULL
        UNION SELECT s.parent_id FROM src.session s JOIN up ON s.id = up.id WHERE s.parent_id IS NOT NULL)
      INSERT OR IGNORE INTO temp.pick (id, chat) SELECT id, 0 FROM up`);
    const chats = "(SELECT id FROM temp.pick WHERE chat = 1)";
    await ensureMigrationDiskSpace({
      directory: dirname(destination),
      neededBytes: numberColumn(db.prepare(`SELECT
        (SELECT coalesce(sum(length(data)), 0) FROM src.part WHERE session_id IN ${chats})
        + (SELECT coalesce(sum(length(data)), 0) FROM src.message WHERE session_id IN ${chats}) AS size`).get(), "size"),
    });
    for (const table of tables) db.exec(stringColumn(table, "sql"));
    for (const table of tables) {
      const name = stringColumn(table, "name");
      if (ACCOUNT_TABLES.has(name)) continue;
      const columns = db.prepare("SELECT name FROM pragma_table_info(?, 'src')").all(name).map((row) => stringColumn(row, "name"));
      const where = name === "session" || name === "session_v2" ? "WHERE id IN (SELECT id FROM temp.pick)"
        : columns.includes("session_id") ? `WHERE session_id IN ${chats}`
          : columns.includes("aggregate_id") ? `WHERE aggregate_id IN ${chats}`
            : "";
      db.exec(`INSERT INTO main.${quoteIdentifier(name)} SELECT * FROM src.${quoteIdentifier(name)} ${where}`);
    }
    db.exec("COMMIT");
    db.exec("DETACH DATABASE src");
    for (const object of objects.filter((row) => stringColumn(row, "type") !== "table")) db.exec(stringColumn(object, "sql"));
    for (const id of chatIds) trimSnapshotChat(db, id);
  } finally { db.close(); }
  await chmod(destination, 0o600);
}

/**
 * Replace a chat's largest string values, row by row from the largest part or
 * message, until the chat is under TRIMMED_CHAT_BYTES. Values stay strings, so
 * each part keeps its type and shape: a tool keeps its call and its output
 * becomes the note, and a replaced `url` (an inline file or image) becomes a
 * small text file holding the note. SQLite does the replacing, so no value is
 * bound by JavaScript's string limit.
 */
function trimSnapshotChat(db: SnapshotDatabase, chatId: string): void {
  const rows = db.prepare(`SELECT 'part' AS tbl, id, length(data) AS size FROM part WHERE session_id = ?1
    UNION ALL SELECT 'message', id, length(data) FROM message WHERE session_id = ?1 ORDER BY size DESC`).all(chatId);
  let size = rows.reduce<number>((sum, row) => sum + numberColumn(row, "size"), 0);
  for (const row of rows) {
    if (size <= TRIMMED_CHAT_BYTES) return;
    const table = stringColumn(row, "tbl") === "message" ? "message" : "part";
    const id = stringColumn(row, "id");
    const values = db.prepare(`SELECT t.fullkey AS path, t.key AS key FROM ${table}, json_tree(${table}.data) t
      WHERE ${table}.id = ? AND t.type = 'text' AND length(t.atom) >= ?`).all(id, TRIMMED_VALUE_MIN_CHARS);
    const replacements = values.flatMap((value) => {
      const path = stringColumn(value, "path");
      return stringColumn(value, "key") === "url" && path.endsWith(".url")
        ? [path, TRIMMED_URL, `${path.slice(0, -".url".length)}.mime`, "text/plain"]
        : [path, TRIMMED_VALUE_NOTE];
    });
    // Path/value pairs, under SQLite's 127 arguments per function call.
    for (let start = 0; start < replacements.length; start += 100) {
      const pairs = replacements.slice(start, start + 100);
      db.prepare(`UPDATE ${table} SET data = json_replace(data${", ?, ?".repeat(pairs.length / 2)}) WHERE id = ?`).run(...pairs, id);
    }
    size -= numberColumn(row, "size") - numberColumn(db.prepare(`SELECT length(data) AS size FROM ${table} WHERE id = ?`).get(id), "size");
  }
}

/**
 * A chat a migration process died on. It gets one trimmed copy; `final` once
 * that also failed, so later migrations leave it in v1 without trying again.
 */
interface StoppedChat {
  title: string;
  final: boolean;
}

async function readStoppedChats(storageDir: string): Promise<Map<string, StoppedChat>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(storageDir, STOPPED_CHATS_FILE), "utf8")); } catch { return new Map(); }
  if (!Array.isArray(parsed)) return new Map();
  return new Map(parsed.filter(isRecord).filter((chat) => typeof chat.id === "string")
    .map((chat) => [String(chat.id), { title: typeof chat.title === "string" ? chat.title : "", final: chat.final === true }]));
}

async function writeStoppedChats(storageDir: string, chats: Map<string, StoppedChat>): Promise<void> {
  const path = join(storageDir, STOPPED_CHATS_FILE);
  const entries = [...chats].map(([id, chat]) => ({ id, title: chat.title, ...(chat.final ? { final: true } : {}) }));
  await writeFile(`${path}.tmp`, JSON.stringify(entries), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function rememberStoppedChat(storageDir: string, chat: { id: string; title: string }, final: boolean): Promise<void> {
  const chats = await readStoppedChats(storageDir);
  chats.set(chat.id, { title: chat.title, final });
  await writeStoppedChats(storageDir, chats);
}

async function forgetStoppedChat(storageDir: string, id: string): Promise<void> {
  const chats = await readStoppedChats(storageDir);
  if (chats.delete(id)) await writeStoppedChats(storageDir, chats);
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

type CopyOutcome = "imported" | "skipped" | ChatNotCopied["reason"];

/** Let the pinned engine transform a private snapshot, then use its native import API. */
export async function migrateOpencodeV1History(options: MigrationRequest & {
  target: Pick<ManagedOpencodeV2Server, "fetchJson">;
  progress: (status: EngineV2MigrationStatus) => void;
  /** Lets a supervising process remove the scratch if this one dies before its own cleanup. */
  scratch?: (scratch: MigrationScratch) => void;
  /** Called (and awaited) before each chat is exported, so a supervisor knows which chat a crash was on. */
  copying?: (chat: { id: string; title: string }, trimmed: boolean) => Promise<void> | void;
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
  const trimmed: Array<{ id: string; title: string }> = [];
  const report = (patch: Partial<EngineV2MigrationStatus> = {}) =>
    options.progress({ ...status, notCopied: [...notCopied], trimmed: [...trimmed], ...patch });
  const leaveInV1 = (session: MigrationSession, reason: ChatNotCopied["reason"]) => {
    notCopied.push({ id: session.id, title: session.title, reason });
  };

  /** Run OpenCode's own v1 → v2 conversion on `directory`/opencode.db, in a converter with no user config, credentials or plugins. */
  const convertSnapshot = async (directory: string): Promise<ManagedOpencodeV2Server> => {
    const home = join(directory, "home");
    await mkdir(home, { recursive: true });
    const started = await createManagedOpencodeV2Server({ bin: options.bin, rootDir: directory, env: {
      HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1",
    } });
    options.scratch?.({ directory: root, converterPid: started.childPid });
    try {
      // Conversion time grows with history size: 10 minutes, plus 3 per GB of snapshot.
      const deadline = Date.now() + conversionTimeoutMs(await fileSize(join(directory, "opencode.db")));
      while (true) {
        const result = await started.fetchJson("/api/experimental/migration/v1");
        if (result.status !== 200 || !isRecord(result.json)) throw new Error("Could not verify OpenCode's history conversion.");
        if (result.json.status === "completed") return started;
        if (result.json.status === "error") throw new Error("OpenCode could not convert the history snapshot. Your v1 history is unchanged.");
        if (Date.now() > deadline) throw new Error("History conversion timed out. Retry migration.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      await started.close();
      throw error;
    }
  };

  // A problem with one chat leaves that chat in v1 and the others are still
  // copied. A converter or v2 that fails (5xx) or cannot be reached stops the run.
  const copyChat = async (from: ManagedOpencodeV2Server, session: MigrationSession, trimmedCopy: boolean): Promise<CopyOutcome> => {
    await options.copying?.({ id: session.id, title: session.title }, trimmedCopy);
    let exported: { status: number; json: unknown };
    try {
      exported = await from.fetchJson(`/api/experimental/session/${encodeURIComponent(session.id)}/export`, {
        directory: session.directory, maxResponseBytes: MAX_CHAT_EXPORT_BYTES,
      });
    } catch (error) {
      if (error instanceof OpencodeV2ResponseTooLargeError) return "too_large";
      throw error;
    }
    if (exported.status >= 500) {
      throw new Error("Could not export a converted chat. Retry migration; existing v2 chats will be skipped.");
    }
    if (exported.status !== 200 || !isRecord(exported.json) || !isRecord(exported.json.data)) return "rejected";
    const result = await options.target.fetchJson("/api/experimental/session/import", {
      method: "POST", directory: session.directory,
      body: { ...exported.json.data, location: { directory: session.directory } }, timeoutMs: 30_000,
    });
    if (result.status === 409) return "skipped";
    if (result.status === 200) return "imported";
    if (result.status >= 400 && result.status < 500) return "rejected";
    throw new Error(`Could not import a chat (${result.status}). Retry migration; existing v2 chats will be skipped.`);
  };

  /** Visit chats with parents before their sub-chats, reporting progress after each. */
  const inParentOrder = async (sessions: MigrationSession[], visit: (session: MigrationSession) => Promise<void>) => {
    const pending = new Map(sessions.map((session) => [session.id, session]));
    while (pending.size) {
      let advanced = false;
      for (const session of pending.values()) {
        if (session.parentId && pending.has(session.parentId)) continue;
        await visit(session);
        pending.delete(session.id);
        advanced = true;
        report();
      }
      if (!advanced) throw new Error("History contains circular parent chats. Your v1 history is unchanged.");
    }
  };

  /**
   * One more attempt for chats too large to copy whole and chats a migration
   * process died on: a second snapshot holding only them, with their largest
   * values replaced (writeTrimmedSnapshot), converted and copied like the rest.
   */
  const copyTrimmed = async (chats: Array<{ session: MigrationSession; stopped: boolean }>) => {
    const directory = join(root, "trimmed");
    let trimmedConverter: ManagedOpencodeV2Server | undefined;
    try {
      try {
        await mkdir(directory, { recursive: true });
        const database = join(directory, "opencode.db");
        await writeTrimmedSnapshot(options.source, database, chats.map((chat) => chat.session.id));
        await clearStaleConversionMarker(database);
        trimmedConverter = await convertSnapshot(directory);
      } catch {
        // A second chance only: without it these chats stay in v1, as they would have.
        for (const chat of chats) leaveInV1(chat.session, chat.stopped ? "stopped" : "too_large");
        return;
      }
      const from = trimmedConverter;
      const stopped = new Set(chats.filter((chat) => chat.stopped).map((chat) => chat.session.id));
      // Chats that already stopped a migration go first: if one stops it again it
      // stays in v1 for good, and the run that finishes reports every trimmed chat.
      const ordered = [...chats].sort((a, b) => Number(b.stopped) - Number(a.stopped)).map((chat) => chat.session);
      await inParentOrder(ordered, async (session) => {
        const outcome = await copyChat(from, session, true);
        if (outcome === "imported") trimmed.push({ id: session.id, title: session.title });
        else if (outcome === "skipped") status.skipped++;
        else leaveInV1(session, stopped.has(session.id) ? "stopped" : outcome);
        if (!stopped.has(session.id)) return;
        if (outcome === "imported" || outcome === "skipped") await forgetStoppedChat(options.storageDir, session.id);
        else await rememberStoppedChat(options.storageDir, session, true);
      });
    } finally {
      await trimmedConverter?.close();
    }
  };

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
    report();
    if (sessions.length) {
      converter = await convertSnapshot(root);
      if (options.backup) {
        const backupPath = await backupV2Database(options.backup);
        if (backupPath) status.backupPath = backupPath;
      }
      status.phase = "copying";
      report();
      const from = converter;
      const stopped = await readStoppedChats(options.storageDir);
      const toTrim: Array<{ session: MigrationSession; stopped: boolean }> = [];
      await inParentOrder(sessions, async (session) => {
        // A chat an earlier run already copied is skipped before it is
        // exported again; the import's own duplicate check stays the backstop.
        const existing = await options.target.fetchJson(`/api/session/${encodeURIComponent(session.id)}`, { directory: session.directory, timeoutMs: 30_000 });
        if (existing.status === 200 && nativeSession(existing.json)?.id === session.id) {
          status.skipped++;
          return;
        }
        const stoppedChat = stopped.get(session.id);
        if (stoppedChat?.final) return leaveInV1(session, "stopped");
        if (stoppedChat) return void toTrim.push({ session, stopped: true });
        const outcome = await copyChat(from, session, false);
        if (outcome === "imported") status.imported++;
        else if (outcome === "skipped") status.skipped++;
        else if (outcome === "too_large") toTrim.push({ session, stopped: false });
        else leaveInV1(session, outcome);
      });
      await converter.close();
      converter = undefined;
      if (toTrim.length) await copyTrimmed(toTrim);
    }
    report({ state: "completed", phase: undefined });
  } catch (error) {
    report({ state: "error", phase: undefined, error: error instanceof Error ? error.message : "Migration failed. Retry migration." });
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
  | { type: "copying"; chat: { id: string; title: string }; trimmed: boolean };

function isMigrationProcessMessage(value: unknown): value is MigrationProcessMessage {
  return isRecord(value) && ((value.type === "progress" && isRecord(value.status))
    || (value.type === "scratch" && isRecord(value.scratch) && typeof value.scratch.directory === "string")
    || (value.type === "copying" && isRecord(value.chat) && typeof value.chat.id === "string" && typeof value.chat.title === "string"
      && typeof value.trimmed === "boolean"));
}

/**
 * Electron runs the OpenWork server in its main process, where a migration
 * that runs out of memory quits the whole app, and again on every retry.
 * There the migration runs in its own Node process instead: a crash ends only
 * that process and is reported as a failed migration, and the snapshot and
 * converter it leaves behind are removed here. A separate process gets no more
 * memory (Electron caps every V8 heap at 4 GiB), so the chat it died on is
 * remembered: the next migration copies the others and tries that chat once
 * trimmed, and a death during that attempt leaves it in v1 for good.
 */
export async function runOpencodeV1HistoryMigration(options: MigrationRequest & {
  target: Pick<ManagedOpencodeV2Server, "fetchJson" | "url" | "username" | "password">;
  progress: (status: EngineV2MigrationStatus) => void;
}): Promise<void> {
  if (typeof process.versions.electron !== "string") return migrateOpencodeV1History(options);
  const { target, progress, ...migration } = options;
  let last: EngineV2MigrationStatus = { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0 };
  let scratch: MigrationScratch | undefined;
  let copying: { chat: { id: string; title: string }; trimmed: boolean } | undefined;
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
      copying = { chat: message.chat, trimmed: message.trimmed };
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
    try { await rememberStoppedChat(migration.storageDir, copying.chat, copying.trimmed); } catch { copying = undefined; }
  }
  const title = copying ? copying.chat.title || copying.chat.id : "";
  progress({
    ...last, state: "error", phase: undefined,
    error: copying?.trimmed
      ? `Chat migration stopped while copying "${title}" without its largest outputs (${reason}). Retry migration to copy the other chats; that chat stays in OpenCode v1.`
      : copying
        ? `Chat migration stopped while copying "${title}" (${reason}). Retry migration; that chat will be tried once more without its largest outputs and attachments.`
        : `Chat migration stopped unexpectedly (${reason}). Retry migration; existing v2 chats will be skipped.`,
  });
}
