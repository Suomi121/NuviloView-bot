import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import pg from "pg";
import {
  checkMessageReplicaSchema,
  fetchMessageReplicaComparison,
} from "../lib/message-canary-postgres.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";
import {
  createMessageNeonReplicaAdapter,
  MessageReplicaConflictError,
} from "../lib/sync/message-neon-replica.mjs";
import { normalizeSyncEnvelope } from "../lib/sync/conflict-policy.mjs";
import { classifySyncError } from "../lib/sync/retry.mjs";
import { getSyncWorkerConfig, SyncWorker } from "../lib/sync/worker.mjs";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_REPLICA_DATABASE_URL?.trim();
const proposalSql = readFileSync(
  new URL("../docs/sql/phase3a-message-replica-proposal.sql", import.meta.url),
  "utf8",
);
const concurrentIndexesSql = readFileSync(
  new URL("../docs/sql/phase3a-message-replica-concurrent-indexes.sql", import.meta.url),
  "utf8",
);
const rollbackSql = readFileSync(
  new URL("../docs/sql/phase3a-message-replica-rollback.sql", import.meta.url),
  "utf8",
);
const baseTime = Date.parse("2026-08-24T00:00:00.000Z");
const canaryGuildId = "1216303889599565875";

function event(action, messageId, sequence, overrides = {}) {
  const occurredAt = overrides.occurredAt ?? baseTime + sequence * 1_000;
  const guildId = overrides.guildId ?? "guild-main";
  const eventId = overrides.eventId ?? `phase3a:${guildId}:${messageId}:${action}:${sequence}`;
  return normalizeSyncEnvelope({
    eventId,
    domain: "bot_event",
    eventType: `message_${action}`,
    aggregateId: `message:${guildId}:${messageId}`,
    payload: {
      guildId,
      channelId: overrides.channelId ?? "channel-main",
      channelName: overrides.channelName ?? "general",
      messageId,
      authorId: overrides.authorId ?? "user-main",
      authorName: overrides.authorName ?? "Phase 3A User",
      authorIsBot: false,
      authorRoleIds: ["role-1"],
      content: action === "delete" ? null : (overrides.content ?? `${action}-${sequence}`),
      eventType: action,
      revision: overrides.revision ?? `${String(sequence).padStart(16, "0")}:${action}`,
      sourceSequence: sequence,
      occurredAt,
      source: "live",
    },
    schemaVersion: 1,
    createdAt: occurredAt,
  });
}

function invalidEvent(messageId, sequence) {
  return normalizeSyncEnvelope({
    eventId: `phase3a:invalid:${messageId}:${sequence}`,
    domain: "bot_event",
    eventType: "message_update",
    aggregateId: `message:invalid:${messageId}`,
    payload: {
      messageId,
      channelId: "channel-invalid",
      authorId: "user-invalid",
      content: "invalid-without-guild",
      revision: `${sequence}:invalid`,
      sourceSequence: sequence,
      occurredAt: baseTime + sequence * 1_000,
    },
    schemaVersion: 1,
    createdAt: baseTime + sequence * 1_000,
  });
}

async function createBaseSchema(client) {
  await client.query(`
    CREATE TABLE "daily_stats" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "memberCount" integer NOT NULL DEFAULT 0,
      "messageCount" integer NOT NULL DEFAULT 0,
      "reactionCount" integer NOT NULL DEFAULT 0,
      "date" date NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("guildId", "date")
    );
    CREATE TABLE "daily_active_member" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "userId" text NOT NULL,
      "date" date NOT NULL,
      UNIQUE ("guildId", "userId", "date")
    );
    CREATE TABLE "recent_activity" (
      "id" serial PRIMARY KEY,
      "guildId" text NOT NULL,
      "type" text NOT NULL,
      "actorName" text NOT NULL,
      "channelName" text,
      "occurredAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "discord_message" (
      "id" text PRIMARY KEY,
      "guildId" text NOT NULL,
      "channelId" text,
      "channelName" text NOT NULL,
      "authorId" text NOT NULL,
      "authorName" text NOT NULL,
      "authorIsBot" boolean NOT NULL DEFAULT false,
      "authorRoleIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "content" text NOT NULL,
      "source" text NOT NULL DEFAULT 'existing',
      "importJobId" integer,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function applyConcurrentIndexes(client) {
  const statements = concurrentIndexesSql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await client.query(statement);
}

async function tableCount(client, table, where = "TRUE", values = []) {
  const result = await client.query(`SELECT COUNT(*)::integer AS count FROM ${table} WHERE ${where}`, values);
  return result.rows[0].count;
}

test(
  "Phase 3A Message replica migration and Batch Sync pass on isolated PostgreSQL",
  { skip: !testDatabaseUrl },
  async (t) => {
    const client = new Client({
      connectionString: testDatabaseUrl,
      application_name: "nuviloview-phase3a-isolated-test",
      connectionTimeoutMillis: 2_000,
    });
    await client.connect();
    const schema = `phase3a_${process.pid}_${Date.now()}`;
    const failureSchema = `${schema}_failure`;
    t.after(async () => {
      await client.query("RESET statement_timeout").catch(() => {});
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${failureSchema}" CASCADE`).catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await client.end();
    });

    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SET TIME ZONE 'UTC'");
    await createBaseSchema(client);

    await t.test("migration is transactional, repeatable, and schema-compatible", async () => {
      await client.query(proposalSql);
      await assert.rejects(
        client.query("SELECT * FROM sync_message_event_batch('[]'::jsonb)"),
        (error) => error?.code === "55000",
      );
      await applyConcurrentIndexes(client);
      const relations = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name IN ('message_event_replica', 'message_tombstone', 'message_daily_stat_baseline')
        ORDER BY table_name
      `, [schema]);
      assert.deepEqual(relations.rows.map((row) => row.table_name), [
        "message_daily_stat_baseline",
        "message_event_replica",
        "message_tombstone",
      ]);

      const columns = await client.query(`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'message_event_replica' AND column_name IN ('event_id', 'payload', 'checksum', 'received_at'))
            OR (table_name = 'message_tombstone' AND column_name IN ('deletedAt', 'deleteEventId', 'revision')))
        ORDER BY table_name, column_name
      `, [schema]);
      const types = Object.fromEntries(
        columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
      );
      assert.equal(types["message_event_replica.event_id"], "text");
      assert.equal(types["message_event_replica.payload"], "jsonb");
      assert.equal(types["message_event_replica.checksum"], "text");
      assert.equal(types["message_event_replica.received_at"], "timestamp with time zone");
      assert.equal(types["message_tombstone.deletedAt"], "timestamp with time zone");
      assert.equal(types["message_tombstone.deleteEventId"], "text");
      assert.equal(types["message_tombstone.revision"], "text");

      const indexes = await client.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND indexname LIKE '%message%'
      `, [schema]);
      const indexNames = new Set(indexes.rows.map((row) => row.indexname));
      assert.ok(indexNames.has("message_event_replica_message_order_idx"));
      assert.ok(indexNames.has("message_event_replica_aggregate_order_idx"));
      assert.ok(indexNames.has("message_event_replica_occurred_idx"));
      assert.ok(indexNames.has("message_tombstone_deleted_at_idx"));

      const constraints = await client.query(`
        SELECT contype FROM pg_constraint
        WHERE conrelid = 'message_tombstone'::regclass
      `);
      assert.ok(constraints.rows.some((row) => row.contype === "p"));
      assert.ok(constraints.rows.some((row) => row.contype === "u"));
      assert.ok(constraints.rows.some((row) => row.contype === "f"));

      const functionExists = await client.query(
        "SELECT to_regprocedure('sync_message_event_batch(jsonb)') IS NOT NULL AS present",
      );
      assert.equal(functionExists.rows[0].present, true);

      await client.query(proposalSql);
      await applyConcurrentIndexes(client);
      assert.equal(await tableCount(client, "message_event_replica"), 0);
    });

    let queryCount = 0;
    const adapter = createMessageNeonReplicaAdapter({
      execute: async (sql, parameters) => {
        queryCount += 1;
        return client.query(sql, parameters);
      },
    });

    await t.test("Create is materialized once with retry-safe derived tables", async () => {
      await client.query(`
        INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "date")
        VALUES ('guild-main', 76, 7, '2026-08-24')
      `);
      const created = event("create", "create-1", 1, { content: "original" });
      await adapter.writeBatch([created]);
      await adapter.writeBatch([created]);
      await adapter.writeBatch([created]);
      const message = await client.query(
        `SELECT "content", "sourceEventId", "createdAt", "updatedAt" FROM "discord_message" WHERE "id" = $1`,
        ["create-1"],
      );
      assert.equal(message.rows[0].content, "original");
      assert.equal(message.rows[0].sourceEventId, created.eventId);
      assert.equal(message.rows[0].createdAt.getTime(), created.payload.occurredAt);
      assert.equal(message.rows[0].updatedAt.getTime(), created.payload.occurredAt);
      assert.equal(await tableCount(client, "message_event_replica", "event_id = $1", [created.eventId]), 1);
      assert.equal(await tableCount(client, '"recent_activity"', '"sourceEventId" = $1', [created.eventId]), 1);
      const activityLink = await client.query(`
        SELECT activity."sourceEventId", replica.payload->>'messageId' AS "messageId"
        FROM "recent_activity" activity
        JOIN message_event_replica replica ON replica.event_id = activity."sourceEventId"
        WHERE activity."sourceEventId" = $1
      `, [created.eventId]);
      assert.deepEqual(activityLink.rows[0], {
        sourceEventId: created.eventId,
        messageId: "create-1",
      });
      assert.equal(await tableCount(client, '"daily_active_member"', '"guildId" = $1 AND "userId" = $2', ["guild-main", "user-main"]), 1);
      const stats = await client.query(
        `SELECT "messageCount", "memberCount" FROM "daily_stats" WHERE "guildId" = 'guild-main' AND "date" = '2026-08-24'`,
      );
      assert.deepEqual(stats.rows[0], { messageCount: 8, memberCount: 76 });
    });

    await t.test("Update converges on v2 and preserves the event edit timestamp", async () => {
      const created = event("create", "updated-1", 10, { content: "create" });
      const update1 = event("update", "updated-1", 11, { content: "update-v1" });
      const update2 = event("update", "updated-1", 12, { content: "update-v2" });
      await adapter.writeBatch([created, update1, update2]);
      await adapter.writeBatch([update1]);
      await adapter.writeBatch([update2]);
      const row = await client.query(
        `SELECT "content", "sourceRevision", "sourceSequence", "updatedAt" FROM "discord_message" WHERE "id" = 'updated-1'`,
      );
      assert.equal(row.rows[0].content, "update-v2");
      assert.equal(row.rows[0].sourceRevision, update2.payload.revision);
      assert.equal(Number(row.rows[0].sourceSequence), 12);
      assert.equal(row.rows[0].updatedAt.getTime(), update2.payload.occurredAt);
    });

    await t.test("Delete creates a durable Tombstone and older events cannot revive it", async () => {
      const created = event("create", "deleted-1", 20, { content: "create" });
      const updated = event("update", "deleted-1", 21, { content: "updated" });
      const deleted = event("delete", "deleted-1", 22);
      await adapter.writeBatch([created, updated, deleted]);
      await adapter.writeBatch([deleted]);
      await adapter.writeBatch([updated, created]);
      assert.equal(await tableCount(client, '"discord_message"', '"id" = $1', ["deleted-1"]), 0);
      const tombstone = await client.query(
        `SELECT "deleteEventId", "deletedAt", "sourceSequence", "revision" FROM message_tombstone WHERE "guildId" = 'guild-main' AND "messageId" = 'deleted-1'`,
      );
      assert.equal(tombstone.rows[0].deleteEventId, deleted.eventId);
      assert.equal(tombstone.rows[0].deletedAt.getTime(), deleted.payload.occurredAt);
      assert.equal(Number(tombstone.rows[0].sourceSequence), 22);
      assert.equal(tombstone.rows[0].revision, deleted.payload.revision);
    });

    await t.test("all required out-of-order sequences converge", async () => {
      const cases = [
        ["order-update-create", [event("update", "order-update-create", 32, { content: "u2" }), event("create", "order-update-create", 31, { content: "c1" })], "u2"],
        ["order-delete-update-create", [event("delete", "order-delete-update-create", 43), event("update", "order-delete-update-create", 42), event("create", "order-delete-update-create", 41)], null],
        ["order-create-delete-update", [event("create", "order-create-delete-update", 51), event("delete", "order-create-delete-update", 53), event("update", "order-create-delete-update", 52)], null],
        ["order-update-v2-v1", [event("update", "order-update-v2-v1", 62, { content: "v2" }), event("update", "order-update-v2-v1", 61, { content: "v1" })], "v2"],
      ];
      for (const [messageId, items, expectedContent] of cases) {
        for (const item of items) await adapter.writeBatch([item]);
        const row = await client.query(`SELECT "content" FROM "discord_message" WHERE "id" = $1`, [messageId]);
        if (expectedContent === null) assert.equal(row.rowCount, 0);
        else assert.equal(row.rows[0].content, expectedContent);
      }
    });

    await t.test("100 creates and three identical deliveries remain idempotent", async () => {
      await client.query(`
        INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "date")
        VALUES ('1216303889599565875', 76, 7, '2026-08-24')
      `);
      const items = Array.from({ length: 100 }, (_, index) => event("create", `daily-${index}`, 1_000 + index, {
        content: `daily-${index}`,
        authorId: "user-bulk",
        guildId: canaryGuildId,
      }));
      const before = queryCount;
      for (let index = 0; index < items.length; index += 25) {
        await adapter.writeBatch(items.slice(index, index + 25));
      }
      const firstQueryCount = queryCount - before;
      for (let retry = 0; retry < 2; retry += 1) {
        for (let index = 0; index < items.length; index += 25) {
          await adapter.writeBatch(items.slice(index, index + 25));
        }
      }
      assert.equal(firstQueryCount, 4);
      assert.equal(await tableCount(client, "message_event_replica", "event_id LIKE 'phase3a:1216303889599565875:daily-%'"), 100);
      assert.equal(await tableCount(client, '"discord_message"', '"id" LIKE \'daily-%\''), 100);
      assert.equal(await tableCount(client, '"recent_activity"', '"sourceEventId" LIKE \'phase3a:1216303889599565875:daily-%\''), 100);
      assert.equal(await tableCount(client, '"daily_active_member"', '"guildId" = \'1216303889599565875\' AND "userId" = \'user-bulk\''), 1);
      const stats = await client.query(
        `SELECT "messageCount" FROM "daily_stats" WHERE "guildId" = '1216303889599565875' AND "date" = '2026-08-24'`,
      );
      assert.equal(stats.rows[0].messageCount, 107);
    });

    await t.test("Canary schema and aggregate comparison are ready without Message content", async () => {
      const execute = (sql, parameters) => client.query(sql, parameters);
      const schemaStatus = await checkMessageReplicaSchema(execute);
      assert.equal(schemaStatus.ready, true);
      const comparison = await fetchMessageReplicaComparison(execute, canaryGuildId);
      assert.equal(comparison.replicaEventCount, 100);
      assert.equal(comparison.materializedMessageCount, 100);
      assert.equal(comparison.tombstoneCount, 0);
      assert.equal(comparison.recentActivityCount, 100);
      assert.equal(comparison.expectedActiveMemberCount, 1);
      assert.equal(comparison.dailyStatsMismatchCount, 0);
      assert.equal(comparison.activeMemberMissingCount, 0);
      assert.doesNotMatch(JSON.stringify(comparison), /content/i);
    });

    await t.test("Active Member uses the UTC day boundary per Guild", async () => {
      const beforeMidnight = event("create", "boundary-before", 2_000, {
        guildId: "guild-boundary",
        authorId: "user-boundary",
        occurredAt: Date.parse("2026-08-24T23:59:59.000Z"),
      });
      const afterMidnight = event("create", "boundary-after", 2_001, {
        guildId: "guild-boundary",
        authorId: "user-boundary",
        occurredAt: Date.parse("2026-08-25T00:00:00.000Z"),
      });
      await adapter.writeBatch([beforeMidnight, afterMidnight]);
      const dates = await client.query(`
        SELECT "date"::text AS date FROM "daily_active_member"
        WHERE "guildId" = 'guild-boundary' AND "userId" = 'user-boundary'
        ORDER BY "date"
      `);
      assert.deepEqual(dates.rows.map((row) => row.date), ["2026-08-24", "2026-08-25"]);
    });

    await t.test("Batch sizes 25, 50, and 100 use one client query each", async () => {
      for (const size of [25, 50, 100]) {
        const items = Array.from({ length: size }, (_, index) => event("create", `batch-${size}-${index}`, size * 10_000 + index, {
          guildId: `guild-batch-${size}`,
          authorId: `user-batch-${size}`,
        }));
        const before = queryCount;
        await adapter.writeBatch(items);
        assert.equal(queryCount - before, 1);
        await adapter.writeBatch(items);
        assert.equal(queryCount - before, 2);
        assert.equal(await tableCount(client, "message_event_replica", "aggregate_id LIKE $1", [`message:guild-batch-${size}:%`]), size);
      }
    });

    await t.test("constraint, invalid payload, checksum conflict, and partial batch are atomic", async () => {
      const invalid = invalidEvent("invalid-only", 70_000);
      await assert.rejects(adapter.writeBatch([invalid]), (error) => {
        assert.equal(classifySyncError(error).kind, "permanent");
        return String(error.code).startsWith("23");
      });
      assert.equal(await tableCount(client, "message_event_replica", "event_id = $1", [invalid.eventId]), 0);

      const valid = event("create", "partial-valid", 70_001, { guildId: "guild-partial" });
      const partialInvalid = invalidEvent("partial-invalid", 70_002);
      await assert.rejects(adapter.writeBatch([valid, partialInvalid]));
      assert.equal(await tableCount(client, "message_event_replica", "event_id IN ($1, $2)", [valid.eventId, partialInvalid.eventId]), 0);

      const original = event("create", "checksum", 70_010, { guildId: "guild-checksum", eventId: "phase3a:fixed-checksum" });
      const changed = event("create", "checksum", 70_010, {
        guildId: "guild-checksum",
        eventId: "phase3a:fixed-checksum",
        content: "changed-with-same-event-id",
      });
      await adapter.writeBatch([original]);
      await assert.rejects(
        adapter.writeBatch([changed]),
        (error) => String(error.code) === "23505" || error instanceof MessageReplicaConflictError,
      );
      const checksum = await client.query("SELECT checksum FROM message_event_replica WHERE event_id = $1", [original.eventId]);
      assert.equal(checksum.rows[0].checksum, original.checksum);
    });

    await t.test("connection failure, timeout, classification, and recovery behave safely", async () => {
      const unreachable = new Client({
        connectionString: "postgresql://phase3a@127.0.0.1:1/nuviloview_phase3a_test",
        connectionTimeoutMillis: 250,
      });
      let connectionError;
      try {
        await unreachable.connect();
      } catch (error) {
        connectionError = error;
      } finally {
        await unreachable.end().catch(() => {});
      }
      assert.ok(connectionError);
      assert.equal(classifySyncError(connectionError).kind, "transient");
      assert.equal(classifySyncError(connectionError).affectsCircuit, true);

      await client.query("SET statement_timeout = '50ms'");
      let timeoutError;
      try {
        await client.query("SELECT pg_sleep(0.2)");
      } catch (error) {
        timeoutError = error;
      }
      await client.query("RESET statement_timeout");
      assert.equal(timeoutError?.code, "57014");
      assert.equal(classifySyncError(timeoutError).kind, "transient");

      const recovered = event("create", "recovered", 71_000, { guildId: "guild-recovery" });
      await adapter.writeBatch([recovered]);
      assert.equal(await tableCount(client, '"discord_message"', '"id" = \'recovered\''), 1);
    });

    await t.test("Sync Worker opens the Circuit, recovers through HALF_OPEN, and dead-letters permanent failures", async () => {
      const directory = mkdtempSync(join(tmpdir(), "nuviloview-phase3a-pg-worker-"));
      let currentTime = baseTime + 200_000_000;
      const now = () => currentTime;
      const storage = createLocalStorage({
        databasePath: join(directory, "data", "worker.sqlite"),
        now,
      });
      try {
        const retryItem = event("create", "worker-recovery", 80_000, { guildId: "guild-worker" });
        storage.outbox.enqueue(retryItem);
        let connectionAvailable = false;
        let observedProbeState = null;
        let worker;
        worker = new SyncWorker({
          storage,
          replica: {
            async writeBatch(items) {
              if (!connectionAvailable) {
                const error = new Error("isolated PostgreSQL connection unavailable");
                error.code = "ECONNREFUSED";
                throw error;
              }
              observedProbeState = worker.status.circuit.state;
              return adapter.writeBatch(items);
            },
          },
          config: getSyncWorkerConfig({
            SYNC_BATCH_MIN: "1",
            SYNC_BATCH_MAX: "1",
            SYNC_BATCH_GROWTH_STEP: "1",
            SYNC_RETRY_BASE_MS: "100",
            SYNC_RETRY_MAX_MS: "100",
            SYNC_RETRY_JITTER_RATIO: "0",
            SYNC_CIRCUIT_FAILURE_THRESHOLD: "1",
            SYNC_CIRCUIT_OPEN_MS: "1000",
            SYNC_CIRCUIT_HALF_OPEN_BATCH: "1",
            SYNC_METRICS_PATH: join(directory, "metrics.json"),
          }, { cwd: directory }),
          now,
          random: () => 0.5,
          logger: { error() {}, warn() {}, info() {} },
          snapshotWriter: async () => {},
        });

        const failed = await worker.processOnce();
        assert.equal(failed.state, "partial_failure");
        assert.equal(worker.status.circuit.state, "OPEN");
        assert.equal((await worker.processOnce()).state, "circuit_open");

        currentTime += 1_001;
        connectionAvailable = true;
        const recovered = await worker.processOnce();
        assert.equal(recovered.state, "synced");
        assert.equal(observedProbeState, "HALF_OPEN");
        assert.equal(worker.status.circuit.state, "CLOSED");
        assert.equal(storage.outbox.getByEventId(retryItem.eventId).status, "synced");

        const invalid = invalidEvent("worker-dead-letter", 80_001);
        storage.outbox.enqueue(invalid);
        const permanent = await worker.processOnce();
        assert.equal(permanent.state, "partial_failure");
        assert.equal(storage.outbox.getByEventId(invalid.eventId).status, "dead_letter");
        assert.equal(storage.outbox.getDeadLetterCount(), 1);
        assert.equal(worker.status.circuit.state, "CLOSED");
      } finally {
        storage.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    const performanceResult = {};
    await t.test("100 and 1000 event performance uses bounded batch queries and indexed reads", async () => {
      for (const [count, batchSize] of [[100, 25], [1_000, 100]]) {
        const guildId = `guild-performance-${count}`;
        const items = Array.from({ length: count }, (_, index) => event("create", `perf-${count}-${index}`, 100_000 + count * 2_000 + index, {
          guildId,
          authorId: `user-${index % 40}`,
          content: `performance-${count}-${index}`,
        }));
        const sizeBefore = Number((await client.query("SELECT pg_total_relation_size('message_event_replica') AS bytes")).rows[0].bytes);
        const queriesBefore = queryCount;
        const started = performance.now();
        for (let index = 0; index < count; index += batchSize) {
          await adapter.writeBatch(items.slice(index, index + batchSize));
        }
        const elapsedMs = performance.now() - started;
        const queries = queryCount - queriesBefore;
        const sizeAfter = Number((await client.query("SELECT pg_total_relation_size('message_event_replica') AS bytes")).rows[0].bytes);
        const duplicateStarted = performance.now();
        for (let index = 0; index < count; index += batchSize) {
          await adapter.writeBatch(items.slice(index, index + batchSize));
        }
        performanceResult[count] = {
          batchSize,
          queries,
          elapsedMs: Number(elapsedMs.toFixed(2)),
          duplicateMs: Number((performance.now() - duplicateStarted).toFixed(2)),
          sizeIncreaseBytes: sizeAfter - sizeBefore,
        };
        assert.equal(queries, Math.ceil(count / batchSize));
        assert.equal(await tableCount(client, "message_event_replica", "aggregate_id LIKE $1", [`message:${guildId}:%`]), count);
      }

      await client.query("SET enable_seqscan = off");
      const explain = await client.query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT event_id, event_type, payload
        FROM message_event_replica
        WHERE aggregate_id = $1 AND event_type <> 'message_active_member'
        ORDER BY ((payload->>'sourceSequence')::bigint) DESC,
          CASE event_type WHEN 'message_delete' THEN 2 WHEN 'message_update' THEN 1 ELSE 0 END DESC,
          payload->>'revision' DESC
        LIMIT 1
      `, ["message:guild-performance-1000:perf-1000-999"]);
      await client.query("RESET enable_seqscan");
      const planText = JSON.stringify(explain.rows[0]["QUERY PLAN"]);
      assert.match(planText, /Index Scan/);
      performanceResult.explainUsesIndex = true;
      t.diagnostic(`performance=${JSON.stringify(performanceResult)}`);
    });

    await t.test("migration rerun preserves data and rollback removes only replica infrastructure", async () => {
      const before = await tableCount(client, "message_event_replica");
      await client.query(proposalSql);
      await applyConcurrentIndexes(client);
      assert.equal(await tableCount(client, "message_event_replica"), before);
      await client.query(rollbackSql);
      assert.equal((await client.query("SELECT to_regclass('message_event_replica') AS relation")).rows[0].relation, null);
      assert.equal((await client.query("SELECT to_regclass('message_tombstone') AS relation")).rows[0].relation, null);
      assert.notEqual((await client.query("SELECT to_regclass('discord_message') AS relation")).rows[0].relation, null);
      const retainedColumns = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'discord_message' AND column_name = 'sourceEventId'
      `, [schema]);
      assert.equal(retainedColumns.rowCount, 1);
    });

    await t.test("an injected migration failure leaves no partial Phase 3A schema", async () => {
      await client.query(`CREATE SCHEMA "${failureSchema}"`);
      await client.query(`SET search_path TO "${failureSchema}"`);
      await createBaseSchema(client);
      const failingSql = proposalSql.replace(/\nCOMMIT;\s*$/, "\nSELECT 1 / 0;\nCOMMIT;");
      await assert.rejects(client.query(failingSql));
      await client.query("ROLLBACK").catch(() => {});
      const relation = await client.query("SELECT to_regclass('message_event_replica') AS relation");
      assert.equal(relation.rows[0].relation, null);
      assert.notEqual((await client.query("SELECT to_regclass('discord_message') AS relation")).rows[0].relation, null);
      await client.query(`SET search_path TO "${schema}"`);
    });
  },
);
