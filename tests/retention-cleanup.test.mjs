import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../scripts/cleanup-retention.mjs", import.meta.url), "utf8");

test("retention cleanup is dry-run unless execute is explicit", () => {
  assert.match(source, /process\.argv\.includes\("--execute"\)/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /mode: execute \? "execute" : "dry-run"/);
});

test("retention cleanup uses bounded batches and an advisory lock", () => {
  assert.match(source, /parsedBatchSize > 1000/);
  assert.match(source, /LIMIT \$2/);
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /statement_timeout = '30s'/);
});

test("retention cleanup protects active runtime and unfinished sessions", () => {
  assert.match(source, /ownerInstanceId/);
  assert.match(source, /leaseExpiresAt.*> now\(\)/s);
  assert.match(source, /stoppedAt.*IS NOT NULL/);
  assert.match(source, /endedAt.*IS NOT NULL/);
  assert.match(source, /status.*<> 'pending'/);
});

test("retention cleanup contains no broad destructive statements", () => {
  assert.doesNotMatch(source, /\b(?:DROP|TRUNCATE)\b/i);
  assert.match(source, /WITH candidate AS/);
  assert.match(source, /DELETE FROM \$\{table\} target USING candidate/);
  assert.match(source, /Required index is missing/);
});
