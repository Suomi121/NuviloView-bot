import { resolve } from "node:path";
import {
  getProviderPolicy,
  getProviderPolicyDefinitions,
  isEnabledFlag,
  SYNC_REQUIRED_PROVIDER_IDS,
} from "./providers/contract.mjs";
import { getAnalyticsCompactionConfig } from "./analytics-compaction.mjs";

function integer(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function ratio(env, name, fallback) {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between 0 and 1.`);
  }
  return value;
}

export function getMultiDbSyncConfig(
  env = process.env,
  { cwd = process.cwd() } = {},
) {
  const enabled = isEnabledFlag(env.MULTI_DB_SYNC_ENABLED);
  const batchMin = integer(env, "SYNC_PROVIDER_BATCH_MIN", 25, {
    min: 1,
    max: 1_000,
  });
  const batchMax = integer(env, "SYNC_PROVIDER_BATCH_MAX", 100, {
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
  const providerDefinitions = getProviderPolicyDefinitions(env);
  const definition = (id) => providerDefinitions.find((item) => item.id === id);
  const neonFlag = env.SYNC_NEON_ENABLED ?? env.SYNC_NEON_REPLICA_ENABLED;
  const analyticsCompaction = getAnalyticsCompactionConfig(env);

  return Object.freeze({
    enabled,
    workerEnabled: isEnabledFlag(env.SYNC_WORKER_ENABLED),
    snapshotEnabled: enabled && isEnabledFlag(env.SYNC_SNAPSHOT_ENABLED),
    webReadEnabled: enabled && isEnabledFlag(env.MULTI_DB_WEB_READ_ENABLED),
    snapshotIntervalMs: integer(env, "SYNC_SNAPSHOT_INTERVAL_MS", 60_000, {
      min: 10_000,
      max: 86_400_000,
    }),
    snapshotBatchSize: integer(env, "SYNC_SNAPSHOT_BATCH_SIZE", 25, {
      min: 1,
      max: 250,
    }),
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
    queryTimeoutMs: integer(env, "SYNC_QUERY_TIMEOUT_MS", 15_000, {
      min: 1_000,
      max: 300_000,
    }),
    metricsIntervalMs: integer(env, "SYNC_METRICS_INTERVAL_MS", 30_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    integrityIntervalMs: integer(env, "SYNC_INTEGRITY_INTERVAL_MS", 300_000, {
      min: 10_000,
      max: 86_400_000,
    }),
    checkpointIntervalMs: integer(env, "SYNC_CHECKPOINT_INTERVAL_MS", 60_000, {
      min: 10_000,
      max: 86_400_000,
    }),
    outboxRetentionDays: integer(env, "SYNC_OUTBOX_RETENTION_DAYS", 7, {
      min: 1,
      max: 365,
    }),
    outboxRetentionBatch: integer(env, "SYNC_OUTBOX_RETENTION_BATCH", 500, {
      min: 1,
      max: 10_000,
    }),
    outboxRetentionIntervalMs: integer(
      env,
      "SYNC_OUTBOX_RETENTION_INTERVAL_MS",
      3_600_000,
      { min: 60_000, max: 86_400_000 },
    ),
    metricsPath: resolve(
      cwd,
      env.SYNC_METRICS_PATH?.trim() || "data/runtime/sync-worker-health.json",
    ),
    providerDefinitions,
    analyticsCompaction,
    providers: Object.freeze({
      supabase: Object.freeze({
        ...getProviderPolicy("supabase"),
        ...definition("supabase"),
        enabled: Boolean(definition("supabase")?.enabled),
        configured: Boolean(env.SUPABASE_DATABASE_URL?.trim()),
        connectionString: env.SUPABASE_DATABASE_URL?.trim() || null,
        caCertificate:
          env.SUPABASE_CA_CERT?.trim()
          || env.WEB_AUTH_SUPABASE_CA_CERT?.trim()
          || null,
      }),
      turso: Object.freeze({
        ...getProviderPolicy("turso"),
        ...definition("turso"),
        enabled: Boolean(definition("turso")?.enabled),
        configured: Boolean(
          env.TURSO_DATABASE_URL?.trim() && env.TURSO_AUTH_TOKEN?.trim(),
        ),
        databaseUrl: env.TURSO_DATABASE_URL?.trim() || null,
        authToken: env.TURSO_AUTH_TOKEN?.trim() || null,
      }),
      neon: Object.freeze({
        ...getProviderPolicy("neon"),
        ...definition("neon"),
        enabled: enabled && isEnabledFlag(neonFlag),
        configured: Boolean(env.DATABASE_URL?.trim()),
        connectionString: env.DATABASE_URL?.trim() || null,
      }),
    }),
  });
}

export function validateMultiDbRuntimeConfig(config) {
  if (!config.enabled) return Object.freeze({ ok: true, errors: [] });
  const errors = [];
  for (const providerId of SYNC_REQUIRED_PROVIDER_IDS) {
    const provider = config.providers[providerId];
    if (!provider.enabled) errors.push(`${providerId}_required_but_disabled`);
    else if (!provider.configured) errors.push(`${providerId}_credentials_missing`);
  }
  for (const provider of Object.values(config.providers)) {
    if (provider.enabled && !provider.configured) {
      const code = `${provider.id}_credentials_missing`;
      if (!errors.includes(code)) errors.push(code);
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
