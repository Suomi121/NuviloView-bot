import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(new URL("../scripts/apply-migrations.mjs", import.meta.url), "utf8");
const legacy = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../scripts/migrations/manifest.json", import.meta.url), "utf8"));

test("migration runner defaults to plan and uses a journal plus lock", () => {
  assert.match(runner, /process\.argv\.includes\("--execute"\)/);
  assert.match(runner, /schema_migration/);
  assert.match(runner, /pg_try_advisory_lock/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /ROLLBACK/);
  assert.match(runner, /--adopt-present=/);
  assert.match(runner, /Partially present migrations require manual remediation/);
  assert.match(runner, /Existing structures must be explicitly adopted/);
});

test("high-risk and retention migrations require explicit approval", () => {
  const security = manifest.migrations.find((migration) => migration.id === "20260821-security-v1");
  const retention = manifest.migrations.find((migration) => migration.id === "20260821-retention-indexes");
  assert.equal(security.manualApprovalRequired, true);
  assert.equal(retention.manualApprovalRequired, true);
});

test("legacy bootstrap cannot run without an explicit execute flag", () => {
  assert.match(legacy, /--execute-bootstrap/);
});

test("managed migrations contain no table-destructive DROP or TRUNCATE", async () => {
  for (const migration of manifest.migrations) {
    const sql = await readFile(new URL(`../scripts/migrations/${migration.file}`, import.meta.url), "utf8");
    assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|SCHEMA)|TRUNCATE)\b/i, migration.id);
  }
});
