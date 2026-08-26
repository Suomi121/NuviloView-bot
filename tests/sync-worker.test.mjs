import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStorage } from "../lib/storage/index.mjs";
import { SyncCircuitBreaker } from "../lib/sync/circuit-breaker.mjs";
import {
  createNeonReplicaAdapter,
  ReplicaConflictError,
} from "../lib/sync/neon-replica.mjs";
import {
  calculateRetryDelay,
  classifySyncError,
} from "../lib/sync/retry.mjs";
import { evaluateSyncGuards } from "../lib/sync/guards.mjs";
import { getSyncWorkerConfig, SyncWorker } from "../lib/sync/worker.mjs";
import { inspectSyncQueue } from "../scripts/inspect-sync-queue.mjs";
import { getRepairRequest } from "../scripts/repair-sync-queue.mjs";
import { runSyncWorker } from "../scripts/run-sync-worker.mjs";

function harness(t, initialNow = 1_700_000_000_000) {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-sync-worker-"));
  const databasePath = join(directory, "data", "nuviloview.sqlite");
  let currentTime = initialNow;
  const now = () => currentTime;
  const storage = createLocalStorage({ databasePath, now });
  t.after(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    databasePath,
    storage,
    now,
    advance(milliseconds) {
      currentTime += milliseconds;
    },
  };
}

function event(number, overrides = {}) {
  return {
    eventId: `message:guild:${number}`,
    domain: "bot_event",
    eventType: "message_upsert",
    aggregateId: `message-${number}`,
    payload: { messageId: String(number) },
    schemaVersion: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function workerConfig(directory, overrides = {}) {
  const base = getSyncWorkerConfig(
    {
      SYNC_BATCH_MIN: "2",
      SYNC_BATCH_MAX: "4",
      SYNC_BATCH_GROWTH_STEP: "1",
      SYNC_IDLE_MS: "100",
      SYNC_MAX_ATTEMPTS: "3",
      SYNC_RETRY_BASE_MS: "1000",
      SYNC_RETRY_MAX_MS: "8000",
      SYNC_RETRY_JITTER_RATIO: "0",
      SYNC_CIRCUIT_FAILURE_THRESHOLD: "2",
      SYNC_CIRCUIT_OPEN_MS: "1000",
      SYNC_CIRCUIT_HALF_OPEN_BATCH: "1",
      SYNC_LOCK_TIMEOUT_MS: "1000",
      SYNC_INTEGRITY_INTERVAL_MS: "10000",
      SYNC_CHECKPOINT_INTERVAL_MS: "10000",
      SYNC_METRICS_INTERVAL_MS: "1000",
      SYNC_METRICS_PATH: join(directory, "metrics.json"),
      SYNC_QUEUE_WARN_COUNT: "100",
      SYNC_QUEUE_CRITICAL_COUNT: "200",
      SQLITE_DISK_WARN_BYTES: "1000000000",
      SQLITE_DISK_CRITICAL_BYTES: "2000000000",
      SQLITE_WAL_WARN_BYTES: "1000000000",
      SQLITE_WAL_CRITICAL_BYTES: "2000000000",
      SQLITE_FREE_WARN_BYTES: "1000000",
      SQLITE_FREE_CRITICAL_BYTES: "1000",
      SYNC_OLDEST_PENDING_WARN_MS: "1000000",
      SYNC_OLDEST_PENDING_CRITICAL_MS: "2000000",
    },
    { cwd: directory },
  );
  return {
    ...base,
    ...overrides,
    thresholds: { ...base.thresholds, ...(overrides.thresholds ?? {}) },
  };
}

function worker(h, replica, overrides = {}) {
  return new SyncWorker({
    storage: h.storage,
    replica,
    config: workerConfig(h.directory, overrides.config),
    workerId: overrides.workerId ?? "worker-test",
    now: h.now,
    random: overrides.random ?? (() => 0.5),
    logger: { info() {}, warn() {}, error() {} },
    snapshotWriter: overrides.snapshotWriter ?? (async () => {}),
  });
}

test("Outbox enqueue is stable, idempotent, and collision-safe", (t) => {
  const h = harness(t);
  const first = h.storage.outbox.enqueue(event(1));
  const duplicate = h.storage.outbox.enqueue(event(1));
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(first.id, duplicate.id);
  assert.equal(h.storage.outbox.getPendingCount(), 1);
  assert.throws(
    () => h.storage.outbox.enqueue(event(1, { payload: { changed: true } })),
    (error) => error.code === "SYNC_EVENT_ID_COLLISION",
  );
});

test("Domain Event and Outbox enqueue roll back in one SQLite transaction", (t) => {
  const h = harness(t);
  assert.throws(
    () =>
      h.storage.transaction(() => {
        h.storage.analytics.recordMessageEvent({
          guildId: "guild",
          channelId: "channel",
          messageId: "rollback",
          occurredAt: h.now(),
        });
        h.storage.outbox.enqueue(event(2));
        throw new Error("rollback both writes");
      }),
    /rollback both writes/,
  );
  assert.equal(h.storage.messages.getByIdentity("guild", "rollback"), null);
  assert.equal(h.storage.outbox.getByEventId(event(2).eventId), null);
});

test("claimBatch leases each event to only one worker", (t) => {
  const h = harness(t);
  h.storage.outbox.enqueueMany([event(1), event(2)]);
  const first = h.storage.outbox.claimBatch({
    workerId: "worker-a",
    limit: 2,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  const second = h.storage.outbox.claimBatch({
    workerId: "worker-b",
    limit: 2,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
  assert.ok(first.every((item) => item.lockedBy === "worker-a" && item.attempts === 1));
});

test("expired processing locks are recovered after a worker crash", (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1));
  h.storage.outbox.claimBatch({
    workerId: "crashed-worker",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  h.advance(1_001);
  assert.equal(
    h.storage.outbox.releaseExpiredLocks({ lockTimeoutMs: 1_000, at: h.now() }),
    1,
  );
  const recovered = h.storage.outbox.claimBatch({
    workerId: "recovery-worker",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  assert.equal(recovered[0].attempts, 2);
  assert.equal(recovered[0].lockedBy, "recovery-worker");
});

test("retry delay is exponential, bounded, and jitter remains in range", () => {
  assert.equal(
    calculateRetryDelay({ attempt: 1, baseMs: 1_000, maxMs: 8_000, jitterRatio: 0 }),
    1_000,
  );
  assert.equal(
    calculateRetryDelay({ attempt: 4, baseMs: 1_000, maxMs: 8_000, jitterRatio: 0 }),
    8_000,
  );
  assert.equal(
    calculateRetryDelay({
      attempt: 2,
      baseMs: 1_000,
      maxMs: 8_000,
      jitterRatio: 0.2,
      random: () => 0,
    }),
    1_600,
  );
  assert.equal(
    calculateRetryDelay({
      attempt: 2,
      baseMs: 1_000,
      maxMs: 8_000,
      jitterRatio: 0.2,
      random: () => 1,
    }),
    2_400,
  );
  assert.equal(classifySyncError({ status: 429 }).retryable, true);
  assert.equal(classifySyncError({ code: "23514" }).retryable, false);
});

test("Dead Letter retains payload and supports explicit Event ID requeue", (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1));
  const [claimed] = h.storage.outbox.claimBatch({
    workerId: "worker-a",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  const dead = h.storage.outbox.moveToDeadLetter(claimed.id, {
    workerId: "worker-a",
    error: Object.assign(new Error("invalid payload"), { code: "SYNC_INVALID_PAYLOAD" }),
    at: h.now(),
  });
  assert.equal(dead.eventId, event(1).eventId);
  assert.deepEqual(dead.payload, event(1).payload);
  assert.equal(h.storage.outbox.getDeadLetterCount(), 1);
  const requeued = h.storage.outbox.requeueDeadLetter(dead.eventId, { at: h.now() });
  assert.equal(requeued.status, "pending");
  assert.equal(h.storage.outbox.getDeadLetter(dead.eventId).requeueCount, 1);
});

test("Circuit transitions CLOSED to OPEN to HALF_OPEN to CLOSED", (t) => {
  const h = harness(t);
  const circuit = new SyncCircuitBreaker({
    metadataRepository: h.storage.syncMetadata,
    failureThreshold: 2,
    openMs: 1_000,
    halfOpenBatch: 1,
    now: h.now,
  });
  circuit.recordFailure({ kind: "transient", affectsCircuit: true }, h.now());
  assert.equal(circuit.getSnapshot().state, "CLOSED");
  circuit.recordFailure({ kind: "transient", affectsCircuit: true }, h.now());
  assert.equal(circuit.getSnapshot().state, "OPEN");
  assert.equal(circuit.canAttempt(h.now()), false);
  h.advance(1_001);
  assert.equal(circuit.canAttempt(h.now()), true);
  assert.equal(circuit.getSnapshot().state, "HALF_OPEN");
  circuit.recordSuccess(h.now());
  assert.equal(circuit.getSnapshot().state, "CLOSED");
});

test("HALF_OPEN failure immediately returns the Circuit to OPEN", (t) => {
  const h = harness(t);
  const circuit = new SyncCircuitBreaker({
    metadataRepository: h.storage.syncMetadata,
    failureThreshold: 1,
    openMs: 1_000,
    now: h.now,
  });
  circuit.recordFailure({ kind: "transient", affectsCircuit: true }, h.now());
  h.advance(1_001);
  circuit.canAttempt(h.now());
  circuit.recordFailure({ kind: "transient", affectsCircuit: true }, h.now());
  assert.equal(circuit.getSnapshot().state, "OPEN");
  assert.ok(circuit.getSnapshot().openUntil > h.now());
});

test("Neon adapter sends one idempotent batch query and verifies checksums", async (t) => {
  const h = harness(t);
  const stored = new Map();
  let calls = 0;
  const adapter = createNeonReplicaAdapter({
    execute: async (_sql, [json]) => {
      calls += 1;
      for (const record of JSON.parse(json)) {
        if (!stored.has(record.event_id)) stored.set(record.event_id, record.checksum);
      }
      return {
        rows: JSON.parse(json).map((record) => ({
          event_id: record.event_id,
          checksum: stored.get(record.event_id),
        })),
      };
    },
  });
  const queued = h.storage.outbox.enqueueMany([event(1), event(2)]);
  await adapter.writeBatch(queued);
  await adapter.writeBatch(queued);
  assert.equal(calls, 2);
  assert.equal(stored.size, 2);
});

test("Neon adapter rejects an existing replica checksum conflict", async (t) => {
  const h = harness(t);
  const [queued] = h.storage.outbox.enqueueMany([event(1)]);
  const adapter = createNeonReplicaAdapter({
    execute: async () => ({
      rows: [{ event_id: queued.eventId, checksum: "f".repeat(64) }],
    }),
  });
  await assert.rejects(
    adapter.writeBatch([queued]),
    (error) => error instanceof ReplicaConflictError,
  );
});

test("empty queue performs no Neon query", async (t) => {
  const h = harness(t);
  let calls = 0;
  const syncWorker = worker(h, {
    async writeBatch() {
      calls += 1;
      return { succeededEventIds: [], failed: [] };
    },
  });
  const result = await syncWorker.processOnce();
  assert.equal(result.state, "idle");
  assert.equal(calls, 0);
});

test("worker batches successful events and grows the next batch gradually", async (t) => {
  const h = harness(t);
  h.storage.outbox.enqueueMany([event(1), event(2), event(3)]);
  const sizes = [];
  const snapshots = [];
  const syncWorker = worker(
    h,
    {
      async writeBatch(items) {
        sizes.push(items.length);
        return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
      },
    },
    { snapshotWriter: async (_path, snapshot) => snapshots.push(snapshot) },
  );
  assert.equal((await syncWorker.processOnce()).synced, 2);
  assert.equal((await syncWorker.processOnce()).synced, 1);
  assert.deepEqual(sizes, [2, 1]);
  assert.equal(h.storage.outbox.getStatusCounts().synced, 3);
  assert.equal(syncWorker.status.currentBatchSize, 4);
  assert.equal(snapshots.at(-1).neonStatus, "AVAILABLE");
  assert.equal(h.storage.syncMetadata.get("sync_worker_metrics").lastSuccessAt, h.now());
});

test("partial batch failure syncs successes and preserves permanent failure in DLQ", async (t) => {
  const h = harness(t);
  h.storage.outbox.enqueueMany([event(1), event(2)]);
  const syncWorker = worker(h, {
    async writeBatch(items) {
      return {
        succeededEventIds: [items[0].eventId],
        failed: [
          {
            eventId: items[1].eventId,
            error: Object.assign(new Error("invalid payload"), {
              code: "SYNC_INVALID_PAYLOAD",
            }),
          },
        ],
      };
    },
  });
  const result = await syncWorker.processOnce();
  assert.equal(result.state, "partial_failure");
  assert.deepEqual(h.storage.outbox.getStatusCounts(), {
    pending: 0,
    processing: 0,
    retry: 0,
    synced: 1,
    dead_letter: 1,
  });
  assert.equal(h.storage.outbox.getDeadLetterCount(), 1);
});

test("maximum attempts moves a transient failure to Dead Letter", async (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1));
  const syncWorker = worker(
    h,
    {
      async writeBatch() {
        throw Object.assign(new Error("connection timeout"), { code: "ETIMEDOUT" });
      },
    },
    { config: { maxAttempts: 1 } },
  );
  await syncWorker.processOnce();
  assert.equal(h.storage.outbox.getDeadLetterCount(), 1);
  assert.equal(h.storage.outbox.getByEventId(event(1).eventId).status, "dead_letter");
});

test("OPEN Circuit blocks Neon calls and HALF_OPEN recovery uses a small batch", async (t) => {
  const h = harness(t);
  h.storage.outbox.enqueueMany([event(1), event(2)]);
  const batchSizes = [];
  let fail = true;
  const syncWorker = worker(
    h,
    {
      async writeBatch(items) {
        batchSizes.push(items.length);
        if (fail) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
        return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
      },
    },
    { config: { circuitFailureThreshold: 1 } },
  );
  await syncWorker.processOnce();
  assert.equal(syncWorker.status.circuit.state, "OPEN");
  await syncWorker.processOnce();
  assert.deepEqual(batchSizes, [2]);
  h.advance(1_001);
  fail = false;
  const recovered = await syncWorker.processOnce();
  assert.equal(recovered.synced, 1);
  assert.deepEqual(batchSizes, [2, 1]);
  assert.equal(syncWorker.status.circuit.state, "CLOSED");
});

test("a restarted worker automatically reclaims an expired batch", async (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1));
  h.storage.outbox.claimBatch({
    workerId: "dead-process",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: h.now(),
  });
  h.advance(1_001);
  const syncWorker = worker(h, {
    async writeBatch(items) {
      return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
    },
  });
  assert.equal((await syncWorker.processOnce()).synced, 1);
  assert.equal(h.storage.outbox.getStatusCounts().synced, 1);
});

test("graceful shutdown waits for the active batch and releases no orphan lock", async (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1));
  let beginBatch;
  let finishBatch;
  const batchStarted = new Promise((resolve) => {
    beginBatch = resolve;
  });
  const batchMayFinish = new Promise((resolve) => {
    finishBatch = resolve;
  });
  const syncWorker = worker(h, {
    async writeBatch(items) {
      beginBatch();
      await batchMayFinish;
      return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
    },
  });
  const runPromise = syncWorker.run();
  await batchStarted;
  let stopped = false;
  const stopPromise = syncWorker.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishBatch();
  await stopPromise;
  await runPromise;
  assert.equal(h.storage.outbox.getProcessingCount(), 0);
  assert.equal(h.storage.outbox.getStatusCounts().synced, 1);
  assert.equal(syncWorker.status.running, false);
});

test("queue, SQLite, WAL, age, and Dead Letter guards report CRITICAL without deletion", (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1, { createdAt: h.now() - 10_000 }));
  const before = h.storage.outbox.getQueueSize().count;
  const result = evaluateSyncGuards({
    outbox: h.storage.outbox,
    storage: h.storage,
    integrity: h.storage.health.checkIntegrity({ quick: true }),
    thresholds: {
      queueWarnCount: 1,
      queueCriticalCount: 1,
      sqliteWarnBytes: Number.MAX_SAFE_INTEGER,
      sqliteCriticalBytes: Number.MAX_SAFE_INTEGER,
      walWarnBytes: Number.MAX_SAFE_INTEGER,
      walCriticalBytes: Number.MAX_SAFE_INTEGER,
      diskFreeWarnBytes: 1,
      diskFreeCriticalBytes: 1,
      oldestPendingWarnMs: 1,
      oldestPendingCriticalMs: 5_000,
    },
    at: h.now(),
  });
  assert.equal(result.status, "CRITICAL");
  assert.ok(result.critical.includes("queue_count_critical"));
  assert.ok(result.critical.includes("oldest_pending_critical"));
  assert.ok(result.sqliteSizeBytes > 0);
  assert.ok(result.walSizeBytes >= 0);
  assert.equal(h.storage.outbox.getQueueSize().count, before);
});

test("cloud-primary and unknown domains are rejected before enqueue", (t) => {
  const h = harness(t);
  assert.throws(
    () => h.storage.outbox.enqueue(event(1, { domain: "oauth" })),
    (error) => error.code === "UNSUPPORTED_SYNC_DOMAIN",
  );
  assert.throws(
    () => h.storage.outbox.enqueue(event(2, { domain: "unknown" })),
    (error) => error.code === "UNSUPPORTED_SYNC_DOMAIN",
  );
  assert.equal(h.storage.outbox.getQueueSize().count, 0);
});

test("inspection is read-only and repair mutations require one explicit action", (t) => {
  const h = harness(t);
  h.storage.outbox.enqueue(event(1));
  const snapshot = inspectSyncQueue({
    env: { LOCAL_STORAGE_PATH: h.databasePath },
    cwd: h.directory,
  });
  assert.equal(snapshot.pending, 1);
  assert.throws(() => getRepairRequest(["--release-stale"]), /--execute/);
  assert.throws(
    () => getRepairRequest(["--release-stale", "--requeue", event(1).eventId, "--execute"]),
    /exactly one/,
  );
  assert.deepEqual(getRepairRequest(["--requeue", event(1).eventId, "--execute"]), {
    execute: true,
    releaseStale: false,
    requeueEventId: event(1).eventId,
    inspectEventId: null,
  });
});

test("Worker flag defaults OFF without opening SQLite or Neon", async () => {
  let logs = 0;
  const result = await runSyncWorker({
    env: {},
    logger: { info() { logs += 1; }, warn() {}, error() {} },
  });
  assert.deepEqual(result, { started: false, reason: "disabled" });
  assert.equal(logs, 1);
});
