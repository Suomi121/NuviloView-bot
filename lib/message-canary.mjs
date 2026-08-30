import { randomUUID } from "node:crypto";
import { getDiskFreeBytes } from "./sync/guards.mjs";

const discordIdPattern = /^[1-9]\d{16,19}$/;

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function parseMessageCanaryGuildIds(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return Object.freeze([]);
  const values = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  if (values.length > 100) {
    throw new TypeError("LOCAL_MESSAGE_CANARY_GUILDS cannot contain more than 100 Guild IDs.");
  }
  for (const guildId of values) {
    if (!discordIdPattern.test(guildId)) {
      throw new TypeError(`Invalid Discord Guild ID in LOCAL_MESSAGE_CANARY_GUILDS: ${guildId}`);
    }
  }
  return Object.freeze(values.sort());
}

export function getMessageCanaryConfig(env = process.env) {
  const guildIds = parseMessageCanaryGuildIds(env.LOCAL_MESSAGE_CANARY_GUILDS);
  return Object.freeze({
    globalEnabled: enabled(env.LOCAL_MESSAGE_STORAGE_ENABLED),
    allGuildsEnabled: enabled(env.LOCAL_FIRST_ALL_GUILDS_ENABLED),
    guildIds,
    thresholds: Object.freeze({
      pendingWarn: integer(env, "MESSAGE_CANARY_PENDING_WARN", 500, { min: 1 }),
      pendingAbort: integer(env, "MESSAGE_CANARY_PENDING_ABORT", 5_000, { min: 1 }),
      oldestPendingWarnMs: integer(
        env,
        "MESSAGE_CANARY_OLDEST_PENDING_WARN_SECONDS",
        120,
        { min: 1 },
      ) * 1_000,
      oldestPendingAbortMs: integer(
        env,
        "MESSAGE_CANARY_OLDEST_PENDING_ABORT_SECONDS",
        600,
        { min: 1 },
      ) * 1_000,
      syncLagWarnMs: integer(env, "MESSAGE_CANARY_SYNC_LAG_WARN_SECONDS", 120, {
        min: 1,
      }) * 1_000,
      syncLagAbortMs: integer(env, "MESSAGE_CANARY_SYNC_LAG_ABORT_SECONDS", 600, {
        min: 1,
      }) * 1_000,
      circuitOpenAbortMs: integer(
        env,
        "MESSAGE_CANARY_CIRCUIT_OPEN_ABORT_SECONDS",
        300,
        { min: 1 },
      ) * 1_000,
      walWarnBytes: integer(env, "MESSAGE_CANARY_WAL_WARN_BYTES", 268_435_456, {
        min: 1,
      }),
      walAbortBytes: integer(env, "MESSAGE_CANARY_WAL_ABORT_BYTES", 536_870_912, {
        min: 1,
      }),
      diskWarnBytes: integer(env, "MESSAGE_CANARY_DISK_WARN_BYTES", 2_147_483_648, {
        min: 1,
      }),
      diskAbortBytes: integer(env, "MESSAGE_CANARY_DISK_ABORT_BYTES", 536_870_912, {
        min: 1,
      }),
    }),
  });
}

export function validateMessageCanaryThresholds(thresholds) {
  if (thresholds.pendingAbort < thresholds.pendingWarn) {
    throw new TypeError("MESSAGE_CANARY_PENDING_ABORT must be at least the warning value.");
  }
  if (thresholds.oldestPendingAbortMs < thresholds.oldestPendingWarnMs) {
    throw new TypeError("Oldest Pending abort threshold must be at least the warning value.");
  }
  if (thresholds.syncLagAbortMs < thresholds.syncLagWarnMs) {
    throw new TypeError("Sync Lag abort threshold must be at least the warning value.");
  }
  if (thresholds.walAbortBytes < thresholds.walWarnBytes) {
    throw new TypeError("WAL abort threshold must be at least the warning value.");
  }
  if (thresholds.diskAbortBytes > thresholds.diskWarnBytes) {
    throw new TypeError("Disk abort threshold must not exceed the warning value.");
  }
  return thresholds;
}

export function getMessageGuildRoutingMode(config, guildId) {
  const normalized = String(guildId ?? "").trim();
  return config.globalEnabled &&
    (config.allGuildsEnabled === true || config.guildIds.includes(normalized))
    ? "LOCAL_FIRST"
    : "LEGACY";
}

export function probeMessageOutboxWritable(storage, { now = () => Date.now() } = {}) {
  if (!storage?.enabled || !storage?.writeEnabled) return false;
  const eventId = `message-canary-preflight:${randomUUID()}`;
  const rollback = new Error("message canary preflight rollback");
  rollback.code = "MESSAGE_CANARY_PREFLIGHT_ROLLBACK";
  try {
    storage.transaction(() => {
      storage.outbox.enqueue({
        eventId,
        domain: "bot_event",
        eventType: "message_canary_preflight",
        aggregateId: `preflight:${eventId}`,
        payload: { probe: true },
        schemaVersion: 1,
        createdAt: now(),
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return storage.outbox.getByEventId(eventId) === null;
}

export function buildMessageCanarySnapshot({
  config,
  storage,
  workerSnapshot = null,
  replicaSchema = null,
  comparison = null,
  outboxWritable = null,
  configuredWriteEnabled = null,
  now = () => Date.now(),
}) {
  validateMessageCanaryThresholds(config.thresholds);
  const status = storage?.enabled ? storage.health.getStatus() : null;
  const sizes = storage?.enabled
    ? storage.health.getStorageSize()
    : { databaseBytes: 0, walBytes: 0, totalBytes: 0 };
  const metrics = storage?.enabled ? storage.messageDomain.getMetrics({ at: now() }) : {};
  const counts = storage?.enabled
    ? storage.outbox.getStatusCounts()
    : { pending: 0, retry: 0, processing: 0, synced: 0, dead_letter: 0 };
  const pendingCount = Number(metrics.messageOutboxPending ?? 0);
  const messageSync = storage?.enabled
    ? storage.outbox.getMessageSyncStatus({ at: now() })
    : {
        lastSyncedMessageAt: null,
        lastLocalMessageAt: null,
        oldestPendingAgeMs: null,
        pendingCount: 0,
      };
  const circuit = workerSnapshot?.circuit ?? { state: "UNKNOWN" };
  return {
    schemaVersion: 1,
    generatedAt: now(),
    allGuildsEnabled: Boolean(config.allGuildsEnabled),
    canaryGuilds: config.guildIds.map((guildId) => ({
      guildId,
      routingMode: getMessageGuildRoutingMode(config, guildId),
    })),
    globalFlagEnabled: config.globalEnabled,
    localStorage: {
      accessible: Boolean(status?.open),
      writeEnabled: configuredWriteEnabled == null
        ? Boolean(status?.writeEnabled)
        : Boolean(configuredWriteEnabled),
      integrity: status?.integrity ?? null,
      journalMode: status?.journalMode ?? null,
      outboxWritable,
      databaseBytes: Number(sizes.databaseBytes ?? 0),
      walBytes: Number(sizes.walBytes ?? 0),
      totalBytes: Number(sizes.totalBytes ?? 0),
      diskFreeBytes: status?.databasePath
        ? getDiskFreeBytes(status.databasePath)
        : null,
    },
    syncWorker: {
      ready: workerSnapshot?.workerStatus === "RUNNING",
      status: workerSnapshot?.workerStatus ?? "UNKNOWN",
      lastSync: metrics.messageLastSync ?? workerSnapshot?.lastSyncSuccess ?? null,
      syncLagMs: metrics.messageSyncLag ?? workerSnapshot?.oldestPendingAgeMs ?? null,
      replicaBatchQueryCount: Number(workerSnapshot?.replicaBatchQueryCount ?? 0),
    },
    circuit: {
      state: circuit.state ?? workerSnapshot?.circuitState ?? "UNKNOWN",
      openedAt: circuit.openedAt ?? null,
      openCount: Number(circuit.openCount ?? workerSnapshot?.circuitOpenCount ?? 0),
    },
    queue: {
      pendingCount,
      pending: Number(counts.pending ?? 0),
      retry: Number(counts.retry ?? 0),
      processing: Number(counts.processing ?? 0),
      deadLetterCount: storage?.enabled ? storage.outbox.getDeadLetterCount() : 0,
      oldestPendingAgeMs:
        metrics.messageOldestPendingAge ?? workerSnapshot?.oldestPendingAgeMs ?? null,
      lastLocalMessageAt: messageSync.lastLocalMessageAt,
      lastSyncedMessageAt: messageSync.lastSyncedMessageAt,
    },
    metrics: {
      messageLocalWritesTotal: Number(metrics.messageLocalWritesTotal ?? 0),
      messageLocalWriteFailures: Number(metrics.messageLocalWriteFailures ?? 0),
      messageSyncSuccessTotal: Number(metrics.messageSyncSuccessTotal ?? 0),
      messageSyncFailureTotal: Number(metrics.messageSyncFailureTotal ?? 0),
      lastLocalWrite: metrics.messageLastLocalWrite ?? null,
      lastSync: metrics.messageLastSync ?? null,
      legacyNeonMessageQueryCount: 0,
      replicaBatchQueryCount: Number(workerSnapshot?.replicaBatchQueryCount ?? 0),
    },
    replicaSchema,
    comparison,
  };
}

export function evaluateMessageCanaryHealth(snapshot, config, {
  baseline = {},
  requireArmed = false,
  now = () => Date.now(),
} = {}) {
  const warnings = [];
  const abort = [];
  const thresholds = validateMessageCanaryThresholds(config.thresholds);
  const local = snapshot.localStorage;
  const queue = snapshot.queue;
  const worker = snapshot.syncWorker;
  const circuit = snapshot.circuit;

  if (config.guildIds.length === 0 && !config.allGuildsEnabled) {
    abort.push("canary_guild_list_empty");
  }
  if (requireArmed && !config.globalEnabled) abort.push("global_flag_not_armed");
  else if (!config.globalEnabled) warnings.push("global_flag_off");
  if (!local.accessible) abort.push("sqlite_unavailable");
  if (!local.writeEnabled) abort.push("sqlite_not_writable");
  if (local.integrity && local.integrity.ok !== true) abort.push("sqlite_integrity_failed");
  if (local.journalMode && String(local.journalMode).toLowerCase() !== "wal") {
    abort.push("sqlite_wal_disabled");
  }
  if (local.outboxWritable === false) abort.push("outbox_not_writable");
  if (!worker.ready) abort.push("sync_worker_unavailable");
  if (!snapshot.replicaSchema?.ready) abort.push("replica_schema_unavailable");

  const localFailureDelta = snapshot.metrics.messageLocalWriteFailures - Number(
    baseline.messageLocalWriteFailures ?? snapshot.metrics.messageLocalWriteFailures,
  );
  if (localFailureDelta > 0) abort.push("local_write_failure");
  const syncFailureDelta = snapshot.metrics.messageSyncFailureTotal - Number(
    baseline.messageSyncFailureTotal ?? snapshot.metrics.messageSyncFailureTotal,
  );
  if (syncFailureDelta > 0) warnings.push("sync_failure_detected");
  if (queue.deadLetterCount > Number(baseline.deadLetterCount ?? 0)) {
    abort.push("dead_letter_detected");
  }

  if (queue.pendingCount >= thresholds.pendingAbort) abort.push("pending_count_abort");
  else if (queue.pendingCount >= thresholds.pendingWarn) warnings.push("pending_count_warning");
  if (
    queue.oldestPendingAgeMs != null &&
    queue.oldestPendingAgeMs >= thresholds.oldestPendingAbortMs
  ) abort.push("oldest_pending_abort");
  else if (
    queue.oldestPendingAgeMs != null &&
    queue.oldestPendingAgeMs >= thresholds.oldestPendingWarnMs
  ) warnings.push("oldest_pending_warning");
  if (worker.syncLagMs != null && worker.syncLagMs >= thresholds.syncLagAbortMs) {
    abort.push("sync_lag_abort");
  } else if (worker.syncLagMs != null && worker.syncLagMs >= thresholds.syncLagWarnMs) {
    warnings.push("sync_lag_warning");
  }
  if (local.walBytes >= thresholds.walAbortBytes) abort.push("wal_size_abort");
  else if (local.walBytes >= thresholds.walWarnBytes) warnings.push("wal_size_warning");
  if (local.diskFreeBytes != null && local.diskFreeBytes <= thresholds.diskAbortBytes) {
    abort.push("disk_free_abort");
  } else if (
    local.diskFreeBytes != null &&
    local.diskFreeBytes <= thresholds.diskWarnBytes
  ) warnings.push("disk_free_warning");
  if (circuit.state === "HALF_OPEN") warnings.push("circuit_half_open");
  if (circuit.state === "OPEN") {
    const openAge = circuit.openedAt == null ? Infinity : now() - circuit.openedAt;
    if (openAge >= thresholds.circuitOpenAbortMs) abort.push("circuit_open_too_long");
    else warnings.push("circuit_open");
  }
  if (snapshot.comparison?.matched === false) abort.push("comparison_mismatch");

  return {
    status: abort.length > 0 ? "ABORT" : warnings.length > 0 ? "DEGRADED" : "HEALTHY",
    warnings: [...new Set(warnings)],
    abort: [...new Set(abort)],
  };
}

export function compareMessageCanarySnapshots(local, replica) {
  const fields = [
    ["eventCount", "replicaEventCount"],
    ["currentMessageCount", "materializedMessageCount"],
    ["deletedCount", "tombstoneCount"],
    ["recentActivityCount", "recentActivityCount"],
    ["activeMemberCount", "expectedActiveMemberCount"],
    ["latestCreateAt", "latestCreateAt"],
  ];
  const differences = [];
  for (const [localField, replicaField] of fields) {
    const localValue = local?.[localField] ?? null;
    const replicaValue = replica?.[replicaField] ?? null;
    if (localValue !== replicaValue) {
      differences.push({ metric: localField, local: localValue, replica: replicaValue });
    }
  }
  if (Number(replica?.dailyStatsMismatchCount ?? 0) > 0) {
    differences.push({
      metric: "dailyStatsMismatchCount",
      local: 0,
      replica: Number(replica.dailyStatsMismatchCount),
    });
  }
  if (Number(replica?.activeMemberMissingCount ?? 0) > 0) {
    differences.push({
      metric: "activeMemberMissingCount",
      local: 0,
      replica: Number(replica.activeMemberMissingCount),
    });
  }
  for (const [expectedField, actualField, metric] of [
    ["expectedMessageCount", "materializedMessageCount", "materializedMessageCount"],
    ["expectedDeletedCount", "tombstoneCount", "tombstoneCount"],
    ["expectedRecentActivityCount", "recentActivityCount", "recentActivityCount"],
  ]) {
    if (
      replica?.[expectedField] != null &&
      replica?.[actualField] != null &&
      Number(replica[expectedField]) !== Number(replica[actualField])
    ) {
      differences.push({
        metric,
        expected: Number(replica[expectedField]),
        replica: Number(replica[actualField]),
      });
    }
  }
  return { matched: differences.length === 0, differences };
}
