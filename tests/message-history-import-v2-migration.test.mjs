import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../scripts/migrations/20260821-message-history-import-v2.sql", import.meta.url), "utf8");

test("v2 migration is additive and leaves legacy provenance unknown", () => {
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.match(migration, /"source" text NOT NULL DEFAULT 'existing'/);
  assert.match(migration, /discord_message_guild_source_created_idx/);
});

test("v2 migration persists batch checkpoints and safe diagnostics", () => {
  for (const column of [
    "nextBeforeMessageId",
    "oldestMessageId",
    "fetchedCount",
    "insertedCount",
    "duplicateCount",
    "lastProgressAt",
    "lastWorkerHeartbeatAt",
    "safeErrorCode",
    "safeErrorSummary",
  ]) assert.match(migration, new RegExp(`"${column}"`));
});

test("active-job uniqueness includes paused, cancelling and stalled jobs", () => {
  const activeIndex = migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS "history_import_job_one_active_per_guild_v2_idx"[\s\S]*?;/)?.[0] ?? "";
  for (const status of ["queued", "preparing", "running", "pausing", "paused", "cancelling", "stalled"]) {
    assert.match(activeIndex, new RegExp(`'${status}'`));
  }
});

test("job and checkpoint metadata do not introduce message content or secrets", () => {
  const operationalTables = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS "history_import_channel_progress"'));
  assert.doesNotMatch(operationalTables, /"(?:content|token|databaseUrl|authorization)"/i);
});
