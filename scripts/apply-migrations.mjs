import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set before planning migrations.");

const execute = process.argv.includes("--execute");
function argumentSet(prefix) {
  return new Set(
    process.argv
      .filter((argument) => argument.startsWith(prefix))
      .flatMap((argument) => argument.slice(prefix.length).split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

const approved = argumentSet("--approve=");
const adopted = argumentSet("--adopt-present=");
const migrationDirectory = new URL("./migrations/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", migrationDirectory), "utf8"));
const migrations = [];
for (const item of manifest.migrations) {
  const sql = await readFile(new URL(item.file, migrationDirectory), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  if (checksum !== item.checksum) throw new Error(`Migration checksum mismatch: ${item.id}`);
  migrations.push({ ...item, sql });
}

async function checkExists(client, check) {
  if (check.kind === "table") {
    const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, [`public.${check.name}`]);
    return result.rows[0]?.exists === true;
  }
  if (check.kind === "index") {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1) AS "exists"`,
      [check.name],
    );
    return result.rows[0]?.exists === true;
  }
  if (check.kind === "column") {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      ) AS "exists"`,
      [check.table, check.name],
    );
    return result.rows[0]?.exists === true;
  }
  throw new Error(`Unsupported migration check kind: ${check.kind}`);
}

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let lockAcquired = false;
try {
  const journalExists = await client.query(`SELECT to_regclass('public.schema_migration') IS NOT NULL AS "exists"`);
  const appliedRows = journalExists.rows[0]?.exists
    ? await client.query(`SELECT "id", "checksum", "appliedAt" FROM "schema_migration" ORDER BY "id"`)
    : { rows: [] };
  const applied = new Map(appliedRows.rows.map((row) => [row.id, row]));
  const states = [];

  for (const migration of migrations) {
    const recorded = applied.get(migration.id);
    if (recorded && recorded.checksum !== migration.checksum) {
      throw new Error(`Applied migration checksum changed: ${migration.id}`);
    }
    const checkResults = [];
    for (const check of migration.checks) checkResults.push(await checkExists(client, check));
    const presentCount = checkResults.filter(Boolean).length;
    const state = recorded
      ? "applied"
      : presentCount === migration.checks.length
        ? "present_untracked"
        : presentCount === 0
          ? "pending"
          : "partial";
    states.push({ ...migration, state });
  }

  console.log(JSON.stringify({
    mode: execute ? "execute" : "plan",
    migrations: states.map((item) => ({
      id: item.id,
      state: item.state,
      risk: item.risk,
      manualApprovalRequired: item.manualApprovalRequired,
    })),
  }));

  if (execute) {
    const partial = states.filter((item) => item.state === "partial");
    if (partial.length > 0) {
      throw new Error(`Partially present migrations require manual remediation: ${partial.map((item) => item.id).join(", ")}`);
    }

    const missingAdoptions = states.filter((item) => item.state === "present_untracked" && !adopted.has(item.id));
    if (missingAdoptions.length > 0) {
      throw new Error(`Existing structures must be explicitly adopted before execution: ${missingAdoptions.map((item) => item.id).join(", ")}`);
    }

    const missingApprovals = states.filter(
      (item) => item.state === "pending" && item.manualApprovalRequired && !approved.has(item.id),
    );
    if (missingApprovals.length > 0) {
      throw new Error(`Manual approval required before any migration is applied: ${missingApprovals.map((item) => item.id).join(", ")}`);
    }

    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('nuviloview.schema-migration.v1')) AS "acquired"`);
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) throw new Error("Another migration runner currently holds the migration lock.");

    const journalMigration = states.find((item) => item.id === "20260821-migration-journal");
    if (!journalMigration) throw new Error("Migration journal definition is missing from the manifest.");
    if (journalMigration.state === "pending") {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '5min'`);
        await client.query(journalMigration.sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }

    const appliedBy = String(process.env.NUVILOVIEW_MIGRATION_ACTOR || "manual-operator").slice(0, 120);
    for (const migration of states) {
      if (migration.state === "applied") continue;
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '5min'`);
        if (migration.state === "pending" && migration.id !== journalMigration.id) {
          await client.query(migration.sql);
        }
        await client.query(
          `INSERT INTO "schema_migration" ("id", "checksum", "description", "risk", "appliedBy")
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ("id") DO NOTHING`,
          [migration.id, migration.checksum, migration.description, migration.risk, appliedBy],
        );
        await client.query("COMMIT");
        console.log(`${migration.state === "present_untracked" ? "Adopted" : "Applied"} migration: ${migration.id}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
  }
} finally {
  if (lockAcquired) {
    await client.query(`SELECT pg_advisory_unlock(hashtext('nuviloview.schema-migration.v1'))`).catch(() => {});
  }
  await client.end();
}
