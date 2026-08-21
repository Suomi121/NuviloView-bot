import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const migrationDirectory = new URL("./migrations/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", migrationDirectory), "utf8"));
const errors = [];
const seenIds = new Set();
const seenFiles = new Set();
const allowedRisks = new Set(["low", "medium", "high"]);
const dangerousUpSql = /\b(?:TRUNCATE|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT))\b/i;

for (const migration of manifest.migrations ?? []) {
  if (!/^\d{8}-[a-z0-9-]+$/.test(migration.id ?? "")) errors.push(`Invalid migration id: ${migration.id ?? "missing"}`);
  if (seenIds.has(migration.id)) errors.push(`Duplicate migration id: ${migration.id}`);
  if (seenFiles.has(migration.file)) errors.push(`Duplicate migration file: ${migration.file}`);
  seenIds.add(migration.id);
  seenFiles.add(migration.file);
  if (migration.file !== `${migration.id}.sql`) errors.push(`${migration.id}: file name must match id`);
  if (!allowedRisks.has(migration.risk)) errors.push(`${migration.id}: invalid risk`);
  if (!Array.isArray(migration.checks) || migration.checks.length === 0) errors.push(`${migration.id}: at least one structural check is required`);
  if (migration.risk === "high" && migration.manualApprovalRequired !== true) errors.push(`${migration.id}: high-risk migrations require manual approval`);

  let sql = "";
  try {
    sql = await readFile(new URL(migration.file, migrationDirectory), "utf8");
  } catch {
    errors.push(`${migration.id}: migration file is missing`);
    continue;
  }
  const checksum = createHash("sha256").update(sql).digest("hex");
  if (checksum !== migration.checksum) errors.push(`${migration.id}: checksum mismatch`);
  if (dangerousUpSql.test(sql) && migration.manualApprovalRequired !== true) {
    errors.push(`${migration.id}: destructive SQL requires manualApprovalRequired=true`);
  }
  if (migration.downFile) {
    try {
      await readFile(new URL(migration.downFile, migrationDirectory), "utf8");
    } catch {
      errors.push(`${migration.id}: declared down migration is missing`);
    }
  }
  if (migration.reversible === true && !migration.downFile) errors.push(`${migration.id}: reversible migration must declare downFile`);
}

const files = (await readdir(migrationDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && !entry.name.endsWith(".down.sql"))
  .map((entry) => entry.name)
  .sort();
for (const file of files) if (!seenFiles.has(file)) errors.push(`Untracked migration file: ${file}`);
for (const file of seenFiles) if (!files.includes(file)) errors.push(`Manifest points to missing migration: ${file}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`Migration validation failed: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Migration validation passed: ${files.length} ordered migrations, checksums verified.`);
}
