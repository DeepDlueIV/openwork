import { randomBytes } from "node:crypto";
import { importNodeSqlite } from "./runtime-db.js";

/** The engine's projected SQLite format, pinned and checked before any target write. */
export interface HistoryDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: Array<string | number>): unknown[];
    get(...params: Array<string | number>): unknown;
    run(...params: Array<string | number>): unknown;
  };
  close(): void;
}

export async function openHistoryDatabase(path: string): Promise<HistoryDatabase> {
  return typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(path)
    : new (await importNodeSqlite()).DatabaseSync(path);
}

export function stringField(row: unknown, key: string): string {
  if (typeof row !== "object" || row === null || !(key in row)) return "";
  const value: unknown = Reflect.get(row, key);
  return typeof value === "string" ? value : "";
}

export function numberField(row: unknown, key: string): number {
  if (typeof row !== "object" || row === null || !(key in row)) return 0;
  const value: unknown = Reflect.get(row, key);
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : 0;
}

export const LEGACY_OMISSION = "Left out when this chat was upgraded to OpenCode v2 because it was too large. The full version is in OpenCode v1.";
const LEGACY_FILE = Buffer.from(LEGACY_OMISSION).toString("base64");
const LEGACY_URL = `data:text/plain;base64,${LEGACY_FILE}`;
const LEGACY_TARGET = 128 * 1024 ** 2;
const VALUE_THRESHOLD = 4096;
const BATCH_ROWS = 64;

function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

export function attachHistory(db: HistoryDatabase, path: string, name: string): void {
  const uri = `file:${path.replace(/[%?#]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}?mode=ro`;
  db.exec(`ATTACH DATABASE '${uri.replaceAll("'", "''")}' AS ${identifier(name)}`);
}

function transaction(db: HistoryDatabase, run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try { run(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}

const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Reconstruct only the *selection* made by the retired trimmer, for provenance
 * checks during repair. Changes a TEMP probe, never the source or the new copy. */
function legacySelection(db: HistoryDatabase, sessionId: string): Set<string> {
  const rows = db.prepare(`SELECT 'part' AS tbl, id, length(data) AS size FROM part WHERE session_id = ?1
    UNION ALL SELECT 'message', id, length(data) FROM message WHERE session_id = ?1 ORDER BY size DESC`).all(sessionId);
  let size = rows.reduce<number>((total, row) => total + numberField(row, "size"), 0);
  const selected = new Set<string>();
  db.exec("CREATE TEMP TABLE IF NOT EXISTS legacy_probe (data TEXT)");
  for (const row of rows) {
    if (size <= LEGACY_TARGET) break;
    const table = stringField(row, "tbl") === "part" ? "part" : "message";
    const id = stringField(row, "id");
    db.exec("DELETE FROM temp.legacy_probe");
    db.prepare(`INSERT INTO temp.legacy_probe SELECT data FROM ${table} WHERE id = ?`).run(id);
    const paths = db.prepare(`SELECT fullkey AS path, key FROM legacy_probe, json_tree(data)
      WHERE type = 'text' AND length(atom) >= ?`).all(VALUE_THRESHOLD);
    for (const entry of paths) {
      const path = stringField(entry, "path");
      selected.add(`${table}:${id}:${path}`);
      if (stringField(entry, "key") === "url" && path.endsWith(".url")) {
        db.prepare("UPDATE temp.legacy_probe SET data = json_replace(data, ?, ?, ?, 'text/plain')")
          .run(path, LEGACY_URL, `${path.slice(0, -4)}.mime`);
      } else db.prepare("UPDATE temp.legacy_probe SET data = json_replace(data, ?, ?)").run(path, LEGACY_OMISSION);
    }
    size -= numberField(row, "size") - numberField(db.prepare("SELECT length(data) AS size FROM temp.legacy_probe").get(), "size");
  }
  return selected;
}

/** Native conversion reads a whole session into JS. Substitute reversible,
 * unique payload references first; SQLite keeps the full values off that heap.
 * Each session and its payload map commit together, making restart idempotent. */
export async function externalizeHistory(db: HistoryDatabase, signal?: AbortSignal): Promise<void> {
  db.exec(`CREATE TABLE IF NOT EXISTS openwork_payload (
    token TEXT PRIMARY KEY, value TEXT NOT NULL, legacy TEXT NOT NULL, prefix TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS openwork_externalized (session_id TEXT PRIMARY KEY)`);
  const sessions = db.prepare("SELECT id FROM session ORDER BY id").all();
  for (const session of sessions) {
    signal?.throwIfAborted();
    const sessionId = stringField(session, "id");
    if (db.prepare("SELECT 1 FROM openwork_externalized WHERE session_id = ?").get(sessionId)) continue;
    const selected = legacySelection(db, sessionId);
    transaction(db, () => {
      for (const table of ["message", "part"]) {
        const rows = db.prepare(`SELECT id FROM ${table} WHERE session_id = ? ORDER BY id`).all(sessionId);
        for (const row of rows) {
          const id = stringField(row, "id");
          const paths = db.prepare(`SELECT fullkey AS path, key FROM ${table}, json_tree(${table}.data)
            WHERE ${table}.id = ? AND type = 'text' AND length(atom) >= ?`).all(id, VALUE_THRESHOLD);
          for (const entry of paths) {
            const path = stringField(entry, "path");
            const token = `OWPAYLOAD${randomBytes(24).toString("hex")}END`;
            const omitted = selected.has(`${table}:${id}:${path}`);
            const header = stringField(db.prepare(`SELECT CASE WHEN ? = 'url' AND json_extract(data, ?) LIKE 'data:%,%'
              THEN substr(json_extract(data, ?), 1, instr(json_extract(data, ?), ',')) ELSE '' END AS header
              FROM ${table} WHERE id = ?`).get(stringField(entry, "key"), path, path, path, id), "header");
            // A data URL is decoded by the native converter. A base64 reference
            // survives that normalization, and also survives tool file URIs.
            if (header) {
              const encodedToken = Buffer.from(token).toString("base64");
              db.prepare(`INSERT INTO openwork_payload SELECT ?, substr(json_extract(data, ?), ?), ?, ? FROM ${table} WHERE id = ?`)
                .run(encodedToken, path, header.length + 1, omitted ? LEGACY_FILE : "", header, id);
              if (!header.endsWith(";base64,")) encodeDataUrl(db, encodedToken);
              if (!omitted) db.prepare("UPDATE openwork_payload SET legacy = value WHERE token = ?").run(encodedToken);
              const normalizedHeader = header.endsWith(";base64,") ? header : `${header.slice(0, -1)};base64,`;
              db.prepare(`UPDATE ${table} SET data = json_replace(data, ?, ?) WHERE id = ?`).run(path, normalizedHeader + encodedToken, id);
              // Tool file URLs keep their original encoding; keep a separate
              // full-URI mapping ahead of the normalized attachment mapping.
              const uriToken = normalizedHeader + encodedToken;
              db.prepare(`INSERT INTO openwork_payload SELECT ?, json_extract(data, ?), ?, '' FROM original.${table} WHERE id = ?`)
                .run(uriToken, path, omitted ? LEGACY_URL : "", id);
              if (!omitted) db.prepare("UPDATE openwork_payload SET legacy = value WHERE token = ?").run(uriToken);
            } else {
              db.prepare(`INSERT INTO openwork_payload SELECT ?, json_extract(data, ?), ?, '' FROM ${table} WHERE id = ?`)
                .run(token, path, omitted ? LEGACY_OMISSION : "", id);
              if (!omitted) db.prepare("UPDATE openwork_payload SET legacy = value WHERE token = ?").run(token);
              db.prepare(`UPDATE ${table} SET data = json_replace(data, ?, ?) WHERE id = ?`).run(path, token, id);
            }
          }
        }
      }
      db.prepare("INSERT INTO openwork_externalized VALUES (?)").run(sessionId);
    });
    await yieldTurn();
  }
}

/** Percent-encoded data URLs need normalization into base64 too. Read bounded
 * slices, retain incomplete percent escapes and base64 triples across slices. */
function encodeDataUrl(db: HistoryDatabase, token: string): void {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS payload_chunks (n INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  db.exec("DELETE FROM temp.payload_chunks");
  let offset = 1;
  let suffix = "";
  let remainder = Buffer.alloc(0);
  let n = 0;
  while (true) {
    const chunk = stringField(db.prepare("SELECT substr(value, ?, 65536) AS value FROM openwork_payload WHERE token = ?").get(offset, token), "value");
    if (!chunk) break;
    offset += Array.from(chunk).length;
    let text = suffix + chunk;
    const tail = /%[0-9a-f]?$/i.exec(text);
    suffix = tail?.[0] ?? "";
    text = text.slice(0, text.length - suffix.length);
    const bytes: number[] = [];
    for (let at = 0; at < text.length;) {
      if (text[at] === "%") {
        const hex = text.slice(at + 1, at + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error("Invalid data URL; the original history is unchanged.");
        bytes.push(parseInt(hex, 16)); at += 3;
      } else {
        const point = text.codePointAt(at);
        if (point === undefined) break;
        bytes.push(...Buffer.from(String.fromCodePoint(point)));
        at += point > 0xffff ? 2 : 1;
      }
    }
    const joined = Buffer.concat([remainder, Buffer.from(bytes)]);
    const end = joined.length - joined.length % 3;
    db.prepare("INSERT INTO temp.payload_chunks VALUES (?, ?)").run(n++, joined.subarray(0, end).toString("base64"));
    remainder = joined.subarray(end);
  }
  if (suffix) throw new Error("Invalid data URL; the original history is unchanged.");
  db.prepare("INSERT INTO temp.payload_chunks VALUES (?, ?)").run(n, remainder.toString("base64"));
  db.prepare("UPDATE openwork_payload SET value = (SELECT group_concat(data, '') FROM (SELECT data FROM temp.payload_chunks ORDER BY n)) WHERE token = ?").run(token);
}

/** Rehydrate native projections within SQLite, never JSON.parse/stringify a
 * full message. Also retain exact legacy scalar candidates for safe repair. */
export async function restoreHistoryPayloads(db: HistoryDatabase, signal?: AbortSignal): Promise<void> {
  db.exec(`CREATE TABLE IF NOT EXISTS openwork_restored (message_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS openwork_legacy_value (message_id TEXT, path TEXT, value TEXT NOT NULL,
      PRIMARY KEY (message_id, path))`);
  let cursor = "";
  while (true) {
    const rows = db.prepare("SELECT id FROM session_message WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BATCH_ROWS);
    if (!rows.length) break;
    for (const row of rows) {
      signal?.throwIfAborted();
      const id = stringField(row, "id"); cursor = id;
      if (db.prepare("SELECT 1 FROM openwork_restored WHERE message_id = ?").get(id)) continue;
      transaction(db, () => {
        db.prepare(`INSERT OR IGNORE INTO openwork_legacy_value SELECT ?, t.fullkey, t.atom FROM session_message m, json_tree(m.data) t
          WHERE m.id = ? AND t.type = 'text' AND instr(t.atom, 'OWPAYLOAD') > 0`).run(id, id);
        // Base64 attachment references do not contain the unencoded prefix.
        db.prepare(`INSERT OR IGNORE INTO openwork_legacy_value SELECT ?, t.fullkey, t.atom FROM session_message m, json_tree(m.data) t
          WHERE m.id = ? AND t.type = 'text' AND EXISTS (SELECT 1 FROM openwork_payload p WHERE instr(t.atom, p.token) > 0)`).run(id, id);
        const tokens = db.prepare(`SELECT token FROM openwork_payload WHERE instr((SELECT data FROM session_message WHERE id = ?), token) > 0
          ORDER BY length(token) DESC`).all(id);
        for (const item of tokens) {
          const token = stringField(item, "token");
          db.prepare(`UPDATE openwork_legacy_value SET value = replace(value, ?, (SELECT legacy FROM openwork_payload WHERE token = ?))
            WHERE message_id = ? AND instr(value, ?) > 0`).run(token, token, id, token);
          db.prepare(`UPDATE session_message SET data = replace(data, ?,
            (SELECT substr(json_quote(value), 2, length(json_quote(value)) - 2) FROM openwork_payload WHERE token = ?)) WHERE id = ?`)
            .run(token, token, id);
        }
        if (db.prepare(`SELECT 1 FROM session_message m WHERE m.id = ? AND EXISTS
          (SELECT 1 FROM openwork_payload p WHERE instr(m.data, p.token) > 0)`).get(id)) throw new Error("Unresolved history payload");
        db.prepare("INSERT INTO openwork_restored VALUES (?)").run(id);
      });
    }
    await yieldTurn();
  }
}

function columns(db: HistoryDatabase, table: string, schema: string): string[] {
  return db.prepare(`SELECT name FROM pragma_table_info(?, ?) ORDER BY cid`).all(table, schema).map(row => stringField(row, "name"));
}

function sameSchema(db: HistoryDatabase, table: string): string {
  const target = columns(db, table, "main");
  const source = columns(db, table, "converted");
  if (!source.length || JSON.stringify([...target].sort()) !== JSON.stringify([...source].sort())) throw new Error(`Unsupported OpenCode history schema (${table}); nothing was overwritten. Missing: ${target.filter(name => !source.includes(name)).join(", ")}; extra: ${source.filter(name => !target.includes(name)).join(", ")}`);
  const shape = (schema: string) => db.prepare(`SELECT name, upper(type) AS type, "notnull", pk FROM pragma_table_info(?, ?) ORDER BY name`).all(table, schema);
  if (JSON.stringify(shape("main")) !== JSON.stringify(shape("converted"))) throw new Error(`Unsupported OpenCode history column types (${table}); nothing was overwritten.`);
  return target.map(identifier).join(", ");
}

/** The target engine must be stopped. Rows, their original v1 archive and the
 * checkpoint live in the same SQLite DB. A kill rolls back only the active batch. */
export async function copyHistoryBatches(options: {
  database: HistoryDatabase; sourceKey: string;
  progress(sessionId: string, outcome: "imported" | "skipped"): void;
  batch?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ imported: number; skipped: number }> {
  const db = options.database;
  const sessionColumns = sameSchema(db, "session_v2");
  const messageColumns = sameSchema(db, "session_message");
  const projectColumns = sameSchema(db, "project");
  sameSchema(db, "event_sequence");
  if (db.prepare("SELECT 1 FROM original.session s LEFT JOIN converted.session_v2 t ON t.id = s.id WHERE t.id IS NULL LIMIT 1").get()) {
    throw new Error("The native converter did not account for every original chat. Original history and staging were preserved.");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS openwork_history_copy (
      source_key TEXT, session_id TEXT, cursor INTEGER NOT NULL DEFAULT -1, completed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_key, session_id));
    CREATE TABLE IF NOT EXISTS openwork_v1_message (source_key TEXT, id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL, PRIMARY KEY (source_key, id));
    CREATE TABLE IF NOT EXISTS openwork_v1_part (source_key TEXT, id TEXT, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL, PRIMARY KEY (source_key, id));
    CREATE TABLE IF NOT EXISTS openwork_v1_session (source_key TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY (source_key, id));
    CREATE TABLE IF NOT EXISTS openwork_history_order (source_key TEXT, id TEXT, seq INTEGER NOT NULL, PRIMARY KEY (source_key, id))`);
  db.exec("PRAGMA foreign_keys = ON");
  transaction(db, () => {
    db.exec(`INSERT OR IGNORE INTO project (${projectColumns}) SELECT ${projectColumns} FROM converted.project`);
    db.prepare(`INSERT OR IGNORE INTO session_v2 (${sessionColumns}) SELECT ${sessionColumns} FROM converted.session_v2 s
      WHERE s.id IN (SELECT id FROM original.session) AND NOT EXISTS
        (SELECT 1 FROM openwork_history_copy c WHERE c.source_key = ? AND c.session_id = s.id AND c.completed = 1)`).run(options.sourceKey);
  });
  const sessions = db.prepare("SELECT id FROM converted.session_v2 WHERE id IN (SELECT id FROM original.session) ORDER BY id").all();
  let imported = 0;
  let skipped = 0;
  for (const session of sessions) {
    options.signal?.throwIfAborted();
    const id = stringField(session, "id");
    const checkpoint = db.prepare("SELECT cursor, completed FROM openwork_history_copy WHERE source_key = ? AND session_id = ?").get(options.sourceKey, id);
    if (numberField(checkpoint, "completed")) { skipped++; options.progress(id, "skipped"); continue; }
    // Reserve one stable ordering for the whole repair, persisted with its
    // checkpoint. Historical messages precede v2-only messages; their relative
    // order and payloads survive. Positive sequence numbers remain valid native
    // cursors. An interruption never computes a different prefix on resume.
    transaction(db, () => {
      if (checkpoint) return;
      db.prepare("INSERT INTO openwork_history_copy (source_key, session_id) VALUES (?, ?)").run(options.sourceKey, id);
      db.prepare(`INSERT INTO openwork_history_order SELECT ?, id, row_number() OVER (ORDER BY seq)
        FROM converted.session_message WHERE session_id = ?`).run(options.sourceKey, id);
      db.prepare(`INSERT INTO openwork_history_order SELECT ?1, t.id,
        (SELECT count(*) FROM converted.session_message WHERE session_id = ?2) + row_number() OVER (ORDER BY t.seq)
        FROM main.session_message t WHERE t.session_id = ?2 AND NOT EXISTS (SELECT 1 FROM converted.session_message s WHERE s.id = t.id)`)
        .run(options.sourceKey, id);
      const shift = numberField(db.prepare(`SELECT coalesce(max(seq), 0) + count(*) +
        (SELECT count(*) FROM converted.session_message WHERE session_id = ?1) + 1 AS shift FROM session_message WHERE session_id = ?1`).get(id), "shift");
      db.prepare("UPDATE session_message SET seq = seq + ? WHERE session_id = ?").run(shift, id);
      db.prepare(`UPDATE session_message SET seq = (SELECT seq FROM openwork_history_order o WHERE o.source_key = ? AND o.id = session_message.id)
        WHERE session_id = ?`).run(options.sourceKey, id);
    });
    let cursor = checkpoint ? numberField(checkpoint, "cursor") : -1;
    while (true) {
      options.signal?.throwIfAborted();
      const batch = db.prepare("SELECT id, seq FROM converted.session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(id, cursor, BATCH_ROWS);
      if (!batch.length) break;
      transaction(db, () => {
        for (const message of batch) {
          const messageId = stringField(message, "id");
          const existing = db.prepare("SELECT session_id, type FROM session_message WHERE id = ?").get(messageId);
          if (existing) {
            if (stringField(existing, "session_id") !== id || stringField(existing, "type") !== stringField(db.prepare("SELECT type FROM converted.session_message WHERE id = ?").get(messageId), "type")) {
              throw new Error("History message identity conflict; existing v2 messages were preserved.");
            }
            repairMessage(db, messageId);
          } else {
            const select = columns(db, "session_message", "main").map(column => column === "seq"
              ? "(SELECT seq FROM openwork_history_order WHERE source_key = ? AND id = m.id)" : `m.${identifier(column)}`).join(", ");
            db.prepare(`INSERT INTO session_message (${messageColumns}) SELECT ${select} FROM converted.session_message m WHERE m.id = ?`).run(options.sourceKey, messageId);
          }
          cursor = numberField(message, "seq");
        }
        db.prepare("UPDATE openwork_history_copy SET cursor = ? WHERE source_key = ? AND session_id = ?").run(cursor, options.sourceKey, id);
      });
      await options.batch?.();
      await yieldTurn();
    }
    // Archive every original row, including legacy fields the native projection
    // does not represent. Batches remain in SQLite, even for a single huge part.
    for (const table of ["message", "part"]) {
      let rowCursor = "";
      while (true) {
        options.signal?.throwIfAborted();
        const rows = db.prepare(`SELECT id FROM original.${table} WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`).all(id, rowCursor, BATCH_ROWS);
        if (!rows.length) break;
        const last = stringField(rows[rows.length - 1], "id");
        transaction(db, () => {
          const rawColumns = table === "message" ? "id, session_id, time_created, time_updated, data" : "id, message_id, session_id, time_created, time_updated, data";
          db.prepare(`INSERT OR IGNORE INTO openwork_v1_${table} SELECT ?, ${rawColumns} FROM original.${table}
            WHERE session_id = ? AND id > ? AND id <= ?`).run(options.sourceKey, id, rowCursor, last);
        });
        rowCursor = last;
        await options.batch?.();
        await yieldTurn();
      }
    }
    transaction(db, () => {
      const fields = columns(db, "session", "original").flatMap(column => [`'${column.replaceAll("'", "''")}'`, identifier(column)]).join(", ");
      db.prepare(`INSERT OR IGNORE INTO openwork_v1_session SELECT ?, id, json_object(${fields}) FROM original.session WHERE id = ?`).run(options.sourceKey, id);
      const missing = db.prepare(`SELECT 1 FROM converted.session_message s LEFT JOIN main.session_message t ON t.id = s.id
        WHERE s.session_id = ? AND (t.id IS NULL OR t.session_id != s.session_id OR t.type != s.type) LIMIT 1`).get(id);
      if (missing) throw new Error("History verification failed; migration can be resumed.");
      for (const table of ["message", "part"]) {
        if (db.prepare(`SELECT 1 FROM original.${table} s LEFT JOIN openwork_v1_${table} t ON t.id = s.id AND t.source_key = ?
          WHERE s.session_id = ? AND (t.id IS NULL OR t.data != s.data) LIMIT 1`).get(options.sourceKey, id)) throw new Error("Original history verification failed");
      }
      // Do not reset an existing sequence owner or rewind the event log.
      db.prepare(`INSERT INTO event_sequence (aggregate_id, seq, owner_id)
        SELECT ?, max(coalesce((SELECT max(seq) FROM session_message WHERE session_id = ?1), 0),
          coalesce((SELECT seq FROM converted.event_sequence WHERE aggregate_id = ?1), 0)), NULL
        ON CONFLICT(aggregate_id) DO UPDATE SET seq = max(event_sequence.seq, excluded.seq)`).run(id);
      db.prepare("UPDATE openwork_history_copy SET completed = 1 WHERE source_key = ? AND session_id = ?").run(options.sourceKey, id);
    });
    imported++;
    options.progress(id, "imported");
  }
  return { imported, skipped };
}

function repairMessage(db: HistoryDatabase, id: string): void {
  const paths = db.prepare(`SELECT t.fullkey AS path FROM session_message m, json_tree(m.data) t
    WHERE m.id = ? AND t.type = 'text' AND (instr(t.atom, ?) > 0 OR instr(t.atom, ?) > 0)`).all(id, LEGACY_OMISSION, LEGACY_FILE);
  for (const entry of paths) {
    const path = stringField(entry, "path");
    if (db.prepare(`SELECT 1 FROM converted.session_message s JOIN main.session_message t ON s.id = t.id
      WHERE s.id = ? AND (json_type(s.data, ?) IS NULL OR json_extract(s.data, ?) = json_extract(t.data, ?))`)
      .get(id, path, path, path)) continue;
    // Never replace an edited historical field. Equality with the reconstructed
    // old scalar is the provenance check; only the omitted scalar is restored.
    const match = db.prepare(`SELECT 1 FROM session_message m JOIN converted.openwork_legacy_value l ON l.message_id = m.id AND l.path = ?
      JOIN converted.session_message s ON s.id = m.id WHERE m.id = ? AND json_extract(m.data, ?) = l.value
        AND json_type(s.data, ?) = 'text'`).get(path, id, path, path);
    if (!match) throw new Error("A previously trimmed message was edited or its source changed. Its v2 version was preserved; repair needs reconciliation.");
    db.prepare(`UPDATE session_message SET data = json_replace(data, ?,
      (SELECT json_extract(data, ?) FROM converted.session_message WHERE id = ?)) WHERE id = ?`).run(path, path, id, id);
    // The retired trimmer also changed the MIME of inline files.
    const parent = path.slice(0, path.lastIndexOf("."));
    if (path.endsWith(".data") || path.endsWith(".uri") || path.endsWith(".url")) {
      const mimePath = `${parent}.mime`;
      db.prepare(`UPDATE session_message SET data = json_replace(data, ?,
        (SELECT json_extract(data, ?) FROM converted.session_message WHERE id = ?))
        WHERE id = ? AND json_extract(data, ?) = 'text/plain'
          AND (SELECT json_type(data, ?) FROM converted.session_message WHERE id = ?) = 'text'`)
        .run(mimePath, mimePath, id, id, mimePath, mimePath, id);
    }
  }
}
