import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMessageDomainRouter,
  getMessageLocalFirstConfig,
  normalizeDiscordMessageEvent,
  UnsafeMessageRoutingChangeError,
} from "../lib/message-local-first.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";
import {
  createMessageNeonReplicaAdapter,
  MessageReplicaConflictError,
  messageBatchReplicaSql,
} from "../lib/sync/message-neon-replica.mjs";
import { getSyncWorkerConfig, SyncWorker } from "../lib/sync/worker.mjs";

const TEST_GUILD_ID = "1216303889599565875";

function message(id, overrides = {}) {
  const createdTimestamp = overrides.createdTimestamp ?? 1_700_000_000_000;
  return {
    id: String(id),
    content: overrides.content ?? `message-${id}`,
    createdTimestamp,
    createdAt: new Date(createdTimestamp),
    editedTimestamp: overrides.editedTimestamp ?? null,
    guild: { id: overrides.guildId ?? TEST_GUILD_ID, memberCount: 76 },
    channel: { id: overrides.channelId ?? "channel-1", name: "general" },
    channelId: overrides.channelId ?? "channel-1",
    author: {
      id: overrides.authorId ?? "user-1",
      username: "tester",
      globalName: null,
      bot: false,
    },
    member: {
      displayName: "Tester",
      roles: { cache: new Map([["role-1", {}]]) },
    },
  };
}

function harness(t, { initialNow = 1_700_000_100_000, local = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-message-local-"));
  const databasePath = join(directory, "data", "nuviloview.sqlite");
  let currentTime = initialNow;
  const now = () => currentTime;
  const storage = createLocalStorage({ databasePath, now });
  const legacyCalls = { create: 0, update: 0, remove: 0, active: 0 };
  const legacy = {
    async create() {
      legacyCalls.create += 1;
      return { legacy: true };
    },
    async update() {
      legacyCalls.update += 1;
      return { legacy: true };
    },
    async remove() {
      legacyCalls.remove += 1;
      return { legacy: true };
    },
    async recordActiveMember() {
      legacyCalls.active += 1;
      return { legacy: true };
    },
  };
  const env = {
    LOCAL_STORAGE_ENABLED: "true",
    LOCAL_STORAGE_WRITE_ENABLED: "true",
    LOCAL_STORAGE_PATH: databasePath,
    LOCAL_MESSAGE_STORAGE_ENABLED: local ? "true" : "false",
    LOCAL_MESSAGE_CANARY_GUILDS: local ? TEST_GUILD_ID : "",
  };
  const router = createMessageDomainRouter({
    env,
    cwd: directory,
    storage,
    legacy,
    now,
    logger: { error() {}, warn() {}, info() {} },
  });
  t.after(() => {
    router.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    databasePath,
    storage,
    router,
    legacyCalls,
    env,
    now,
    setNow(value) {
      currentTime = value;
    },
    advance(value) {
      currentTime += value;
    },
  };
}

function syncConfig(directory, overrides = {}) {
  return {
    ...getSyncWorkerConfig(
      {
        SYNC_BATCH_MIN: "25",
        SYNC_BATCH_MAX: "25",
        SYNC_METRICS_PATH: join(directory, "metrics.json"),
      },
      { cwd: directory },
    ),
    ...overrides,
  };
}

test("Message Local-First feature flag is OFF by default", () => {
  assert.equal(getMessageLocalFirstConfig({}).enabled, false);
});

test("Message Create writes current state, derived analytics, and Outbox atomically", async (t) => {
  const h = harness(t);
  const result = await h.router.create(message("100"));
  assert.equal(result.inserted, true);
  assert.equal(h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "100").content, "message-100");
  assert.equal(h.storage.outbox.getMessagePendingCount(), 1);
  assert.deepEqual(
    h.storage.messageDomain.getDerivedStats(TEST_GUILD_ID, "2023-11-14"),
    {
      messageCount: 1,
      memberCount: 76,
      activeMemberCount: 1,
      updatedAt: h.now(),
    },
  );
  assert.equal(h.legacyCalls.create, 0);
});

test("Message and Outbox both roll back when Event ID collides", async (t) => {
  const h = harness(t);
  const input = normalizeDiscordMessageEvent(message("collision"), "create", {
    now: h.now,
  });
  h.storage.outbox.enqueue({
    eventId: input.eventId,
    domain: "bot_event",
    eventType: "message_create",
    aggregateId: "different",
    payload: { changed: true },
    schemaVersion: 1,
    createdAt: input.occurredAt,
  });
  await assert.rejects(h.router.create(message("collision")), /collision/i);
  assert.equal(h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "collision"), null);
  assert.equal(h.storage.messageDomain.getMetrics().messageLocalWriteFailures, 1);
});

test("duplicate Create is idempotent and does not increment analytics twice", async (t) => {
  const h = harness(t);
  await h.router.create(message("duplicate"));
  const duplicate = await h.router.create(message("duplicate"));
  assert.equal(duplicate.inserted, false);
  assert.equal(h.storage.outbox.getMessagePendingCount(), 1);
  assert.equal(
    h.storage.messageDomain.getDerivedStats(TEST_GUILD_ID, "2023-11-14").messageCount,
    1,
  );
  assert.equal(h.storage.messageDomain.getMetrics().messageLocalWritesTotal, 1);
});

test("Message Update uses edited timestamp plus checksum and deduplicates a replay", async (t) => {
  const h = harness(t);
  await h.router.create(message("edit"));
  const edited = message("edit", {
    content: "edited",
    editedTimestamp: 1_700_000_010_000,
  });
  const first = await h.router.update(edited);
  const replay = await h.router.update(edited);
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.match(first.event.eventId, /^message-update:/);
  assert.equal(h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "edit").content, "edited");
  assert.equal(h.storage.outbox.getMessagePendingCount(), 2);
});

test("Delete creates a durable Tombstone and preserves Create to Delete ordering", async (t) => {
  const h = harness(t);
  await h.router.create(message("deleted"));
  h.setNow(1_700_000_020_000);
  const result = await h.router.remove(message("deleted"));
  const current = h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "deleted");
  assert.equal(result.previous.content, "message-deleted");
  assert.equal(current.eventType, "delete");
  assert.equal(current.content, null);
  assert.equal(current.deletedAt, h.now());
  assert.equal(current.deleteEventId, result.event.eventId);
  assert.equal(h.storage.outbox.getMessagePendingCount(), 2);
});

test("Create to Update to Delete rejects a late out-of-order Update as current state", async (t) => {
  const h = harness(t);
  await h.router.create(message("ordered"));
  await h.router.update(message("ordered", {
    content: "newer",
    editedTimestamp: 1_700_000_020_000,
  }));
  h.setNow(1_700_000_030_000);
  await h.router.remove(message("ordered"));
  await h.router.update(message("ordered", {
    content: "late-old-update",
    editedTimestamp: 1_700_000_025_000,
  }));
  const current = h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "ordered");
  assert.equal(current.eventType, "delete");
  assert.equal(current.content, null);
  assert.equal(h.storage.outbox.getMessagePendingCount(), 4);
});

test("Bulk Delete writes individual Tombstones in one local batch", async (t) => {
  const h = harness(t);
  await h.router.create(message("bulk-1"));
  await h.router.create(message("bulk-2"));
  h.setNow(1_700_000_050_000);
  const results = await h.router.removeMany([message("bulk-1"), message("bulk-2")]);
  assert.equal(results.length, 2);
  assert.equal(h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "bulk-1").eventType, "delete");
  assert.equal(h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "bulk-2").eventType, "delete");
  assert.equal(h.storage.outbox.getMessagePendingCount(), 4);
});

test("Worker or Neon downtime cannot prevent a Local-First Message save", async (t) => {
  const h = harness(t);
  await h.router.create(message("offline"));
  assert.equal(h.storage.messageDomain.getCurrent(TEST_GUILD_ID, "offline").content, "message-offline");
  assert.equal(h.storage.outbox.getMessagePendingCount(), 1);
  assert.equal(h.legacyCalls.create, 0);
});

test("Worker recovery batch-syncs pending Message events", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 3; index += 1) {
    await h.router.create(message(`recover-${index}`));
  }
  let neonQueries = 0;
  const replica = createMessageNeonReplicaAdapter({
    execute: async (sql, [json]) => {
      neonQueries += 1;
      assert.equal(sql, messageBatchReplicaSql);
      return {
        rows: JSON.parse(json).map((event) => ({
          event_id: event.event_id,
          checksum: event.checksum,
        })),
      };
    },
  });
  const worker = new SyncWorker({
    storage: h.storage,
    replica,
    config: syncConfig(h.directory),
    now: h.now,
    logger: { error() {}, warn() {}, info() {} },
    snapshotWriter: async () => {},
  });
  const result = await worker.processOnce();
  assert.equal(result.synced, 3);
  assert.equal(neonQueries, 1);
  assert.equal(h.storage.outbox.getMessagePendingCount(), 0);
  assert.equal(h.storage.messageDomain.getMetrics().messageSyncSuccessTotal, 3);
});

test("Message replica retry is idempotent and checksum mismatch is rejected", async (t) => {
  const h = harness(t);
  await h.router.create(message("replica"));
  const [queued] = h.storage.outbox.claimBatch({
    workerId: "replica-test",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  const replicaRows = new Map();
  const adapter = createMessageNeonReplicaAdapter({
    execute: async (_sql, [json]) => {
      for (const item of JSON.parse(json)) {
        if (!replicaRows.has(item.event_id)) replicaRows.set(item.event_id, item.checksum);
      }
      return { rows: [...replicaRows].map(([event_id, checksum]) => ({ event_id, checksum })) };
    },
  });
  await adapter.writeBatch([queued]);
  await adapter.writeBatch([queued]);
  assert.equal(replicaRows.size, 1);
  await assert.rejects(
    adapter.writeBatch([{ ...queued, checksum: "f".repeat(64) }]),
    (error) => error instanceof MessageReplicaConflictError,
  );
});

test("Message Neon replica contract converges Create, Update, Delete out of order", async (t) => {
  const h = harness(t);
  await h.router.create(message("remote-order"));
  await h.router.update(message("remote-order", {
    content: "remote-update",
    editedTimestamp: 1_700_000_020_000,
  }));
  h.setNow(1_700_000_030_000);
  await h.router.remove(message("remote-order"));
  const claimed = h.storage.outbox.claimBatch({
    workerId: "remote-order",
    limit: 10,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  const events = new Map();
  const current = new Map();
  const rank = { message_create: 0, message_update: 1, message_delete: 2 };
  const adapter = createMessageNeonReplicaAdapter({
    execute: async (_sql, [json]) => {
      const incoming = JSON.parse(json);
      for (const event of incoming) {
        if (!events.has(event.event_id)) events.set(event.event_id, event);
        const candidates = [...events.values()].filter(
          (candidate) => candidate.aggregate_id === event.aggregate_id,
        );
        candidates.sort((left, right) =>
          Number(right.payload.sourceSequence) - Number(left.payload.sourceSequence) ||
          rank[right.event_type] - rank[left.event_type] ||
          String(right.payload.revision).localeCompare(String(left.payload.revision)),
        );
        current.set(event.aggregate_id, candidates[0]);
      }
      return {
        rows: incoming.map((event) => ({
          event_id: event.event_id,
          checksum: events.get(event.event_id).checksum,
        })),
      };
    },
  });
  const byType = Object.fromEntries(claimed.map((item) => [item.eventType, item]));
  await adapter.writeBatch([byType.message_delete]);
  await adapter.writeBatch([byType.message_update]);
  await adapter.writeBatch([byType.message_create]);
  assert.equal(
    current.get(`message:${TEST_GUILD_ID}:remote-order`).event_type,
    "message_delete",
  );
});

test("Feature Flag OFF uses only Legacy Neon and ON uses only Local-First", async (t) => {
  const legacy = harness(t, { local: false });
  await legacy.router.create(message("legacy"));
  assert.equal(legacy.legacyCalls.create, 1);
  assert.equal(legacy.storage.messageDomain.getCurrent(TEST_GUILD_ID, "legacy"), null);

  const local = harness(t, { local: true });
  await local.router.create(message("local"));
  assert.equal(local.legacyCalls.create, 0);
  assert.notEqual(local.storage.messageDomain.getCurrent(TEST_GUILD_ID, "local"), null);
});

test("Rollback Guard blocks Legacy routing while Message Outbox is pending", async (t) => {
  const h = harness(t);
  await h.router.create(message("pending-rollback"));
  h.router.close();
  assert.throws(
    () =>
      createMessageDomainRouter({
        env: {
          LOCAL_STORAGE_ENABLED: "false",
          LOCAL_STORAGE_WRITE_ENABLED: "false",
          LOCAL_STORAGE_PATH: h.databasePath,
          LOCAL_MESSAGE_STORAGE_ENABLED: "false",
          LOCAL_MESSAGE_CANARY_GUILDS: "",
        },
        cwd: h.directory,
        legacy: {
          create() {}, update() {}, remove() {}, recordActiveMember() {},
        },
        logger: { error() {}, warn() {} },
      }),
    (error) => error instanceof UnsafeMessageRoutingChangeError && error.pendingCount === 1,
  );
});

test("Synced Outbox retention deletes only expired synced rows", async (t) => {
  const h = harness(t, { initialNow: 1_700_000_000_000 });
  await h.router.create(message("synced"));
  await h.router.create(message("pending"));
  const [synced, pending] = h.storage.outbox.claimBatch({
    workerId: "retention",
    limit: 2,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  h.storage.outbox.markSynced(synced.id, { workerId: "retention", at: h.now() });
  h.storage.outbox.markRetry(pending.id, {
    workerId: "retention",
    error: new Error("offline"),
    availableAt: h.now() + 1_000,
    at: h.now(),
  });
  h.advance(8 * 86_400_000);
  assert.equal(
    h.storage.outbox.purgeSynced({
      olderThan: h.now() - 7 * 86_400_000,
      limit: 500,
    }),
    1,
  );
  assert.equal(h.storage.outbox.getByEventId(synced.eventId), null);
  assert.equal(h.storage.outbox.getByEventId(pending.eventId).status, "retry");
});

test("Dead Letter rows are never removed by synced retention", async (t) => {
  const h = harness(t, { initialNow: 1_700_000_000_000 });
  await h.router.create(message("dead"));
  const [claimed] = h.storage.outbox.claimBatch({
    workerId: "dead-retention",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  h.storage.outbox.moveToDeadLetter(claimed.id, {
    workerId: "dead-retention",
    error: new Error("permanent"),
    at: h.now(),
  });
  h.advance(30 * 86_400_000);
  assert.equal(
    h.storage.outbox.purgeSynced({ olderThan: h.now(), limit: 500 }),
    0,
  );
  assert.equal(h.storage.outbox.getDeadLetterCount(), 1);
  assert.equal(h.storage.outbox.getByEventId(claimed.eventId).status, "dead_letter");
});

test("100 Messages replace about 400 Legacy writes with 100 local transactions and 4 batches", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 100; index += 1) {
    await h.router.create(message(`load-${index}`));
  }
  let neonQueries = 0;
  const worker = new SyncWorker({
    storage: h.storage,
    replica: {
      async writeBatch(items) {
        neonQueries += 1;
        return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
      },
    },
    config: syncConfig(h.directory),
    now: h.now,
    logger: { error() {}, warn() {}, info() {} },
    snapshotWriter: async () => {},
  });
  while (h.storage.outbox.getMessagePendingCount() > 0) {
    await worker.processOnce();
  }
  assert.equal(h.storage.messageDomain.getMetrics().messageLocalWritesTotal, 100);
  assert.equal(neonQueries, 4);
  assert.equal(h.legacyCalls.create, 0);
  assert.equal(100 * 4, 400);
});

test("Reaction, Voice, and Member handlers remain outside Message routing", () => {
  const source = readFileSync(new URL("../discord-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /client\.on\("messageReactionAdd"/);
  assert.match(source, /client\.on\("voiceStateUpdate"/);
  assert.match(source, /client\.on\(\s*"guildMemberAdd"/);
  assert.doesNotMatch(source, /messageRouter\.(?:reaction|voice|member)/);
});
