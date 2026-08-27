import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStorage } from "../lib/storage/index.mjs";
import { createMessageDomainRouter } from "../lib/message-local-first.mjs";
import {
  analyticsCurrentProjectionKey,
  createAnalyticsCompactionService,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";
import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { MultiProviderSyncWorker } from "../lib/sync/multi-worker.mjs";
import { getProviderPolicyDefinitions } from "../lib/sync/providers/contract.mjs";

const guildId = "100000000000000001";
const channelId = "200000000000000001";
const userId = "300000000000000001";

const compactionEnv = Object.freeze({
  LOCAL_STORAGE_ENABLED: "true",
  LOCAL_STORAGE_WRITE_ENABLED: "true",
  LOCAL_MESSAGE_STORAGE_ENABLED: "true",
  LOCAL_MESSAGE_CANARY_GUILDS: guildId,
  ANALYTICS_COMPACTION_ENABLED: "true",
  ANALYTICS_COMPACTION_GUILD_IDS: guildId,
  ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "900",
  MULTI_DB_SYNC_ENABLED: "true",
  SYNC_WORKER_ENABLED: "true",
  SYNC_SUPABASE_ENABLED: "true",
  SUPABASE_DATABASE_URL: "postgresql://isolated.invalid/replica",
  SYNC_TURSO_ENABLED: "true",
  TURSO_DATABASE_URL: "libsql://isolated.invalid",
  TURSO_AUTH_TOKEN: "test-placeholder",
  SYNC_NEON_ENABLED: "false",
  SYNC_SNAPSHOT_ENABLED: "true",
  SYNC_PROVIDER_BATCH_MIN: "25",
  SYNC_PROVIDER_BATCH_MAX: "100",
  SYNC_CIRCUIT_FAILURE_THRESHOLD: "1",
  SYNC_CIRCUIT_OPEN_MS: "1000",
  SYNC_RETRY_BASE_MS: "100",
  SYNC_RETRY_MAX_MS: "1000",
  SYNC_RETRY_JITTER_RATIO: "0",
});

function event(index, occurredAt) {
  const messageId = String(400000000000000000n + BigInt(index));
  return {
    eventId: `message-create:${guildId}:${messageId}`,
    guildId,
    channelId,
    messageId,
    authorId: userId,
    eventType: "create",
    revision: `create:${occurredAt}:${messageId}`,
    sourceSequence: occurredAt,
    content: `local message ${index}`,
    occurredAt,
    actorName: "Local user",
    channelName: "general",
    payload: {
      guildId,
      channelId,
      messageId,
      authorId: userId,
      authorName: "Local user",
      content: `local message ${index}`,
      eventType: "create",
      occurredAt,
      source: "test",
    },
  };
}

function recordMessages(storage, count, { offset = 0, occurredAt }) {
  storage.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const value = event(offset + index, occurredAt + index);
      const result = storage.messageDomain.recordEvent(value);
      if (result.inserted) storage.analyticsProjections.markMessageEvent(result.event);
    }
  });
}

function fakeProvider(id, { failures = 0 } = {}) {
  const state = { failures, snapshots: new Map(), eventWrites: 0, snapshotWrites: 0 };
  return {
    id,
    required: true,
    state,
    isEnabled: () => true,
    async pushEvents(items) {
      state.eventWrites += items.length;
      return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
    },
    async pushSnapshots(items) {
      if (state.failures > 0) {
        state.failures -= 1;
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
        });
      }
      state.snapshotWrites += items.length;
      for (const item of items) {
        state.snapshots.set(`${item.snapshotType}:${item.aggregateId}`, item);
      }
      return {
        succeededSnapshotKeys: items.map(
          (item) => `${item.snapshotType}:${item.aggregateId}`,
        ),
        failed: [],
        queryCount: 1,
      };
    },
    async health() {
      return { status: "HEALTHY" };
    },
    async close() {},
  };
}

function registry(providers) {
  const items = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => [...items.values()],
    get: (id) => items.get(id) ?? null,
  };
}

test("Compaction defaults OFF and uses an explicit 15-minute Canary schedule", () => {
  const defaults = getAnalyticsCompactionConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.intervalSeconds, 900);
  assert.equal(defaults.isEnabledForGuild(guildId), false);
  const enabled = getAnalyticsCompactionConfig(compactionEnv);
  assert.equal(enabled.isEnabledForGuild(guildId), true);
  assert.equal(enabled.isEnabledForGuild("999999999999999999"), false);
  const storage = createLocalStorage({ databasePath: ":memory:" });
  assert.throws(
    () => createMessageDomainRouter({
      env: {
        ...compactionEnv,
        SYNC_WORKER_ENABLED: "false",
      },
      storage,
      legacy: {},
    }),
    (error) => error?.code === "ANALYTICS_COMPACTION_UNSAFE_CONFIGURATION",
  );
  storage.close();
});

test("200 raw messages stay local and become bounded deterministic projections", async () => {
  let at = Date.parse("2026-08-27T07:00:00.000Z");
  const now = () => at;
  const providerDefinitions = getProviderPolicyDefinitions(compactionEnv);
  const storage = createLocalStorage({
    databasePath: ":memory:",
    providerDefinitions,
    now,
  });
  const router = createMessageDomainRouter({
    env: compactionEnv,
    storage,
    now,
    legacy: {
      create: () => assert.fail("Legacy Message path must not run."),
      update: () => assert.fail("Legacy Message path must not run."),
      remove: () => assert.fail("Legacy Message path must not run."),
      recordActiveMember: () => assert.fail("Legacy Message path must not run."),
    },
  });
  for (let index = 0; index < 200; index += 1) {
    await router.create({
      id: String(400000000000000000n + BigInt(index)),
      content: `raw local ${index}`,
      createdTimestamp: at + index,
      guild: { id: guildId, memberCount: 76 },
      channel: { id: channelId, name: "general" },
      author: { id: userId, username: "Local user", bot: false },
      member: { displayName: "Local user", roles: { cache: new Map() } },
    });
  }

  assert.equal(storage.analyticsProjections.countRawMessages(guildId), 200);
  assert.deepEqual(storage.outbox.getStatusCounts(), {
    pending: 0,
    processing: 0,
    retry: 0,
    synced: 0,
    dead_letter: 0,
  });
  assert.equal(storage.providerDeliveries.getCloudCompletionSummary().total, 0);

  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(compactionEnv),
    now,
    logger: { info() {} },
  });
  const first = service.refreshDue({ at });
  assert.equal(first.changed, 4);
  const currentKey = analyticsCurrentProjectionKey(guildId);
  const current = storage.snapshots.get("analytics", currentKey);
  assert.equal(current.payload.messageCount, 200);
  assert.equal(current.payload.rawContentIncluded, false);
  assert.equal(JSON.stringify(current.payload).includes("raw local"), false);
  assert.equal(current.payload.nextUpdateAt - at, 900_000);

  const unchanged = service.refreshDue({ at: at + 1 });
  assert.equal(unchanged.built, 0);
  assert.equal(storage.snapshots.get("analytics", currentKey).snapshotVersion, 1);

  at += 900_001;
  await router.create({
    id: "400000000000000999",
    content: "one more local message",
    createdTimestamp: at,
    guild: { id: guildId, memberCount: 76 },
    channel: { id: channelId, name: "general" },
    author: { id: userId, username: "Local user", bot: false },
    member: { displayName: "Local user", roles: { cache: new Map() } },
  });
  const second = service.refreshDue({ at });
  assert.equal(second.changed, 4);
  const updated = storage.snapshots.get("analytics", currentKey);
  assert.equal(updated.payload.messageCount, 201);
  assert.equal(updated.snapshotVersion, 2);

  at += 900_001;
  storage.analyticsProjections.markDirty({
    projectionKind: "guild_current",
    guildId,
    sourceSequence: updated.payload.lastActivityAt,
    lastEventAt: updated.payload.lastActivityAt,
  }, { at });
  const deterministic = service.refreshDue({ at });
  assert.equal(deterministic.skipped, 1);
  assert.equal(storage.snapshots.get("analytics", currentKey).snapshotVersion, 2);

  const supabase = fakeProvider("supabase");
  const turso = fakeProvider("turso");
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(compactionEnv),
    now,
    random: () => 0.5,
    logger: { info() {}, error() {} },
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(supabase.state.eventWrites, 0);
  assert.equal(turso.state.eventWrites, 0);
  const supabaseCurrent = supabase.state.snapshots.get(`analytics:${currentKey}`);
  const tursoCurrent = turso.state.snapshots.get(`analytics:${currentKey}`);
  assert.equal(supabaseCurrent.payload.messageCount, 201);
  assert.equal(tursoCurrent.checksum, supabaseCurrent.checksum);
  const metrics = storage.analyticsProjections.getMetrics();
  assert.equal(metrics.rawEventsSeen, 201);
  assert.equal(metrics.providerWritesByProvider.supabase, 4);
  assert.equal(metrics.providerWritesByProvider.turso, 4);
  assert.equal(metrics.providerWriteReductionRatio > 0.96, true);
  storage.close();
});

test("dirty state survives restart and transient Cloud failure catches up without DLQ", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-compaction-"));
  const databasePath = join(directory, "local.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let at = Date.parse("2026-08-27T08:00:00.000Z");
  const now = () => at;
  const providerDefinitions = getProviderPolicyDefinitions(compactionEnv);
  let storage = createLocalStorage({ databasePath, providerDefinitions, now });
  recordMessages(storage, 10, { occurredAt: at });
  assert.equal(storage.analyticsProjections.listDue({ at }).length, 4);
  storage.close();
  assert.equal(existsSync(databasePath), true);

  storage = createLocalStorage({ databasePath, providerDefinitions, now });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(compactionEnv),
    now,
    logger: { info() {} },
  });
  assert.equal(service.refreshDue({ at }).changed, 4);
  assert.equal(
    storage.syncMetadata.get(`analytics_compaction_bootstrap_v2:${guildId}`).state,
    "complete",
  );
  storage.close();

  storage = createLocalStorage({ databasePath, providerDefinitions, now });
  const restartedService = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(compactionEnv),
    now,
    logger: { info() {} },
  });
  assert.deepEqual(restartedService.bootstrap(), {
    rawEvents: 0,
    marked: 0,
    skipped: true,
  });
  assert.equal(storage.analyticsProjections.listDue({ at }).length, 0);
  const supabase = fakeProvider("supabase");
  const turso = fakeProvider("turso", { failures: 1 });
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(compactionEnv),
    now,
    random: () => 0,
    logger: { info() {}, error() {} },
    snapshotWriter: async () => {},
  });
  const failed = await worker.processOnce();
  assert.equal(failed.providers.find((item) => item.providerId === "turso").state, "partial_failure");
  assert.equal(storage.snapshots.getStatusCounts("turso").dead_letter ?? 0, 0);
  assert.equal(storage.snapshots.getStatusCounts("turso").retry >= 4, true);
  assert.equal(storage.snapshots.getStatusCounts("supabase").synced >= 4, true);

  at += 1_101;
  const recovered = await worker.processOnce();
  assert.equal(recovered.providers.find((item) => item.providerId === "turso").state, "snapshot_synced");
  await worker.processOnce();
  assert.equal(storage.snapshots.getStatusCounts("turso").retry ?? 0, 0);
  assert.equal(storage.snapshots.getStatusCounts("turso").dead_letter ?? 0, 0);
  assert.equal(turso.state.snapshots.get(`analytics:${analyticsCurrentProjectionKey(guildId)}`).payload.messageCount, 10);
  storage.close();
});

test("Cloud writes scale with bounded buckets, not with 100/1000/10000 raw rows", () => {
  for (const count of [100, 1_000, 10_000]) {
    let at = Date.parse("2026-08-27T09:00:00.000Z");
    const now = () => at;
    const storage = createLocalStorage({ databasePath: ":memory:", now });
    recordMessages(storage, count, { occurredAt: at });
    const service = createAnalyticsCompactionService(storage, {
      config: getAnalyticsCompactionConfig(compactionEnv),
      now,
      logger: { info() {} },
    });
    const result = service.refreshDue({ at });
    const projections = storage.snapshots
      .listForReconciliation({ limit: 100 })
      .filter((item) => item.aggregateId.startsWith("v2:guild:"));
    assert.equal(storage.analyticsProjections.countRawMessages(guildId), count);
    assert.equal(result.changed, 4);
    assert.equal(projections.length, 4);
    assert.equal(projections.length * 2, 8);
    assert.equal((projections.length * 2) / count <= (count === 100 ? 0.08 : 0.008), true);
    storage.close();
  }
});

test("History Import is integrated with SQLite-first compaction without raw Cloud writes", () => {
  const worker = readFileSync(
    new URL("../lib/message-history-import-worker.mjs", import.meta.url),
    "utf8",
  );
  const documentation = readFileSync(
    new URL("../docs/analytics-compaction-v2.md", import.meta.url),
    "utf8",
  );
  assert.match(worker, /requireLocal\(guildId\)\.saveBatch/);
  assert.doesNotMatch(worker, /INSERT INTO "discord_message"/);
  assert.doesNotMatch(documentation, /Follow-up blocker: Message History Import/);
  assert.match(documentation, /SQLite-first/i);
});

test("Web analytics refresh uses one-shot scheduling instead of minute polling", () => {
  const analyticsDashboard = readFileSync(
    new URL("../components/community-analytics-dashboard.tsx", import.meta.url),
    "utf8",
  );
  const countdown = readFileSync(
    new URL("../components/analytics-refresh-countdown.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(analyticsDashboard, /setInterval|60_000/);
  assert.match(countdown, /setTimeout/);
  assert.match(countdown, /setInterval\(\(\) => setClock\(Date\.now\(\)\), 1_000\)/);
  assert.match(countdown, /This interval updates only the browser text/);
});
