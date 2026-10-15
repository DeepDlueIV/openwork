import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";
import {
  apply, baseline, baselineImage, columnRows, connectDatabase, digest, featureRows,
  fixtures, millis, newSql, oldHash, originalSql, plan, prefixWithHash,
  recordedPrefix, recordResult, runUpgrade, seed, validatedPrefix, rows,
} from "../worlds/organization-features-migration.ts";

// Explicit opt-in: one-time unsupported-engine smoke, not a MariaDB CI gate.
// Start disposable loopback MySQL 8 / MariaDB 11.4 on ports 23316 / 23317,
// pull the pinned 0.18.56 Den image, and fetch tag v0.18.57 before opting in.
let mysqlExpectedRows: Awaited<ReturnType<typeof featureRows>> | undefined;
for (const engine of ["mysql", "maria"]) {
  test(`${engine}: released pre-0129 database preserves rows and types with portable backfill`, { timeout: 600_000 }, async ({ evidence }) => {
    needs({ env: ["OPENWORK_MIGRATION_LAB"] });
    const oldSql = originalSql();
    const connection = await connectDatabase(engine);
    const databases: string[] = [];
    try {
      const version = await rows(connection, "SELECT VERSION() AS version, @@sql_mode AS mode");
      const oldName = `exp_mariadb_0129_${engine}_old`;
      databases.push(oldName);
      await seed(connection, oldName);
      const originalMetadata = await rows(connection, "SELECT id,metadata FROM organization ORDER BY id");
      if (engine === "mysql") await apply(connection, oldSql);
      else {
        await expect(apply(connection, oldSql)).rejects.toMatchObject({ code: "ER_PARSE_ERROR", errno: 1064 });
        await expect(connection.query(oldSql.split("--> statement-breakpoint")[3])).rejects.toMatchObject({ code: "ER_PARSE_ERROR", errno: 1064 });
        expect(await rows(connection, "SHOW TABLES LIKE '%feature%'")).toHaveLength(2);
        expect(await recordedPrefix(connection)).toBe(128);
        await expect(apply(connection, oldSql)).rejects.toThrow(/already exists/);
        await runUpgrade(connection);
      }
      const expectedRows = await featureRows(connection);
      const expectedColumns = await columnRows(connection);
      const expectedDdl = [(await connection.query("SHOW CREATE TABLE organization_feature"))[0], (await connection.query("SHOW CREATE TABLE feature_rollout"))[0]];
      if (engine === "mysql") mysqlExpectedRows = expectedRows;
      else expect(expectedRows).toEqual(mysqlExpectedRows);
      const newName = `exp_mariadb_0129_${engine}_new`;
      databases.push(newName);
      await seed(connection, newName);
      await apply(connection, newSql);
      expect(await featureRows(connection)).toEqual(expectedRows);
      expect(await columnRows(connection)).toEqual(expectedColumns);
      expect(await rows(connection, "SELECT id,metadata FROM organization ORDER BY id")).toEqual(originalMetadata);
      expect(expectedRows).toHaveLength(508);
      expect(await rows(connection, "SELECT * FROM feature_rollout")).toEqual([]);
      const ddl = [(await connection.query("SHOW CREATE TABLE organization_feature"))[0], (await connection.query("SHOW CREATE TABLE feature_rollout"))[0]];
      expect(ddl).toEqual(expectedDdl);
      recordResult(engine, "equivalence", { version, fixtures: fixtures.length, rowCount: expectedRows.length, rowsSha256: digest(JSON.stringify(expectedRows)), rows: expectedRows, columns: expectedColumns, ddl, oldHash, newHash: digest(newSql), baselineImage, baselineLastMigration: baseline().journal.entries.at(-1) });
      evidence.recordAssertionEvidence("Portable backfill preserves rows, column types, DDL and source metadata", `${engine}: ${expectedRows.length} rows from ${fixtures.length} metadata fixtures; strings/numbers do not become boolean overrides`, true);
    } finally {
      for (const name of databases) await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await connection.end();
    }
  });

  for (const state of ["failed", "fixed-ledger", "fixed-no-ledger"]) {
    test(`${engine}: ${state} recovers without replacing existing overrides`, { timeout: 600_000 }, async ({ evidence }) => {
      needs({ env: ["OPENWORK_MIGRATION_LAB"] });
      const oldSql = originalSql();
      const connection = await connectDatabase(engine);
      const name = `exp_mariadb_0129_${engine}_${state.replaceAll("-", "_")}`;
      try {
        await seed(connection, name);
        for (const statement of oldSql.split("--> statement-breakpoint").slice(0, 2)) await connection.query(statement);
        if (state !== "failed") {
          await apply(connection, engine === "mysql" && state === "fixed-ledger" ? oldSql.split("--> statement-breakpoint").slice(2).join("--> statement-breakpoint") : newSql);
          await connection.query("UPDATE organization_feature SET enabled=0,source='operator',set_by_user_id='usr_operator' WHERE organization_id='org_caps_false_2'");
          await connection.query("INSERT INTO feature_rollout(feature_key,enabled,killed,updated_by_user_id) VALUES ('mcpConnections',0,1,'usr_operator')");
          if (state === "fixed-ledger") await connection.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)", [oldHash, millis]);
          else await connection.query("DELETE FROM organization_feature WHERE organization_id='org_caps_false_3'");
        }
        const metadata = await rows(connection, "SELECT id,metadata FROM organization ORDER BY id");
        const existing = state !== "failed" ? await rows(connection, "SELECT * FROM organization_feature WHERE organization_id='org_caps_false_2' ORDER BY feature_key") : [];
        const rollout = await rows(connection, "SELECT * FROM feature_rollout");
        const queries = await runUpgrade(connection);
        expect(await recordedPrefix(connection)).toBe(plan.migrations.length);
        expect(await validatedPrefix(connection)).toBe(plan.migrations.length);
        expect(await rows(connection, "SELECT id,metadata FROM organization ORDER BY id")).toEqual(metadata);
        expect(await rows(connection, "SELECT * FROM feature_rollout")).toEqual(rollout);
        if (state !== "failed") expect(await rows(connection, "SELECT * FROM organization_feature WHERE organization_id='org_caps_false_2' ORDER BY feature_key")).toEqual(existing);
        expect(await rows(connection, "SELECT * FROM organization_feature WHERE organization_id='org_caps_false_3'")).toHaveLength(9);
        const receipt = await rows(connection, `SELECT hash FROM __drizzle_migrations WHERE created_at=${millis}`);
        expect(receipt).toHaveLength(1);
        expect(receipt[0].hash).toBe(state === "fixed-ledger" ? oldHash : plan.migrations[128].hash);
        const backfilled = queries.some((query) => query.includes("INSERT IGNORE INTO `organization_feature`"));
        expect(backfilled).toBe(state !== "fixed-ledger");
        expect(await runUpgrade(connection)).toEqual([]);
        recordResult(engine, state, { prefix: plan.migrations.length, receipt, backfilled, rerunQueries: 0, rows: (await featureRows(connection)).length, preservedExisting: existing.length, rollout, laterMigrations: plan.journal.entries.slice(129).map((entry) => entry.tag) });
        evidence.recordAssertionEvidence("Upgrade records one receipt, preserves operator overrides, and does no migration on retry", `${engine}/${state}: prefix ${plan.migrations.length}, backfill ${backfilled}; existing overrides and kill switch unchanged`, true);
      } finally {
        await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await connection.end();
      }
    });
  }
}

test("the known release hash is accepted but an unknown hand-edited hash is rejected", async ({ evidence }) => {
  expect(plan.migrations[128].hash).not.toBe(oldHash);
  expect(() => prefixWithHash("unknown-hand-edited-hash")).toThrow(/receipt 129/);
  expect(prefixWithHash(oldHash)).toBe(129);
  evidence.recordAssertionEvidence("Only the known historical hash is accepted", "Original 0129 receipt accepted; unknown hand-edited receipt rejected at 129", true);
});
