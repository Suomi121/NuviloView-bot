import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bot = await readFile(new URL("../discord-bot.mjs", import.meta.url), "utf8");
const migration = await readFile(new URL("../scripts/migrations/20260816-distributed-runtime.sql", import.meta.url), "utf8");
const windowsRunner = await readFile(new URL("../scripts/run-bot-forever.ps1", import.meta.url), "utf8");
const androidRunner = await readFile(new URL("../Android/run-bot-forever.sh", import.meta.url), "utf8");
const monitor = await readFile(new URL("../scripts/monitor-runtime.mjs", import.meta.url), "utf8");
const failoverRehearsal = await readFile(new URL("../scripts/test-runtime-failover.mjs", import.meta.url), "utf8");

test("Bot acquires and starts distributed coordination before Discord login", () => {
  const acquireAt = bot.indexOf("await runtimeCoordinator.acquire()")
  const heartbeatAt = bot.indexOf("await runtimeCoordinator.start()")
  const loginAt = bot.indexOf("await client.login(process.env.NUVILOVIEW_BOT_TOKEN)")
  assert.ok(acquireAt > 0 && heartbeatAt > acquireAt && loginAt > heartbeatAt)
  assert.match(bot, /releaseLease: false/)
  assert.match(bot, /RUNTIME_EXIT_CODES\.LEASE_LOST/)
});

test("migration is additive and keeps per-instance heartbeat history", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "service_lease"/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "service_heartbeat"/)
  assert.match(migration, /"instanceId" text PRIMARY KEY/)
  assert.match(migration, /"fencingToken" bigint/)
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM/)
});

test("Windows and Android runners treat lease contention as a bounded wait", () => {
  assert.match(windowsRunner, /leaseContentionExitCode = 20/)
  assert.match(windowsRunner, /leaseContentionDelaySeconds = 300/)
  assert.match(androidRunner, /LEASE_CONTENDED_EXIT_CODE=20/)
  assert.match(androidRunner, /LEASE_CONTENTION_DELAY_SECONDS=300/)
});

test("external monitor is independent from Discord Bot credentials", () => {
  assert.match(monitor, /service_lease/)
  assert.match(monitor, /service_heartbeat/)
  assert.match(monitor, /BEGIN READ ONLY/)
  assert.doesNotMatch(monitor, /NUVILOVIEW_BOT_TOKEN|client\.login|discord\.js/)
});

test("real-DB failover rehearsal is isolated from the production service key", () => {
  assert.match(failoverRehearsal, /--execute-test-service/);
  assert.match(failoverRehearsal, /nuviloview\.discord-bot\.failover-test\./);
  assert.match(failoverRehearsal, /stale_owner_renew_rejected/);
  assert.match(failoverRehearsal, /fencing_token_increments/);
  assert.doesNotMatch(failoverRehearsal, /serviceKey\s*=\s*["']nuviloview\.discord-bot\.production/);
});
