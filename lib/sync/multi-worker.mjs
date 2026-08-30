import { AdaptiveBatcher } from "./batcher.mjs";
import { SyncCircuitBreaker } from "./circuit-breaker.mjs";
import { writeSyncMetricsSnapshot } from "./metrics.mjs";
import {
  calculateRetryDelay,
  classifySyncError,
  sanitizeSyncError,
} from "./retry.mjs";
import { createSnapshotService } from "./snapshots.mjs";
import { createAnalyticsCompactionService } from "./analytics-compaction.mjs";

function snapshotKey(item) {
  return `${item.snapshotType}:${item.aggregateId}`;
}

export class MultiProviderSyncWorker {
  #running = false;
  #stopping = false;
  #sleepTimer = null;
  #wakeSleep = null;
  #inFlight = null;
  #lastMetricsAt = null;
  #lastSnapshotAt = null;
  #lastIntegrityAt = null;
  #lastCheckpointAt = null;
  #lastRetentionAt = null;
  #startedAt = null;

  constructor({
    storage,
    registry,
    config,
    now = () => Date.now(),
    random = Math.random,
    logger = console,
    snapshotWriter = writeSyncMetricsSnapshot,
  }) {
    if (!storage?.providerDeliveries || !storage?.snapshots || !storage?.outbox) {
      throw new TypeError("Multi-DB capable local storage is required.");
    }
    if (!registry?.list || !config?.enabled) {
      throw new TypeError("Enabled Multi-DB config and Provider Registry are required.");
    }
    this.storage = storage;
    this.registry = registry;
    this.config = config;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.snapshotWriter = snapshotWriter;
    this.snapshotService = createSnapshotService(storage, { now });
    this.analyticsCompaction = createAnalyticsCompactionService(storage, {
      config: config.analyticsCompaction,
      now,
      logger,
    });
    this.contexts = new Map(
      registry.list().map((provider) => {
        const workerId = storage.providerDeliveries.createWorkerId(provider.id);
        return [
          provider.id,
          {
            provider,
            workerId,
            batcher: new AdaptiveBatcher({
              minSize: config.batchMin,
              maxSize: config.batchMax,
              growthStep: config.batchGrowthStep,
            }),
            circuit: new SyncCircuitBreaker({
              metadataRepository: storage.syncMetadata,
              failureThreshold: config.circuitFailureThreshold,
              openMs: config.circuitOpenMs,
              halfOpenBatch: config.circuitHalfOpenBatch,
              streamName: `provider_circuit:${provider.id}`,
              now,
            }),
          },
        ];
      }),
    );
  }

  #retryDelay(attempt) {
    return calculateRetryDelay({
      attempt,
      baseMs: this.config.retryBaseMs,
      maxMs: this.config.retryMaxMs,
      jitterRatio: this.config.retryJitterRatio,
      random: this.random,
    });
  }

  #handleEventFailure(context, item, error, classification, at) {
    if (!classification.retryable || item.delivery.attempts >= this.config.maxAttempts) {
      this.storage.providerDeliveries.markDeadLetter(
        context.provider.id,
        item.eventId,
        { workerId: context.workerId, error, at },
      );
      return "dead_letter";
    }
    this.storage.providerDeliveries.markRetry(
      context.provider.id,
      item.eventId,
      {
        workerId: context.workerId,
        error,
        availableAt: at + this.#retryDelay(item.delivery.attempts),
        at,
      },
    );
    return "retry";
  }

  #handleSnapshotFailure(context, item, error, classification, at) {
    if (!classification.retryable || item.delivery.attempts >= this.config.maxAttempts) {
      this.storage.snapshots.markDeadLetter(context.provider.id, item, {
        workerId: context.workerId,
        error,
        at,
      });
      return "dead_letter";
    }
    this.storage.snapshots.markRetry(context.provider.id, item, {
      workerId: context.workerId,
      error,
      availableAt: at + this.#retryDelay(item.delivery.attempts),
      at,
    });
    return "retry";
  }

  async #pushEvents(context, batch) {
    const providerId = context.provider.id;
    let response;
    try {
      response = await context.provider.pushEvents(batch);
      this.storage.providerDeliveries.recordAttempt(providerId, {
        at: this.now(),
        queryCount: Number(response?.queryCount ?? 1),
      });
    } catch (error) {
      const at = this.now();
      const classification = classifySyncError(error);
      this.storage.providerDeliveries.recordAttempt(providerId, {
        at,
        queryCount: error?.queryAttempted === false ? 0 : 1,
      });
      for (const item of batch) {
        this.#handleEventFailure(context, item, error, classification, at);
      }
      this.storage.providerDeliveries.recordResult(providerId, {
        failed: batch.length,
        error,
        healthStatus: classification.affectsCircuit ? "OFFLINE" : "DEGRADED",
        at,
      });
      context.batcher.recordFailure();
      context.circuit.recordFailure(classification, at);
      this.storage.providerDeliveries.setCircuitState(
        providerId,
        context.circuit.getSnapshot().state,
        { at },
      );
      return { synced: 0, failed: batch.length };
    }

    const succeeded = new Set(response?.succeededEventIds ?? []);
    const failedByEvent = new Map(
      (response?.failed ?? []).map((failure) => [failure.eventId, failure]),
    );
    const successfulItems = [];
    let failed = 0;
    let circuitFailure = null;
    for (const item of batch) {
      if (succeeded.has(item.eventId)) {
        successfulItems.push({ eventId: item.eventId, checksum: item.checksum });
        continue;
      }
      const failure = failedByEvent.get(item.eventId) ?? {
        error: Object.assign(new Error("Provider omitted a batch result."), {
          code: "SYNC_SCHEMA_MISMATCH",
        }),
      };
      const classification = failure.classification ?? classifySyncError(failure.error);
      this.#handleEventFailure(
        context,
        item,
        failure.error,
        classification,
        this.now(),
      );
      if (classification.affectsCircuit) circuitFailure = classification;
      failed += 1;
    }
    if (successfulItems.length > 0) {
      this.storage.providerDeliveries.markSynced(providerId, successfulItems, {
        workerId: context.workerId,
        at: this.now(),
      });
    }
    this.storage.providerDeliveries.recordResult(providerId, {
      synced: successfulItems.length,
      failed,
      error: failed ? "One or more provider event writes failed." : null,
      healthStatus: failed ? "DEGRADED" : "HEALTHY",
      at: this.now(),
    });
    if (failed > 0) {
      context.batcher.recordFailure();
      if (circuitFailure) context.circuit.recordFailure(circuitFailure, this.now());
      else context.circuit.recordSuccess(this.now());
    } else {
      context.batcher.recordSuccess();
      context.circuit.recordSuccess(this.now());
    }
    this.storage.providerDeliveries.setCircuitState(
      providerId,
      context.circuit.getSnapshot().state,
      { at: this.now() },
    );
    return { synced: successfulItems.length, failed };
  }

  async #pushSnapshots(context, batch) {
    const providerId = context.provider.id;
    try {
      const response = await context.provider.pushSnapshots(batch);
      this.storage.providerDeliveries.recordAttempt(providerId, {
        at: this.now(),
        queryCount: Number(response?.queryCount ?? 1),
      });
      const succeeded = new Set(response?.succeededSnapshotKeys ?? []);
      const successfulItems = batch.filter((item) => succeeded.has(snapshotKey(item)));
      const failedItems = batch.filter((item) => !succeeded.has(snapshotKey(item)));
      if (successfulItems.length > 0) {
        this.storage.snapshots.markSynced(providerId, successfulItems, {
          workerId: context.workerId,
          at: this.now(),
        });
        const projectionWrites = successfulItems.filter(
          (item) =>
            item.snapshotType === "analytics" &&
            String(item.aggregateId).startsWith("v2:guild:"),
        ).length;
        this.storage.analyticsProjections.recordProviderWrites(
          providerId,
          projectionWrites,
          { at: this.now() },
        );
      }
      for (const item of failedItems) {
        const error = Object.assign(new Error("Provider omitted a snapshot result."), {
          code: "SYNC_SCHEMA_MISMATCH",
        });
        this.#handleSnapshotFailure(
          context,
          item,
          error,
          classifySyncError(error),
          this.now(),
        );
      }
      this.storage.providerDeliveries.recordResult(providerId, {
        synced: successfulItems.length,
        failed: failedItems.length,
        error: failedItems.length ? "One or more snapshots failed." : null,
        healthStatus: failedItems.length ? "DEGRADED" : "HEALTHY",
        at: this.now(),
      });
      if (failedItems.length === 0) context.circuit.recordSuccess(this.now());
      else context.circuit.cancelAttempt();
      this.storage.providerDeliveries.setCircuitState(
        providerId,
        context.circuit.getSnapshot().state,
        { at: this.now() },
      );
      return { synced: successfulItems.length, failed: failedItems.length };
    } catch (error) {
      const at = this.now();
      const classification = classifySyncError(error);
      this.storage.providerDeliveries.recordAttempt(providerId, {
        at,
        queryCount: error?.queryAttempted === false ? 0 : 1,
      });
      for (const item of batch) {
        this.#handleSnapshotFailure(context, item, error, classification, at);
      }
      this.storage.providerDeliveries.recordResult(providerId, {
        failed: batch.length,
        error,
        healthStatus: classification.affectsCircuit ? "OFFLINE" : "DEGRADED",
        at,
      });
      context.circuit.recordFailure(classification, at);
      this.storage.providerDeliveries.setCircuitState(
        providerId,
        context.circuit.getSnapshot().state,
        { at },
      );
      return { synced: 0, failed: batch.length };
    }
  }

  async #processProvider(context) {
    const providerId = context.provider.id;
    const at = this.now();
    if (!context.circuit.canAttempt(at)) {
      this.storage.providerDeliveries.setCircuitState(
        providerId,
        context.circuit.getSnapshot().state,
        { at },
      );
      return { providerId, state: "circuit_open", events: null, snapshots: null };
    }
    const limit = context.batcher.sizeFor({
      circuitState: context.circuit.getSnapshot().state,
      halfOpenBatch: this.config.circuitHalfOpenBatch,
    });
    const eventBatch = this.storage.providerDeliveries.claimBatch({
      providerId,
      workerId: context.workerId,
      limit,
      lockTimeoutMs: this.config.lockTimeoutMs,
      at,
    });
    if (eventBatch.length > 0) {
      const events = await this.#pushEvents(context, eventBatch);
      let snapshots = null;
      if (
        this.config.snapshotEnabled &&
        events.failed === 0 &&
        context.circuit.canAttempt(this.now())
      ) {
        const snapshotBatch = this.storage.snapshots.claimBatch({
          providerId,
          workerId: context.workerId,
          limit: this.config.snapshotBatchSize,
          lockTimeoutMs: this.config.lockTimeoutMs,
          at: this.now(),
        });
        if (snapshotBatch.length > 0) {
          snapshots = await this.#pushSnapshots(context, snapshotBatch);
        } else {
          context.circuit.cancelAttempt();
        }
      }
      return {
        providerId,
        state:
          events.failed > 0 || (snapshots?.failed ?? 0) > 0
            ? "partial_failure"
            : "synced",
        events,
        snapshots,
      };
    }
    context.circuit.cancelAttempt();
    if (!this.config.snapshotEnabled || !context.circuit.canAttempt(this.now())) {
      return { providerId, state: "idle", events: null, snapshots: null };
    }
    const snapshotBatch = this.storage.snapshots.claimBatch({
      providerId,
      workerId: context.workerId,
      limit: this.config.snapshotBatchSize,
      lockTimeoutMs: this.config.lockTimeoutMs,
      at: this.now(),
    });
    if (snapshotBatch.length === 0) {
      context.circuit.cancelAttempt();
      return { providerId, state: "idle", events: null, snapshots: null };
    }
    const snapshots = await this.#pushSnapshots(context, snapshotBatch);
    return {
      providerId,
      state: snapshots.failed > 0 ? "partial_failure" : "snapshot_synced",
      events: null,
      snapshots,
    };
  }

  #maintenance(at) {
    if (
      this.#lastIntegrityAt === null ||
      at - this.#lastIntegrityAt >= this.config.integrityIntervalMs
    ) {
      const integrity = this.storage.health.checkIntegrity({ quick: true });
      if (!integrity.ok) throw new Error("SQLite quick_check failed.");
      this.#lastIntegrityAt = at;
    }
    if (
      this.#lastCheckpointAt === null ||
      at - this.#lastCheckpointAt >= this.config.checkpointIntervalMs
    ) {
      this.storage.health.checkpoint("PASSIVE");
      this.#lastCheckpointAt = at;
    }
    if (
      this.#lastRetentionAt === null ||
      at - this.#lastRetentionAt >= this.config.outboxRetentionIntervalMs
    ) {
      this.storage.outbox.purgeSynced({
        olderThan: at - this.config.outboxRetentionDays * 86_400_000,
        limit: this.config.outboxRetentionBatch,
      });
      this.#lastRetentionAt = at;
    }
    if (
      this.config.snapshotEnabled &&
      (this.#lastSnapshotAt === null ||
        at - this.#lastSnapshotAt >= this.config.snapshotIntervalMs)
    ) {
      this.snapshotService.refreshAll({
        workerStatus: this.#stopping ? "STOPPING" : "RUNNING",
      });
      this.#lastSnapshotAt = at;
    }
    if (this.config.analyticsCompaction?.enabled) {
      this.analyticsCompaction.refreshDue({ at });
    }
  }

  async #writeMetrics({ force = false } = {}) {
    const at = this.now();
    const providers = this.storage.providerDeliveries.getAllProviderStatus();
    const sqliteStatus = this.storage.health.getStatus();
    const snapshot = {
      schemaVersion: 2,
      mode: "MULTI_DB_SYNC_V1",
      generatedAt: at,
      workerStatus: this.#stopping ? "STOPPING" : this.#running ? "RUNNING" : "OFFLINE",
      workerHealth: providers.some(
        (provider) => provider.required && provider.healthStatus !== "HEALTHY",
      )
        ? "DEGRADED"
        : "HEALTHY",
      providers: Object.fromEntries(
        providers.map((provider) => [provider.providerId, provider]),
      ),
      cloudComplete: this.storage.providerDeliveries.getCloudCompletionSummary(),
      sqlite: {
        status: sqliteStatus.integrity?.ok ? "HEALTHY" : "UNHEALTHY",
        schemaVersion: sqliteStatus.schemaVersion,
        journalMode: sqliteStatus.journalMode,
        storage: sqliteStatus.storage,
        integrity: sqliteStatus.integrity,
      },
      analyticsCompaction: {
        enabled: Boolean(this.config.analyticsCompaction?.enabled),
        allGuildsEnabled: Boolean(
          this.config.analyticsCompaction?.allGuildsEnabled,
        ),
        guildCount: this.config.analyticsCompaction?.guildIds?.length ?? 0,
        intervalSeconds:
          this.config.analyticsCompaction?.intervalSeconds ?? null,
        ...this.storage.analyticsProjections.getMetrics(),
      },
      startedAt: this.#startedAt,
    };
    if (
      force ||
      this.#lastMetricsAt === null ||
      at - this.#lastMetricsAt >= this.config.metricsIntervalMs
    ) {
      await this.snapshotWriter(this.config.metricsPath, snapshot);
      this.#lastMetricsAt = at;
    }
    return snapshot;
  }

  async processOnce() {
    if (this.#stopping) return { state: "stopping", providers: [] };
    this.#maintenance(this.now());
    const results = await Promise.all(
      [...this.contexts.values()].map((context) => this.#processProvider(context)),
    );
    await this.#writeMetrics({ force: results.some((result) => result.state !== "idle") });
    return { state: "processed", providers: results };
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
    if (this.#running) throw new Error("Multi-DB Sync Worker is already running.");
    this.#running = true;
    this.#stopping = false;
    this.#startedAt = this.now();
    this.storage.providerDeliveries.applyPolicy(this.config.providerDefinitions);
    this.storage.snapshots.applyPolicy(this.config.providerDefinitions);
    for (const context of this.contexts.values()) {
      this.storage.providerDeliveries.releaseExpiredLocks(context.provider.id, {
        lockTimeoutMs: this.config.lockTimeoutMs,
        at: this.now(),
      });
      this.storage.snapshots.releaseExpiredLocks(context.provider.id, {
        lockTimeoutMs: this.config.lockTimeoutMs,
        at: this.now(),
      });
    }
    try {
      while (!this.#stopping) {
        try {
          this.#inFlight = this.processOnce();
          await this.#inFlight;
        } catch (error) {
          this.logger.error?.(`[multi-sync] ${sanitizeSyncError(error)}`);
        } finally {
          this.#inFlight = null;
        }
        await this.#sleep(this.config.idleMs);
      }
    } finally {
      if (this.#inFlight) await this.#inFlight;
      for (const context of this.contexts.values()) {
        this.storage.providerDeliveries.releaseWorkerLocks(
          context.provider.id,
          context.workerId,
          { at: this.now() },
        );
        this.storage.snapshots.releaseWorkerLocks(
          context.provider.id,
          context.workerId,
          { at: this.now() },
        );
      }
      this.#running = false;
      await this.#writeMetrics({ force: true });
    }
  }

  async stop() {
    this.#stopping = true;
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#wakeSleep?.();
    if (this.#inFlight) await this.#inFlight;
  }

  get status() {
    return {
      running: this.#running,
      stopping: this.#stopping,
      providers: Object.fromEntries(
        [...this.contexts.entries()].map(([providerId, context]) => [
          providerId,
          {
            workerId: context.workerId,
            circuit: context.circuit.getSnapshot(),
            batchSize: context.batcher.currentSize,
          },
        ]),
      ),
    };
  }
}
