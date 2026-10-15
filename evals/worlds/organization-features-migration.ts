import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql, { type Connection, type RowDataPacket } from "../../ee/packages/den-db/node_modules/mysql2/promise.js";
import { drizzle } from "../../ee/packages/den-db/node_modules/drizzle-orm/mysql2/index.js";
import { migrate } from "../../ee/packages/den-db/node_modules/drizzle-orm/mysql2/migrator.js";
import { migrateWith0097Compatibility, loadUpgradePlan, upgradeHistoryPrefix } from "../../ee/packages/den-db/scripts/migration-0097-compat.ts";
import { historyPrefix, loadMigrationPlan } from "../../ee/packages/den-db/scripts/migration-baseline.ts";

// A manually invoked database-upgrade world, not a MariaDB support/CI matrix.
// All destructive SQL is confined to explicitly named disposable lab schemas.
const root = path.resolve(import.meta.dirname, "../..");
const folder = path.join(root, "ee/packages/den-db/drizzle");
export const oldHash = "b544db5666c0be53acbb68851818cb4d99a5089239f2afba9dace972772fd49d";
export const newSql = readFileSync(path.join(folder, "0129_organization_features.sql"), "utf8");
export const plan = loadUpgradePlan(folder);
export const millis = plan.migrations[128].folderMillis;
const keys = ["installLinks", "mcpConnections", "modelsAnalytics", "auditLogs", "orgManagedDashboards", "slackAssistant", "slackAssistantHeadless", "headlessAutomations", "workbot"];
export const baselineImage = "ghcr.io/different-ai/openwork-den-api@sha256:a44a565f81c5ffb2e3c8acb613229abbaa578ff765c5f86ae8ae90eddb947bf2";
type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Bundle = { schema: string; journal: { entries: Entry[] }; migrations: string[] };
let bundle: Bundle | undefined;
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function originalSql() {
  const sql = execFileSync("git", ["-C", root, "show", "v0.18.57:ee/packages/den-db/drizzle/0129_organization_features.sql"], { encoding: "utf8", timeout: 30_000 });
  if (digest(sql) !== oldHash) throw new Error("Released migration bytes differ from the pinned original hash");
  return sql;
}
export function baseline(): Bundle {
  if (!bundle) {
    bundle = JSON.parse(execFileSync("podman", ["run", "--rm", "--name", "exp-mariadb-0129-baseline", "--entrypoint", "node", baselineImage, "-e", `const fs=require('fs'); const p='/app/ee/packages/den-db/dist/'; const j=JSON.parse(fs.readFileSync(p+'drizzle/meta/_journal.json','utf8')); process.stdout.write(JSON.stringify({schema:fs.readFileSync(p+'current-schema.sql','utf8'),journal:j,migrations:j.entries.map(e=>fs.readFileSync(p+'drizzle/'+e.tag+'.sql','utf8'))}));`], { encoding: "utf8", maxBuffer: 10_000_000, timeout: 120_000 }));
  }
  if (!bundle) throw new Error("Missing released schema");
  return bundle;
}
const values = [undefined, null, true, false, 0, 1, "true", "false", {}, []];
export const fixtures: { id: string; metadata: string | null }[] = [{ id: "org_null", metadata: null }];
for (const wrapped of [false, true]) {
  for (const [i, value] of values.entries()) {
    const doc = { capabilities: Object.fromEntries(keys.map((key) => [key, value])) };
    fixtures.push({ id: `org_caps_${wrapped}_${i}`, metadata: JSON.stringify(wrapped ? JSON.stringify(doc) : doc) });
  }
  for (const [i, a] of values.entries()) for (const [j, b] of values.entries()) {
    for (const override of [undefined, true, false]) {
      const doc = { connectEnabled: a, mcpConnectionsEnabled: b, capabilities: { mcpConnections: override } };
      fixtures.push({ id: `org_alias_${wrapped}_${i}_${j}_${override}`, metadata: JSON.stringify(wrapped ? JSON.stringify(doc) : doc) });
    }
  }
}
for (const [i, doc] of ["not JSON", "true", "null", "[]", 1, [], {}, { capabilities: null }].entries()) fixtures.push({ id: `org_extra_${i}`, metadata: JSON.stringify(doc) });

function executor(connection: Connection) {
  return { async query(sql: string, args: unknown[] = []) {
    const [result] = await connection.query<RowDataPacket[]>(sql, args);
    return Array.isArray(result) ? result : [];
  } };
}
export function connectDatabase(engine: string) {
  if (engine !== "mysql" && engine !== "maria") throw new Error("Unknown lab engine");
  return mysql.createConnection({ host: "127.0.0.1", port: engine === "mysql" ? 23316 : 23317, user: "root", dateStrings: true });
}
export async function rows(connection: Connection, sql: string) { return (await connection.query<RowDataPacket[]>(sql))[0]; }
export function featureRows(connection: Connection) { return rows(connection, "SELECT * FROM organization_feature ORDER BY organization_id, feature_key"); }
export function columnRows(connection: Connection) {
  return rows(connection, "SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('feature_rollout','organization_feature') ORDER BY TABLE_NAME,ORDINAL_POSITION");
}
export function recordedPrefix(connection: Connection) { return upgradeHistoryPrefix(executor(connection), plan); }
export async function validatedPrefix(connection: Connection) {
  return historyPrefix(loadMigrationPlan(folder), await rows(connection, "SELECT hash,created_at FROM __drizzle_migrations ORDER BY id"));
}
export function prefixWithHash(hash: string) {
  const canonical = loadMigrationPlan(folder);
  const receipts = canonical.slice(0, 129).map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }));
  receipts[128].hash = hash;
  return historyPrefix(canonical, receipts);
}
export async function seed(connection: Connection, name: string) {
  if (!/^exp_mariadb_0129_[a-z_]+$/.test(name)) throw new Error("Refusing a non-lab schema name");
  await connection.query(`CREATE DATABASE \`${name}\``);
  await connection.changeUser({ database: name });
  await connection.query("SET time_zone='+00:00', timestamp=1791993600");
  const released = baseline();
  if (released.journal.entries.at(-1)?.idx !== 121) throw new Error("Expected the published 0.18.56 baseline through 0121");
  for (const sql of released.schema.split(/;\s*(?:\r?\n|$)/).filter((sql) => sql.trim())) await connection.query(sql);
  await connection.query("CREATE TABLE __drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)");
  for (const [index, entry] of released.journal.entries.entries()) await connection.query("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?,?)", [digest(released.migrations[index]), entry.when]);
  for (const fixture of fixtures) await connection.query("INSERT INTO organization(id,name,slug,metadata) VALUES (?,?,?,?)", [fixture.id, fixture.id, fixture.id, fixture.metadata]);
  const temporary = mkdtempSync(path.join(tmpdir(), "exp-mariadb-0129-predecessors-"));
  try {
    mkdirSync(path.join(temporary, "meta"));
    const entries = plan.journal.entries.slice(0, 128);
    writeFileSync(path.join(temporary, "meta/_journal.json"), JSON.stringify({ ...plan.journal, entries }));
    for (const entry of entries) {
      const source = entry.idx <= released.journal.entries.length ? released.migrations[entry.idx - 1]
        : execFileSync("git", ["-C", root, "show", `v0.18.57:ee/packages/den-db/drizzle/${entry.tag}.sql`], { encoding: "utf8", timeout: 30_000 });
      writeFileSync(path.join(temporary, `${entry.tag}.sql`), source);
    }
    await migrateWith0097Compatibility(executor(connection), temporary, (migrationsFolder) => migrate(drizzle(connection), { migrationsFolder }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  if (await recordedPrefix(connection) !== 128) throw new Error("Original predecessors did not reach receipt 0128");
}
export async function apply(connection: Connection, sql: string) {
  for (const statement of sql.split("--> statement-breakpoint")) await connection.query(statement);
}
export async function runUpgrade(connection: Connection) {
  const queries: string[] = [];
  const db = drizzle(connection, { logger: { logQuery(query) { queries.push(query); } } });
  await migrateWith0097Compatibility(executor(connection), folder, (migrationsFolder) => migrate(db, { migrationsFolder }));
  return queries;
}
export function recordResult(engine: string, scenario: string, result: object) {
  const destination = process.env.OPENWORK_MIGRATION_EVIDENCE_DIR;
  console.log(JSON.stringify({ engine, scenario, evidenceWritten: Boolean(destination) }));
  if (destination) writeFileSync(path.join(destination, `${engine}-${scenario}.json`), JSON.stringify(result, null, 2));
}
