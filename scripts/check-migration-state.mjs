import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set for migration state inspection.");
const reportOnly = process.argv.includes("--report-only");
const manifest = JSON.parse(await readFile(new URL("./migrations/manifest.json", import.meta.url), "utf8"));
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const output = [];
let drift = false;
try {
  await client.query("BEGIN READ ONLY");
  const journalExists = await client.query(`SELECT to_regclass('public.schema_migration') IS NOT NULL AS "exists"`);
  const journalRows = journalExists.rows[0]?.exists
    ? await client.query(`SELECT "id", "checksum", "appliedAt" FROM "schema_migration"`)
    : { rows: [] };
  const journal = new Map(journalRows.rows.map((row) => [row.id, row]));
  for (const migration of manifest.migrations) {
    const checks = [];
    for (const check of migration.checks) {
      let exists = false;
      if (check.kind === "table") {
        const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, [`public.${check.name}`]);
        exists = result.rows[0]?.exists === true;
      } else if (check.kind === "index") {
        const result = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1) AS "exists"`, [check.name]);
        exists = result.rows[0]?.exists === true;
      } else if (check.kind === "column") {
        const result = await client.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS "exists"`, [check.table, check.name]);
        exists = result.rows[0]?.exists === true;
      }
      checks.push({ kind: check.kind, name: check.name, exists });
    }
    const structurallyPresent = checks.every((check) => check.exists);
    const applied = journal.get(migration.id);
    const state = !structurallyPresent
      ? "pending"
      : !applied
        ? "present_untracked"
        : applied.checksum === migration.checksum
          ? "applied"
          : "checksum_mismatch";
    if (state !== "applied") drift = true;
    output.push({ id: migration.id, risk: migration.risk, state, checks });
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}

console.log(JSON.stringify({ status: drift ? "drift" : "ok", migrations: output }, null, 2));
if (drift && !reportOnly) process.exitCode = 1;
