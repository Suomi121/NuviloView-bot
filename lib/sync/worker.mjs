import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AdaptiveBatcher } from "./batcher.mjs";
import { SyncCircuitBreaker } from "./circuit-breaker.mjs";
import { evaluateSyncGuards } from "./guards.mjs";
import { SyncMetrics, writeSyncMetricsSnapshot } from "./metrics.mjs";
import {
  calculateRetryDelay,
  classifySyncError,
  sanitizeSyncError,
} from "./retry.mjs";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function ratio(env, name, fallback) {
  const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between 0 and 1.`);
  }
  return value;
}

export function getSyncWorkerConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const batchMin = integer(env, "SYNC_BATCH_MIN", 25, { min: 1, max: 1_000 });
  const batchMax = integer(env, "SYNC_BATCH_MAX", 100, {
    min: batchMin,
    max: 1_000,
  });
  const retryBaseMs = integer(env, "SYNC_RETRY_BASE_MS", 1_000, {
    min: 100,
    max: 300_000,
  });
  const retryMaxMs = integer(env, "SYNC_RETRY_MAX_MS", 300_000, {
    min: retryBaseMs,
    max: 86_400_000,
  });
  const config = {
    enabled: enabled(env.SYNC_WORKER_ENABLED),
    replicaEnabled: enabled(env.SYNC_NEON_REPLICA_ENABLED),
    batchMin,
    batchMax,
    batchGrowthStep: integer(env, "SYNC_BATCH_GROWTH_STEP", 10, {
      min: 1,
      max: batchMax,
    }),
    idleMs: integer(env, "SYNC_IDLE_MS", 5_000, { min: 100, max: 300_000 }),
    maxAttempts: integer(env, "SYNC_MAX_ATTEMPTS", 8, { min: 1, max: 100 }),
    retryBaseMs,
    retryMaxMs,
    retryJitterRatio: ratio(env, "SYNC_RETRY_JITTER_RATIO", 0.2),
    circuitFailureThreshold: integer(env, "SYNC_CIRCUIT_FAILURE_THRESHOLD", 5, {
      min: 1,
      max: 100,
    }),
    circuitOpenMs: integer(env, "SYNC_CIRCUIT_OPEN_MS", 60_000, {
      min: 1_000,
      max: 86_400_000,
    }),
    circuitHalfOpenBatch: integer(env, "SYNC_CIRCUIT_HALF_OPEN_BATCH", 5, {
      min: 1,
      max: batchMax,
    }),
    lockTimeoutMs: integer(env, "SYNC_LOCK_TIMEOUT_MS", 300_000, {
      min: 1_000,
      max: 86_400_000,
    }),
    integrityIntervalMs: integer(env, "SYNC_INTEGRITY_INTERVAL_MS", 300_000, {
      min: 10_000,
      max: 86_400_000,
    }),
    checkpointIntervalMs: integer(env, "SYNC_CHECKPOINT_INTERVAL_MS", 60_000, {
      min: 10_000,
      max: 86_400_000,
    }),
    metricsIntervalMs: integer(env, "SYNC_METRICS_INTERVAL_MS", 30_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    queryTimeoutMs: integer(env, "SYNC_QUERY_TIMEOUT_MS", 15_000, {
      min: 1_000,
      max: 300_000,
    }),
    metricsPath: resolve(
      cwd,
      env.SYNC_METRICS_PATH?.trim() || "data/runtime/sync-worker-health.json",
    ),
    thresholds: Object.freeze({
      queueWarnCount: integer(env, "SYNC_QUEUE_WARN_COUNT", 50_000, { min: 1 }),
      queueCriticalCount: integer(env, "SYNC_QUEUE_CRITICAL_COUNT", 200_000, {
        min: 1,
      }),
      sqliteWarnBytes: integer(env, "SQLITE_DISK_WARN_BYTES", 5_000_000_000, {
        min: 1,
      }),
      sqliteCriticalBytes: integer(
        env,
        "SQLITE_DISK_CRITICAL_BYTES",
        10_000_000_000,
        { min: 1 },
      ),
      walWarnBytes: integer(env, "SQLITE_WAL_WARN_BYTES", 536_870_912, { min: 1 }),
      walCriticalBytes: integer(env, "SQLITE_WAL_CRITICAL_BYTES", 1_073_741_824, {
        min: 1,
      }),
      diskFreeWarnBytes: integer(env, "SQLITE_FREE_WARN_BYTES", 2_147_483_648, {
        min: 1,
      }),
      diskFreeCriticalBytes: integer(
        env,
        "SQLITE_FREE_CRITICAL_BYTES",
        536_870_912,
        { min: 1 },
      ),
      oldestPendingWarnMs: integer(env, "SYNC_OLDEST_PENDING_WARN_MS", 3_600_000, {
        min: 1,
      }),
      oldestPendingCriticalMs: integer(
        env,
        "SYNC_OLDEST_PENDING_CRITICAL_MS",
        86_400_000,
        { min: 1 },
      ),
    }),
  };
  validateThresholds(config.thresholds);
  return Object.freeze(config);
}

function validateThresholds(thresholds) {
  if (thresholds.queueCriticalCount < thresholds.queueWarnCount) {
    throw new TypeError("SYNC_QUEUE_CRITICAL_COUNT must be at least SYNC_QUEUE_WARN_COUNT.");
  }
  if (thresholds.sqliteCriticalBytes < thresholds.sqliteWarnBytes) {
    throw new TypeError("SQLITE_DISK_CRITICAL_BYTES must be at least SQLITE_DISK_WARN_BYTES.");
  }
  if (thresholds.walCriticalBytes < thresholds.walWarnBytes) {
    throw new TypeError("SQLITE_WAL_CRITICAL_BYTES must be at least SQLITE_WAL_WARN_BYTES.");
  }
  if (thresholds.diskFreeCriticalBytes > thresholds.diskFreeWarnBytes) {
    throw new TypeError("SQLITE_FREE_CRITICAL_BYTES must not exceed SQLITE_FREE_WARN_BYTES.");
  }
  if (thresholds.oldestPendingCriticalMs < thresholds.oldestPendingWarnMs) {
    throw new TypeError("Oldest pending critical age must be at least the warning age.");
  }
}

export class SyncWorker {
  #stopping = false;
  #running = false;
  #inFlight = null;
  #sleepTimer = null;
  #wakeSleep = null;
  #lastIntegrityAt = null;
  #lastCheckpointAt = null;
  #integrity = null;
  #lastMetricsAt = null;

  constructor({
    storage,
    replica,
    config,
    workerId = `sync-${process.pid}-${randomUUID()}`,
    now = () => Date.now(),
    random = Math.random,
    logger = console,
    snapshotWriter = writeSyncMetricsSnapshot,
  }) {
    if (!storage?.outbox || !storage?.health || !storage?.syncMetadata) {
      throw new TypeError("A writable Phase 1 storage instance is required.");
    }
    if (typeof replica?.writeBatch !== "function") {
      throw new TypeError("A replica adapter with writeBatch() is required.");
    }
    validateThresholds(config.thresholds);
    this.storage = storage;
    this.outbox = storage.outbox;
    this.replica = replica;
    this.config = config;
    this.workerId = workerId;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.snapshotWriter = snapshotWriter;
    this.metrics = new SyncMetrics({ now });
    this.batcher = new AdaptiveBatcher({
      minSize: config.batchMin,
      maxSize: config.batchMax,
      growthStep: config.batchGrowthStep,
    });
    this.circuit = new SyncCircuitBreaker({
      metadataRepository: storage.syncMetadata,
      failureThreshold: config.circuitFailureThreshold,
      openMs: config.circuitOpenMs,
      halfOpenBatch: config.circuitHalfOpenBatch,
      now,
    });
  }

  async #writeSnapshot(guards, { force = false } = {}) {
    const snapshot = this.metrics.snapshot({
      circuit: this.circuit,
      guards,
      configuredBatchSize: this.batcher.currentSize,
    });
    const at = this.now();
    if (
      !force &&
      this.#lastMetricsAt !== null &&
      at - this.#lastMetricsAt < this.config.metricsIntervalMs
    ) {
      return snapshot;
    }
    this.storage.syncMetadata.set({
      streamName: "sync_worker_metrics",
      state: snapshot.workerStatus.toLowerCase(),
      lastAttemptAt: snapshot.lastSyncAttempt,
      lastSuccessAt: snapshot.lastSyncSuccess,
      metadata: snapshot,
    });
    await this.snapshotWriter(this.config.metricsPath, snapshot);
    this.#lastMetricsAt = at;
    return snapshot;
  }

  #refreshMaintenance(at) {
    if (
      this.#lastIntegrityAt === null ||
      at - this.#lastIntegrityAt >= this.config.integrityIntervalMs
    ) {
      this.#integrity = this.storage.health.checkIntegrity({ quick: true });
      this.#lastIntegrityAt = at;
    }
    if (
      this.#lastCheckpointAt === null ||
      at - this.#lastCheckpointAt >= this.config.checkpointIntervalMs
    ) {
      this.storage.health.checkpoint("PASSIVE");
      this.#lastCheckpointAt = at;
    }
  }

  #guards(at) {
    return evaluateSyncGuards({
      outbox: this.outbox,
      storage: this.storage,
      integrity: this.#integrity,
      thresholds: this.config.thresholds,
      at,
    });
  }

  async #handleFailure(item, error, classification, at) {
    if (!classification.retryable || item.attempts >= this.config.maxAttempts) {
      this.outbox.moveToDeadLetter(item.id, {
        workerId: this.workerId,
        error,
        at,
      });
      return "dead_letter";
    }
    const delay = calculateRetryDelay({
      attempt: item.attempts,
      baseMs: this.config.retryBaseMs,
      maxMs: this.config.retryMaxMs,
      jitterRatio: this.config.retryJitterRatio,
      random: this.random,
    });
    this.outbox.markRetry(item.id, {
      workerId: this.workerId,
      error,
      availableAt: at + delay,
      at,
    });
    return "retry";
  }

  async #processBatch(batch) {
    this.metrics.beginAttempt(batch.length);
    let response;
    try {
      response = await this.replica.writeBatch(batch);
    } catch (error) {
      const classification = classifySyncError(error);
      for (const item of batch) {
        await this.#handleFailure(item, error, classification, this.now());
      }
      this.metrics.failure(batch.length, error);
      this.batcher.recordFailure();
      this.circuit.recordFailure(classification, this.now());
      return { synced: 0, failed: batch.length };
    }

    const succeeded = new Set(response?.succeededEventIds ?? []);
    const failedByEvent = new Map(
      (response?.failed ?? []).map((failure) => [failure.eventId, failure]),
    );
    const succeededIds = [];
    let failedCount = 0;
    let circuitFailure = null;
    for (const item of batch) {
      if (succeeded.has(item.eventId)) {
        succeededIds.push(item.id);
        continue;
      }
      const failure = failedByEvent.get(item.eventId) ?? {
        error: Object.assign(new Error("Replica omitted a batch result."), {
          code: "SYNC_SCHEMA_MISMATCH",
        }),
      };
      const classification = failure.classification ?? classifySyncError(failure.error);
      await this.#handleFailure(item, failure.error, classification, this.now());
      failedCount += 1;
      if (classification.affectsCircuit) circuitFailure = classification;
    }
    if (succeededIds.length > 0) {
      this.outbox.markSynced(succeededIds, {
        workerId: this.workerId,
        at: this.now(),
      });
      this.metrics.success(succeededIds.length);
    }
    if (failedCount > 0) {
      this.metrics.failure(failedCount, "One or more batch events failed.");
      this.batcher.recordFailure();
      if (circuitFailure) this.circuit.recordFailure(circuitFailure, this.now());
      else this.circuit.recordSuccess(this.now());
    } else {
      this.batcher.recordSuccess();
      this.circuit.recordSuccess(this.now());
    }
    return { synced: succeededIds.length, failed: failedCount };
  }

  async processOnce() {
    if (this.#stopping) return { state: "stopping", synced: 0, failed: 0 };
    const at = this.now();
    this.#refreshMaintenance(at);
    let guards = this.#guards(at);
    if (guards.integrity && !guards.integrity.ok) {
      await this.#writeSnapshot(guards, { force: true });
      return { state: "integrity_failed", synced: 0, failed: 0 };
    }
    if (guards.pendingCount === 0) {
      await this.#writeSnapshot(guards);
      return { state: "idle", synced: 0, failed: 0 };
    }
    if (!this.circuit.canAttempt(at)) {
      guards = this.#guards(at);
      await this.#writeSnapshot(guards);
      return { state: "circuit_open", synced: 0, failed: 0 };
    }

    const circuitState = this.circuit.getSnapshot().state;
    const limit = this.batcher.sizeFor({
      circuitState,
      halfOpenBatch: this.config.circuitHalfOpenBatch,
    });
    const batch = this.outbox.claimBatch({
      workerId: this.workerId,
      limit,
      lockTimeoutMs: this.config.lockTimeoutMs,
      at,
    });
    if (batch.length === 0) {
      this.circuit.cancelAttempt();
      guards = this.#guards(this.now());
      await this.#writeSnapshot(guards);
      return { state: "idle", synced: 0, failed: 0 };
    }

    this.#inFlight = this.#processBatch(batch);
    try {
      const result = await this.#inFlight;
      guards = this.#guards(this.now());
      await this.#writeSnapshot(guards, { force: true });
      return { state: result.failed > 0 ? "partial_failure" : "synced", ...result };
    } finally {
      this.#inFlight = null;
    }
  }

  async #sleep(milliseconds) {
    if (this.#stopping) return;
    await new Promise((resolveSleep) => {
      this.#wakeSleep = resolveSleep;
      this.#sleepTimer = setTimeout(resolveSleep, milliseconds);
    });
    this.#wakeSleep = null;
    this.#sleepTimer = null;
  }

  async run() {
    if (this.#running) throw new Error("Sync Worker is already running.");
    this.#running = true;
    this.#stopping = false;
    this.metrics.start();
    this.outbox.releaseExpiredLocks({
      lockTimeoutMs: this.config.lockTimeoutMs,
      at: this.now(),
    });
    try {
      while (!this.#stopping) {
        try {
          await this.processOnce();
        } catch (error) {
          this.logger.error?.(`[sync-worker] ${sanitizeSyncError(error)}`);
          this.metrics.failure(0, error);
        }
        await this.#sleep(this.config.idleMs);
      }
    } finally {
      if (this.#inFlight) await this.#inFlight;
      this.outbox.releaseWorkerLocks(this.workerId, { at: this.now() });
      this.metrics.stop();
      await this.#writeSnapshot(this.#guards(this.now()), { force: true });
      this.#running = false;
    }
  }

  async stop() {
    this.#stopping = true;
    this.metrics.stopping();
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#wakeSleep?.();
    if (this.#inFlight) await this.#inFlight;
  }

  get status() {
    return {
      running: this.#running,
      stopping: this.#stopping,
      workerId: this.workerId,
      circuit: this.circuit.getSnapshot(),
      currentBatchSize: this.batcher.currentSize,
    };
  }
}
