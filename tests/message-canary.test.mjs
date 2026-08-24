import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMessageCanarySnapshot,
  compareMessageCanarySnapshots,
  evaluateMessageCanaryHealth,
  getMessageCanaryConfig,
  getMessageGuildRoutingMode,
  parseMessageCanaryGuildIds,
  probeMessageOutboxWritable,
} from "../lib/message-canary.mjs";
import { checkMessageReplicaSchema } from "../lib/message-canary-postgres.mjs";
import {
  createMessageDomainRouter,
  UnsafeMessageRoutingChangeError,
} from "../lib/message-local-first.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";

const guildA = "1216303889599565875";
const guildB = "1507737783404462130";

function message(id, guildId) {
  return {
    id,
    content: `message-${id}`,
    createdTimestamp: 1_700_000_000_000,
    createdAt: new Date(1_700_000_000_000),
    guild: { id: guildId, memberCount: 10 },
    channel: { id: "1507737783404462131", name: "general" },
    author: { id: "1489038702377435149", username: "tester", bot: false },
    member: { displayName: "Tester", roles: { cache: new Map() } },
  };
}

function routerHarness(t, canaryGuilds = guildA) {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-message-canary-"));
  const databasePath = join(directory, "data", "canary.sqlite");
  const env = {
    LOCAL_STORAGE_ENABLED: "true",
    LOCAL_STORAGE_WRITE_ENABLED: "true",
    LOCAL_STORAGE_PATH: databasePath,
    LOCAL_MESSAGE_STORAGE_ENABLED: "true",
    LOCAL_MESSAGE_CANARY_GUILDS: canaryGuilds,
  };
  const calls = { create: [], update: [], remove: [], active: [] };
  const legacy = {
    async create(input) { calls.create.push(input.guild.id); },
    async update(input) { calls.update.push(input.guild.id); },
    async remove(input) { calls.remove.push(input.guild.id); return null; },
    async recordActiveMember(input) { calls.active.push(input.guildId); },
  };
  const storage = createLocalStorage({ databasePath });
  const router = createMessageDomainRouter({ env, storage, legacy });
  t.after(() => {
    try { router.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, env, storage, router, legacy, calls };
}

function healthyFixture() {
  return {
    localStorage: {
      accessible: true,
      writeEnabled: true,
      integrity: { ok: true },
      journalMode: "wal",
      outboxWritable: true,
      walBytes: 0,
      diskFreeBytes: 10_000_000_000,
    },
    syncWorker: { ready: true, status: "RUNNING", syncLagMs: 0 },
    circuit: { state: "CLOSED", openedAt: null },
    queue: { pendingCount: 0, deadLetterCount: 0, oldestPendingAgeMs: null },
    metrics: {
      messageLocalWriteFailures: 0,
      messageSyncFailureTotal: 0,
    },
    replicaSchema: { ready: true },
    comparison: { matched: true },
  };
}

test("Canary Guild parser deduplicates and sorts valid Discord IDs", () => {
  assert.deepEqual(parseMessageCanaryGuildIds(`${guildB}, ${guildA},${guildB}`), [guildA, guildB]);
});

test("Phase 3A object names do not collide with 46 schema tables or active migrations", () => {
  const schema = readFileSync(new URL("../lib/db/schema.ts", import.meta.url), "utf8");
  assert.equal((schema.match(/pgTable\(/g) ?? []).length, 46);
  for (const name of [
    "message_event_replica",
    "message_tombstone",
    "message_daily_stat_baseline",
  ]) {
    assert.doesNotMatch(schema, new RegExp(`pgTable\\(["']${name}["']`));
  }
  const migrationDirectory = new URL("../scripts/migrations/", import.meta.url);
  const activeMigrationSql = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(new URL(name, migrationDirectory), "utf8"))
    .join("\n");
  for (const name of [
    "message_event_replica_message_order_idx",
    "message_event_replica_aggregate_order_idx",
    "message_event_replica_occurred_idx",
    "message_tombstone_deleted_at_idx",
    "discord_message_source_event_unique_idx",
    "recent_activity_source_event_unique_idx",
  ]) {
    assert.doesNotMatch(activeMigrationSql, new RegExp(`\\b${name}\\b`));
  }
});

test("forward Migration has no HIGH RISK data rewrite and concurrent indexes stay outside transactions", () => {
  const core = readFileSync(
    new URL("../docs/sql/phase3a-message-replica-proposal.sql", import.meta.url),
    "utf8",
  );
  const indexes = readFileSync(
    new URL("../docs/sql/phase3a-message-replica-concurrent-indexes.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(core, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(core, /ALTER\s+COLUMN[\s\S]*\bTYPE\b/i);
  assert.doesNotMatch(core, /^\s*UPDATE\s+/im);
  assert.doesNotMatch(indexes, /\bBEGIN\b|\bCOMMIT\b/i);
  assert.equal((indexes.match(/CREATE UNIQUE INDEX CONCURRENTLY/gi) ?? []).length, 2);
  assert.match(core, /SQLSTATE|ERRCODE = '55000'/);
});

test("empty Canary list is valid but selects no Guild", () => {
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_STORAGE_ENABLED: "true" });
  assert.deepEqual(config.guildIds, []);
  assert.equal(getMessageGuildRoutingMode(config, guildA), "LEGACY");
});

test("invalid Canary Guild ID is rejected", () => {
  assert.throws(
    () => parseMessageCanaryGuildIds("not-a-discord-id"),
    /Invalid Discord Guild ID/,
  );
});

test("Global OFF routes every Guild to Legacy even if the list is populated", () => {
  const config = getMessageCanaryConfig({
    LOCAL_MESSAGE_STORAGE_ENABLED: "false",
    LOCAL_MESSAGE_CANARY_GUILDS: guildA,
  });
  assert.equal(getMessageGuildRoutingMode(config, guildA), "LEGACY");
});

test("Canary Guild uses Local-First while non-Canary Guild uses only Legacy", async (t) => {
  const h = routerHarness(t);
  await h.router.create(message("local", guildA));
  await h.router.create(message("legacy", guildB));
  assert.notEqual(h.storage.messageDomain.getCurrent(guildA, "local"), null);
  assert.equal(h.storage.messageDomain.getCurrent(guildB, "legacy"), null);
  assert.deepEqual(h.calls.create, [guildB]);
  assert.equal(h.router.getRoutingMode(guildA), "LOCAL_FIRST");
  assert.equal(h.router.getRoutingMode(guildB), "LEGACY");
});

test("Canary routing performs no Local plus Legacy shadow write", async (t) => {
  const h = routerHarness(t);
  await h.router.create(message("exclusive", guildA));
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.storage.outbox.getMessagePendingCount({ guildId: guildA }), 1);
});

test("routing interpretation remains identical after restart", async (t) => {
  const h = routerHarness(t);
  await h.router.create(message("restart", guildA));
  h.router.close();
  const reopenedStorage = createLocalStorage({ databasePath: h.databasePath });
  const reopened = createMessageDomainRouter({
    env: h.env,
    storage: reopenedStorage,
    legacy: h.legacy,
  });
  assert.equal(reopened.getRoutingMode(guildA), "LOCAL_FIRST");
  assert.equal(reopened.getRoutingMode(guildB), "LEGACY");
  reopened.close();
});

test("removing a Canary Guild with pending events blocks Legacy rollback", async (t) => {
  const h = routerHarness(t);
  await h.router.create(message("pending", guildA));
  h.router.close();
  const storage = createLocalStorage({ databasePath: h.databasePath });
  assert.throws(
    () => createMessageDomainRouter({
      env: { ...h.env, LOCAL_MESSAGE_CANARY_GUILDS: guildB },
      storage,
      legacy: h.legacy,
      logger: { error() {}, warn() {} },
    }),
    (error) => error instanceof UnsafeMessageRoutingChangeError,
  );
  storage.close();
});

test("routing state and Canary baseline are persisted without Message content", (t) => {
  const h = routerHarness(t);
  const routing = h.storage.syncMetadata.get("message_domain_routing");
  const baseline = h.storage.syncMetadata.get("message_canary_baseline");
  assert.equal(routing.state, "canary");
  assert.deepEqual(routing.metadata.canaryGuildIds, [guildA]);
  assert.equal(baseline.state, "active");
  assert.doesNotMatch(JSON.stringify({ routing, baseline }), /message-local-content/);
});

test("Outbox probe rolls back and Guild queue metrics stay isolated", (t) => {
  const h = routerHarness(t);
  assert.equal(probeMessageOutboxWritable(h.storage), true);
  assert.equal(h.storage.outbox.getMessagePendingCount(), 0);
  h.storage.outbox.enqueue({
    eventId: "canary-a",
    domain: "bot_event",
    eventType: "message_create",
    aggregateId: `message:${guildA}:1`,
    payload: { guildId: guildA, occurredAt: 1_700_000_000_000 },
    createdAt: 1_700_000_000_000,
  });
  h.storage.outbox.enqueue({
    eventId: "canary-b",
    domain: "bot_event",
    eventType: "message_create",
    aggregateId: `message:${guildB}:1`,
    payload: { guildId: guildB, occurredAt: 1_700_000_000_000 },
    createdAt: 1_700_000_000_000,
  });
  assert.equal(h.storage.outbox.getMessagePendingCount({ guildId: guildA }), 1);
  assert.equal(h.storage.outbox.getMessagePendingCount({ guildId: guildB }), 1);
});

test("Preflight health is HEALTHY when every readiness check passes", () => {
  const config = getMessageCanaryConfig({
    LOCAL_MESSAGE_STORAGE_ENABLED: "true",
    LOCAL_MESSAGE_CANARY_GUILDS: guildA,
  });
  assert.deepEqual(evaluateMessageCanaryHealth(healthyFixture(), config), {
    status: "HEALTHY",
    warnings: [],
    abort: [],
  });
});

test("Preflight fails for Integrity error", () => {
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_CANARY_GUILDS: guildA });
  const snapshot = healthyFixture();
  snapshot.localStorage.integrity.ok = false;
  assert.ok(evaluateMessageCanaryHealth(snapshot, config).abort.includes("sqlite_integrity_failed"));
});

test("Preflight fails when Sync Worker is unavailable", () => {
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_CANARY_GUILDS: guildA });
  const snapshot = healthyFixture();
  snapshot.syncWorker.ready = false;
  assert.ok(evaluateMessageCanaryHealth(snapshot, config).abort.includes("sync_worker_unavailable"));
});

test("Disk Critical is an ABORT condition", () => {
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_CANARY_GUILDS: guildA });
  const snapshot = healthyFixture();
  snapshot.localStorage.diskFreeBytes = 1;
  assert.ok(evaluateMessageCanaryHealth(snapshot, config).abort.includes("disk_free_abort"));
});

test("long Circuit OPEN is an ABORT condition", () => {
  const now = 1_800_000_000_000;
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_CANARY_GUILDS: guildA });
  const snapshot = healthyFixture();
  snapshot.circuit = { state: "OPEN", openedAt: now - 301_000 };
  assert.ok(
    evaluateMessageCanaryHealth(snapshot, config, { now: () => now }).abort.includes(
      "circuit_open_too_long",
    ),
  );
});

test("Pending threshold changes Canary health to ABORT", () => {
  const config = getMessageCanaryConfig({
    LOCAL_MESSAGE_CANARY_GUILDS: guildA,
    MESSAGE_CANARY_PENDING_WARN: "2",
    MESSAGE_CANARY_PENDING_ABORT: "3",
  });
  const snapshot = healthyFixture();
  snapshot.queue.pendingCount = 3;
  assert.ok(evaluateMessageCanaryHealth(snapshot, config).abort.includes("pending_count_abort"));
});

test("new local write failure and Dead Letter trigger ABORT against baseline", () => {
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_CANARY_GUILDS: guildA });
  const snapshot = healthyFixture();
  snapshot.metrics.messageLocalWriteFailures = 2;
  snapshot.queue.deadLetterCount = 1;
  const result = evaluateMessageCanaryHealth(snapshot, config, {
    baseline: { messageLocalWriteFailures: 1, deadLetterCount: 0 },
  });
  assert.ok(result.abort.includes("local_write_failure"));
  assert.ok(result.abort.includes("dead_letter_detected"));
});

test("Comparison reports equality without exposing Message content", () => {
  const local = {
    eventCount: 10,
    currentMessageCount: 7,
    deletedCount: 3,
    recentActivityCount: 5,
    activeMemberCount: 4,
    latestCreateAt: 123,
  };
  const replica = {
    replicaEventCount: 10,
    materializedMessageCount: 7,
    tombstoneCount: 3,
    recentActivityCount: 5,
    expectedActiveMemberCount: 4,
    latestCreateAt: 123,
    dailyStatsMismatchCount: 0,
    activeMemberMissingCount: 0,
  };
  assert.deepEqual(compareMessageCanarySnapshots(local, replica), {
    matched: true,
    differences: [],
  });
});

test("Comparison differences force Canary ABORT", () => {
  const comparison = compareMessageCanarySnapshots(
    { eventCount: 1 },
    { replicaEventCount: 2, dailyStatsMismatchCount: 1 },
  );
  assert.equal(comparison.matched, false);
  const config = getMessageCanaryConfig({ LOCAL_MESSAGE_CANARY_GUILDS: guildA });
  const snapshot = { ...healthyFixture(), comparison };
  assert.ok(evaluateMessageCanaryHealth(snapshot, config).abort.includes("comparison_mismatch"));
});

test("Replica schema preflight requires every table, function, column, and valid index", async () => {
  const ready = await checkMessageReplicaSchema(async () => ({
    rows: [{
      eventTable: true,
      tombstoneTable: true,
      baselineTable: true,
      syncFunction: true,
      indexesValid: true,
      messageSourceColumn: true,
      activitySourceColumn: true,
    }],
  }));
  assert.equal(ready.ready, true);
  const failed = await checkMessageReplicaSchema(async () => ({
    rows: [{ ...ready.checks, indexesValid: false }],
  }));
  assert.equal(failed.ready, false);
});

test("Canary snapshot exposes lag and sizes without Message body", (t) => {
  const h = routerHarness(t);
  const config = getMessageCanaryConfig(h.env);
  const snapshot = buildMessageCanarySnapshot({
    config,
    storage: h.storage,
    workerSnapshot: {
      workerStatus: "RUNNING",
      circuit: { state: "CLOSED", openCount: 0 },
      replicaBatchQueryCount: 4,
    },
    replicaSchema: { ready: true },
  });
  assert.equal(snapshot.metrics.replicaBatchQueryCount, 4);
  assert.ok("walBytes" in snapshot.localStorage);
  assert.ok("lastSyncedMessageAt" in snapshot.queue);
  assert.doesNotMatch(JSON.stringify(snapshot), /message body/i);
});

test("Reaction, Voice, Member, Security, Moderation, Translation, and History remain outside Canary routing", () => {
  const bot = readFileSync(new URL("../discord-bot.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bot, /messageRouter\.(?:reaction|voice|member|security|moderation|translation|history)/);
  assert.match(bot, /client\.on\("messageReactionAdd"/);
  assert.match(bot, /client\.on\("voiceStateUpdate"/);
  assert.match(bot, /"guildMemberAdd"/);
});

test("Canary CLIs use a dedicated read-only URL and never fall back to DATABASE_URL", () => {
  const source = readFileSync(
    new URL("../scripts/message-canary-cli-utils.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /MESSAGE_CANARY_READONLY_DATABASE_URL/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.doesNotMatch(source, /env\.DATABASE_URL/);
});
