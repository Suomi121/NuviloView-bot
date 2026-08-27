import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStorage } from "../lib/storage/index.mjs";
import { createMessageDomainRouter } from "../lib/message-local-first.mjs";
import { createMessageHistoryImportRepository } from "../lib/message-history-import-worker.mjs";
import {
  analyticsCurrentProjectionKey,
  createAnalyticsCompactionService,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";
import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { MultiProviderSyncWorker } from "../lib/sync/multi-worker.mjs";
import { getProviderPolicyDefinitions } from "../lib/sync/providers/contract.mjs";

const guildId = "110000000000000001";
const channelId = "220000000000000001";
const userId = "330000000000000001";

const environment = Object.freeze({
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
  SUPABASE_DATABASE_URL: "postgresql://isolated.invalid/history",
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

function importedRecord(index, jobId, occurredAt) {
  const messageId = String(440000000000000000n + BigInt(index));
  return {
    id: messageId,
    guildId,
    channelId,
    channelName: "history",
    authorId: userId,
    authorName: "History member",
    authorRoleIds: ["550000000000000001"],
    content: `history message ${index}`,
    createdAt: new Date(occurredAt).toISOString(),
    source: "history_import",
    importJobId: jobId,
  };
}

function saveImportedMessages(
  storage,
  count,
  {
    jobId = "history-job-1",
    channelProgressId = `${jobId}:channel`,
    offset = 0,
    occurredAt = Date.parse("2026-08-27T00:00:00.000Z"),
  } = {},
) {
  storage.historyImport.ensureJob({ jobId, guildId, status: "running" });
  storage.historyImport.ensureChannel({
    jobId,
    guildId,
    channelProgressId,
    channelId,
    channelName: "history",
    status: "running",
  });
  let before = null;
  let lastResult = null;
  for (let start = 0; start < count; start += 100) {
    const length = Math.min(100, count - start);
    const records = Array.from({ length }, (_, index) =>
      importedRecord(offset + start + index, jobId, occurredAt + start + index),
    );
    const nextBefore = records.at(-1)?.id ?? before;
    lastResult = storage.historyImport.saveBatch({
      jobId,
      guildId,
      channelProgressId,
      channelId,
      channelName: "history",
      records,
      fetchedCount: records.length,
      requestBeforeMessageId: before,
      nextBeforeMessageId: nextBefore,
      oldestMessageId: nextBefore,
    });
    before = nextBefore;
  }
  return lastResult;
}

function fakeProvider(id, { failures = 0 } = {}) {
  const state = {
    failures,
    eventWrites: 0,
    snapshotWrites: 0,
    analyticsSnapshotWrites: 0,
    snapshots: new Map(),
  };
  return {
    id,
    required: true,
    state,
    isEnabled: () => true,
    async pushEvents(items) {
      state.eventWrites += items.length;
      return {
        succeededEventIds: items.map((item) => item.eventId),
        failed: [],
      };
    },
    async pushSnapshots(items) {
      if (state.failures > 0) {
        state.failures -= 1;
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connection reset"), {
            code: "ECONNRESET",
          }),
        });
      }
      state.snapshotWrites += items.length;
      state.analyticsSnapshotWrites += items.filter(
        (item) =>
          item.snapshotType === "analytics" &&
          String(item.aggregateId).startsWith("v2:guild:"),
      ).length;
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
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
  };
}

function createWorker(storage, providers, now) {
  return new MultiProviderSyncWorker({
    storage,
    registry: registry(providers),
    config: getMultiDbSyncConfig(environment),
    now,
    random: () => 0,
    logger: { info() {}, error() {} },
    snapshotWriter: async () => {},
  });
}

test("200 imported raw messages remain local and only four projections reach each Cloud", async () => {
  let at = Date.parse("2026-08-27T10:00:00.000Z");
  const now = () => at;
  const storage = createLocalStorage({
    databasePath: ":memory:",
    providerDefinitions: getProviderPolicyDefinitions(environment),
    now,
  });
  const batch = saveImportedMessages(storage, 200, { occurredAt: at });
  assert.equal(batch.job.fetchedCount, 200);
  assert.equal(batch.job.insertedCount, 200);
  assert.equal(batch.job.duplicateCount, 0);
  assert.equal(storage.historyImport.getImportedCount(guildId), 200);
  assert.equal(storage.messageDomain.getComparisonSnapshot(guildId).createCount, 200);
  assert.equal(storage.outbox.getStatusCounts().pending, 0);

  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(environment),
    now,
    logger: { info() {} },
  });
  assert.equal(service.refreshDue({ at }).changed, 4);
  const currentKey = analyticsCurrentProjectionKey(guildId);
  const current = storage.snapshots.get("analytics", currentKey);
  assert.equal(current.payload.messageCount, 200);
  assert.equal(current.payload.rawContentIncluded, false);
  assert.equal(JSON.stringify(current.payload).includes("history message"), false);

  const supabase = fakeProvider("supabase");
  const turso = fakeProvider("turso");
  const worker = createWorker(storage, [supabase, turso], now);
  await worker.processOnce();
  assert.equal(supabase.state.eventWrites, 0);
  assert.equal(turso.state.eventWrites, 0);
  assert.equal(supabase.state.analyticsSnapshotWrites, 4);
  assert.equal(turso.state.analyticsSnapshotWrites, 4);
  const supabaseCurrent = supabase.state.snapshots.get(`analytics:${currentKey}`);
  const tursoCurrent = turso.state.snapshots.get(`analytics:${currentKey}`);
  assert.equal(supabaseCurrent.checksum, tursoCurrent.checksum);
  assert.equal(supabaseCurrent.payload.messageCount, 200);
  storage.close();
});

test("duplicates do not change totals and live provenance always wins", () => {
  let at = Date.parse("2026-08-27T11:00:00.000Z");
  const storage = createLocalStorage({
    databasePath: ":memory:",
    now: () => at,
  });
  saveImportedMessages(storage, 2, { jobId: "history-job-a", occurredAt: at });
  const duplicateRecord = importedRecord(1, "history-job-b", at + 1);
  storage.historyImport.ensureJob({
    jobId: "history-job-b",
    guildId,
    status: "running",
  });
  storage.historyImport.ensureChannel({
    jobId: "history-job-b",
    guildId,
    channelProgressId: "history-job-b:channel",
    channelId,
    channelName: "history",
    status: "running",
  });
  const duplicate = storage.historyImport.saveBatch({
    jobId: "history-job-b",
    guildId,
    channelProgressId: "history-job-b:channel",
    channelId,
    channelName: "history",
    records: [duplicateRecord],
    fetchedCount: 1,
    requestBeforeMessageId: null,
    nextBeforeMessageId: duplicateRecord.id,
    oldestMessageId: duplicateRecord.id,
  });
  assert.equal(duplicate.insertedCount, 0);
  assert.equal(duplicate.duplicateCount, 1);
  assert.equal(storage.messageDomain.getComparisonSnapshot(guildId).createCount, 2);

  const promotedMessageId = importedRecord(0, "history-job-a", at).id;
  const promoted = storage.messageDomain.recordEvent({
    eventId: `message-create:${guildId}:${promotedMessageId}`,
    guildId,
    channelId,
    messageId: promotedMessageId,
    authorId: userId,
    eventType: "create",
    revision: "create:live",
    sourceSequence: at + 10_000,
    content: "live version",
    occurredAt: at + 10_000,
    source: "live",
    actorName: "Live member",
    channelName: "general",
    payload: {
      source: "live",
      authorName: "Live member",
      channelName: "general",
      content: "live version",
    },
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.current.source, "live");
  assert.equal(storage.messageDomain.getComparisonSnapshot(guildId).createCount, 2);

  const liveMessageId = "440000000000009999";
  storage.messageDomain.recordEvent({
    eventId: `message-create:${guildId}:${liveMessageId}`,
    guildId,
    channelId,
    messageId: liveMessageId,
    authorId: userId,
    eventType: "create",
    revision: "create:live-only",
    sourceSequence: at + 20_000,
    content: "live only",
    occurredAt: at + 20_000,
    source: "live",
    actorName: "Live member",
    payload: { source: "live", authorName: "Live member" },
  });
  storage.messageDomain.recordEvent({
    eventId: `message-delete:${guildId}:${promotedMessageId}`,
    guildId,
    channelId,
    messageId: promotedMessageId,
    authorId: userId,
    eventType: "delete",
    revision: "delete:live",
    sourceSequence: at + 30_000,
    occurredAt: at + 30_000,
    source: "live",
    payload: { source: "live" },
  });
  const deletedWithoutLiveCreateId = importedRecord(
    1,
    "history-job-a",
    at + 1,
  ).id;
  storage.messageDomain.recordEvent({
    eventId: `message-delete:${guildId}:${deletedWithoutLiveCreateId}`,
    guildId,
    channelId,
    messageId: deletedWithoutLiveCreateId,
    authorId: userId,
    eventType: "delete",
    revision: "delete:live-with-history-only-create",
    sourceSequence: at + 31_000,
    occurredAt: at + 31_000,
    source: "live",
    payload: { source: "live" },
  });

  const deletion = storage.historyImport.deleteImportedHistory({
    requestId: "delete-history-a",
    guildId,
  });
  assert.equal(deletion.deletedMessages, 1);
  assert.equal(storage.historyImport.getImportedCount(guildId), 0);
  assert.equal(storage.messageDomain.getCurrent(guildId, promotedMessageId).eventType, "delete");
  assert.equal(storage.messageDomain.getCurrent(guildId, promotedMessageId).source, "live");
  assert.equal(
    storage.messageDomain.getCurrent(guildId, deletedWithoutLiveCreateId).eventType,
    "delete",
  );
  assert.equal(
    storage.messageDomain.getCurrent(guildId, deletedWithoutLiveCreateId).content,
    null,
  );
  assert.equal(storage.messageDomain.getCurrent(guildId, liveMessageId).source, "live");
  const replay = storage.historyImport.deleteImportedHistory({
    requestId: "delete-history-a",
    guildId,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.deletedMessages, 1);
  storage.close();
});

test("the real Message Router promotes an imported create when Discord observes it live", async () => {
  const at = Date.parse("2026-08-27T11:30:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  saveImportedMessages(storage, 1, {
    jobId: "router-promotion-job",
    occurredAt: at,
  });
  const messageId = importedRecord(0, "router-promotion-job", at).id;
  const router = createMessageDomainRouter({
    env: environment,
    storage,
    now: () => at + 1_000,
    legacy: {
      create: () => assert.fail("Legacy create must not run for the Canary Guild."),
      update: () => assert.fail("Legacy update must not run for the Canary Guild."),
      remove: () => assert.fail("Legacy delete must not run for the Canary Guild."),
      recordActiveMember: () => assert.fail("Legacy activity must not run for the Canary Guild."),
    },
  });
  const result = await router.create({
    id: messageId,
    content: "history message 0",
    createdTimestamp: at,
    guild: { id: guildId, memberCount: 76 },
    channel: { id: channelId, name: "history" },
    author: { id: userId, username: "History member", bot: false },
    member: { displayName: "History member", roles: { cache: new Map() } },
  });
  assert.equal(result.promoted, true);
  assert.equal(result.current.source, "live");
  assert.equal(result.current.importJobId, null);
  assert.equal(storage.messageDomain.getComparisonSnapshot(guildId).createCount, 1);
  storage.close();
});

test("Job checkpoint, retry state, and batch receipt survive close and reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-history-v3-"));
  const databasePath = join(directory, "nuviloview.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let at = Date.parse("2026-08-27T12:00:00.000Z");
  let storage = createLocalStorage({ databasePath, now: () => at });
  const saved = saveImportedMessages(storage, 100, {
    jobId: "restart-job",
    occurredAt: at,
  });
  storage.historyImport.setChannelState(
    "restart-job",
    channelId,
    "paused",
    { retryCount: 2, retryAfterAt: at + 5_000 },
  );
  storage.historyImport.setJobState("restart-job", "paused", {
    retryState: "ECONNRESET",
    retryAfterAt: at + 5_000,
    lastHeartbeatAt: at,
  });
  const batchId = saved.batchId;
  const checkpoint = saved.channel.nextBeforeMessageId;
  storage.close();

  at += 10_000;
  storage = createLocalStorage({ databasePath, now: () => at });
  assert.equal(storage.historyImport.getImportedCount(guildId), 100);
  assert.equal(storage.historyImport.getJob("restart-job").status, "paused");
  assert.equal(storage.historyImport.getJob("restart-job").retryState, "ECONNRESET");
  assert.equal(
    storage.historyImport.getChannel("restart-job", channelId).nextBeforeMessageId,
    checkpoint,
  );
  assert.equal(storage.historyImport.getBatch(batchId).insertedCount, 100);

  const records = Array.from({ length: 100 }, (_, index) =>
    importedRecord(index, "restart-job", Date.parse("2026-08-27T12:00:00.000Z") + index),
  );
  const replay = storage.historyImport.saveBatch({
    jobId: "restart-job",
    guildId,
    channelProgressId: "restart-job:channel",
    channelId,
    channelName: "history",
    records,
    fetchedCount: 100,
    requestBeforeMessageId: null,
    nextBeforeMessageId: checkpoint,
    oldestMessageId: checkpoint,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.insertedCount, 100);
  assert.equal(storage.messageDomain.getComparisonSnapshot(guildId).createCount, 100);
  storage.historyImport.setJobState("restart-job", "running", {
    retryState: null,
    retryAfterAt: null,
  });
  storage.historyImport.setJobState("restart-job", "cancelled");
  assert.equal(storage.historyImport.getJob("restart-job").status, "cancelled");
  storage.close();
});

test("History raw volume does not scale Cloud projection writes", () => {
  for (const count of [100, 1_000, 10_000]) {
    const at = Date.parse("2026-08-27T13:00:00.000Z");
    const storage = createLocalStorage({
      databasePath: ":memory:",
      now: () => at,
    });
    saveImportedMessages(storage, count, {
      jobId: `performance-${count}`,
      occurredAt: at,
    });
    const service = createAnalyticsCompactionService(storage, {
      config: getAnalyticsCompactionConfig(environment),
      now: () => at,
      logger: { info() {} },
    });
    const result = service.refreshDue({ at });
    const projections = storage.snapshots
      .listForReconciliation({ limit: 100 })
      .filter((item) => item.aggregateId.startsWith("v2:guild:"));
    assert.equal(storage.historyImport.getImportedCount(guildId), count);
    assert.equal(storage.messageDomain.getComparisonSnapshot(guildId).createCount, count);
    assert.equal(storage.outbox.getStatusCounts().pending, 0);
    assert.equal(result.changed, 4);
    assert.equal(projections.length, 4);
    assert.equal(projections.length * 2, 8);
    assert.equal(
      1 - ((projections.length * 2) / count),
      count === 100 ? 0.92 : count === 1_000 ? 0.992 : 0.9992,
    );
    storage.close();
  }
});

test("Cloud outage keeps History raw local and recovers projection without DLQ", async () => {
  let at = Date.parse("2026-08-27T14:00:00.000Z");
  const now = () => at;
  const storage = createLocalStorage({
    databasePath: ":memory:",
    providerDefinitions: getProviderPolicyDefinitions(environment),
    now,
  });
  saveImportedMessages(storage, 100, {
    jobId: "outage-job",
    occurredAt: at,
  });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(environment),
    now,
    logger: { info() {} },
  });
  service.refreshDue({ at });
  const supabase = fakeProvider("supabase");
  const turso = fakeProvider("turso", { failures: 1 });
  const worker = createWorker(storage, [supabase, turso], now);
  const failed = await worker.processOnce();
  assert.equal(
    failed.providers.find((item) => item.providerId === "turso").state,
    "partial_failure",
  );
  assert.equal(storage.historyImport.getImportedCount(guildId), 100);
  assert.equal(storage.snapshots.getStatusCounts("turso").dead_letter ?? 0, 0);
  assert.equal(storage.snapshots.getStatusCounts("turso").retry >= 4, true);
  assert.equal(supabase.state.analyticsSnapshotWrites, 4);

  at += 1_101;
  await worker.processOnce();
  await worker.processOnce();
  assert.equal(storage.snapshots.getStatusCounts("turso").retry ?? 0, 0);
  assert.equal(storage.snapshots.getStatusCounts("turso").dead_letter ?? 0, 0);
  const currentKey = analyticsCurrentProjectionKey(guildId);
  const supabaseCurrent = supabase.state.snapshots.get(`analytics:${currentKey}`);
  const tursoCurrent = turso.state.snapshots.get(`analytics:${currentKey}`);
  assert.equal(supabaseCurrent.checksum, tursoCurrent.checksum);
  assert.equal(tursoCurrent.payload.messageCount, 100);
  assert.equal(supabase.state.eventWrites + turso.state.eventWrites, 0);
  storage.close();
});

test("a failed Cloud control-plane checkpoint cannot roll back the local batch", async () => {
  const at = Date.parse("2026-08-27T14:30:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  const warnings = [];
  const repository = createMessageHistoryImportRepository(
    async () => {
      throw Object.assign(new Error("Cloud unavailable"), { code: "ECONNRESET" });
    },
    {
      storage,
      config: {
        sqliteFirstEnabled: true,
        isSqliteFirstGuild: (candidate) => candidate === guildId,
      },
      logger: { warn: (...values) => warnings.push(values) },
    },
  );
  const record = importedRecord(0, "cloud-control-outage", at);
  const result = await repository.saveBatch({
    jobId: "cloud-control-outage",
    guildId,
    channelProgressId: "cloud-control-outage:channel",
    channelId,
    channelName: "history",
    records: [record],
    fetchedCount: 1,
    requestBeforeMessageId: null,
    nextBeforeMessageId: record.id,
    oldestMessageId: record.id,
  });
  assert.equal(result.cloudMetadataSynced, false);
  assert.equal(result.insertedMessages, 1);
  assert.equal(storage.historyImport.getImportedCount(guildId), 1);
  assert.equal(storage.messageDomain.getCurrent(guildId, record.id).content, record.content);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes(record.content), false);
  storage.close();
});

test("History payload content is not included in any compacted snapshot", () => {
  const at = Date.parse("2026-08-27T15:00:00.000Z");
  const storage = createLocalStorage({
    databasePath: ":memory:",
    now: () => at,
  });
  saveImportedMessages(storage, 10, {
    jobId: "privacy-job",
    occurredAt: at,
  });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(environment),
    now: () => at,
    logger: { info() {} },
  });
  service.refreshDue({ at });
  for (const snapshot of storage.snapshots.listForReconciliation({ limit: 100 })) {
    const json = JSON.stringify(snapshot.payload);
    assert.equal(json.includes("history message"), false);
    assert.equal(snapshot.payload.rawContentIncluded, false);
    assert.match(snapshot.checksum, /^[a-f0-9]{64}$/);
  }
  storage.close();
});
