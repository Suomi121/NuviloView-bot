import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CLOUD_DATABASE_STATE = Object.freeze({
  UNKNOWN: "UNKNOWN",
  AVAILABLE: "AVAILABLE",
  OFFLINE: "OFFLINE",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

const transientErrorCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

function environmentInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function safeErrorCode(error) {
  const value = error?.code ?? error?.cause?.code ?? error?.name ?? "CLOUD_DATABASE_ERROR";
  return String(value).slice(0, 80);
}

export function isTransientCloudDatabaseError(error) {
  const code = safeErrorCode(error).toUpperCase();
  if (transientErrorCodes.has(code)) return true;
  const status = Number(error?.status ?? error?.statusCode ?? error?.cause?.status);
  if ([408, 429, 502, 503, 504].includes(status)) return true;
  const message = String(error?.message ?? error?.cause?.message ?? "").toLowerCase();
  return /(?:fetch failed|network|socket|timeout|timed out|connection|quota|rate limit|temporarily unavailable|service unavailable)/.test(
    message,
  );
}

export class CloudDatabaseUnavailableError extends Error {
  constructor(state, reason = "cloud database access is currently unavailable") {
    super(reason);
    this.name = "CloudDatabaseUnavailableError";
    this.code = state === CLOUD_DATABASE_STATE.NOT_CONFIGURED
      ? "CLOUD_DATABASE_NOT_CONFIGURED"
      : "CLOUD_DATABASE_OFFLINE";
    this.state = state;
  }
}

export function isCloudDatabaseUnavailableError(error) {
  return error instanceof CloudDatabaseUnavailableError ||
    ["CLOUD_DATABASE_NOT_CONFIGURED", "CLOUD_DATABASE_OFFLINE"].includes(error?.code);
}

export function getCloudDatabaseConfig(
  env = process.env,
  { cwd = process.cwd() } = {},
) {
  return Object.freeze({
    configured: Boolean(env.DATABASE_URL?.trim()),
    probeTimeoutMs: environmentInteger(
      env.NEON_DEGRADED_PROBE_TIMEOUT_MS,
      5_000,
      500,
      30_000,
    ),
    baseBackoffMs:
      environmentInteger(env.NEON_DEGRADED_PROBE_BASE_SECONDS, 30, 5, 3_600) * 1_000,
    maxBackoffMs:
      environmentInteger(env.NEON_DEGRADED_PROBE_MAX_SECONDS, 900, 30, 21_600) * 1_000,
    featureLogIntervalMs:
      environmentInteger(env.NEON_DEGRADED_LOG_INTERVAL_SECONDS, 300, 30, 3_600) * 1_000,
    statusPath: resolve(
      cwd,
      env.NUVILOVIEW_RUNTIME_STATUS_PATH?.trim() ||
        "data/runtime/neon-runtime-health.json",
    ),
  });
}

function withTimeout(operation, timeoutMs) {
  let timeout;
  const task = Promise.resolve().then(operation);
  task.catch(() => {});
  return Promise.race([
    task,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Cloud database probe exceeded ${timeoutMs}ms.`);
        error.code = "ETIMEDOUT";
        reject(error);
      }, timeoutMs);
      timeout.unref?.();
    }),
  ]).finally(() => clearTimeout(timeout));
}

export function createCloudDatabase({
  connectionString = process.env.DATABASE_URL?.trim() || null,
  neonFactory,
  env = process.env,
  cwd = process.cwd(),
  now = () => Date.now(),
  logger = console,
} = {}) {
  const config = getCloudDatabaseConfig(env, { cwd });
  if (connectionString && typeof neonFactory !== "function") {
    throw new TypeError("neonFactory is required when DATABASE_URL is configured.");
  }

  const configured = Boolean(connectionString);
  let rawSql = null;
  let factoryError = null;
  if (configured) {
    try {
      rawSql = neonFactory(connectionString);
    } catch (error) {
      factoryError = error;
    }
  }
  let state = rawSql
    ? CLOUD_DATABASE_STATE.UNKNOWN
    : configured
      ? CLOUD_DATABASE_STATE.OFFLINE
      : CLOUD_DATABASE_STATE.NOT_CONFIGURED;
  let stateReason = rawSql
    ? "startup_pending_probe"
    : configured
      ? "client_initialization_failed"
      : "database_url_missing";
  let consecutiveFailures = 0;
  let nextProbeAt = 0;
  let probeInFlight = false;
  let queryAttempts = 0;
  let querySuccesses = 0;
  let queryFailures = 0;
  let suppressedQueries = 0;
  let lastSuccessfulQueryAt = null;
  let lastFailureAt = null;
  let lastTransitionAt = now();
  let lastErrorCode = null;
  let runtimeDetails = {};
  const featureLogTimes = new Map();

  function snapshot() {
    return {
      schemaVersion: 1,
      runtimeMode:
        state === CLOUD_DATABASE_STATE.AVAILABLE ? "NORMAL" : "DEGRADED",
      neon: state,
      configured,
      reason: stateReason,
      consecutiveFailures,
      nextProbeAt: nextProbeAt || null,
      probeInFlight,
      queryAttempts,
      querySuccesses,
      queryFailures,
      suppressedQueries,
      lastSuccessfulQueryAt,
      lastFailureAt,
      lastTransitionAt,
      lastErrorCode,
      ...runtimeDetails,
      updatedAt: now(),
    };
  }

  function persistStatus() {
    try {
      mkdirSync(dirname(config.statusPath), { recursive: true });
      writeFileSync(config.statusPath, `${JSON.stringify(snapshot(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      if (shouldLogFeature("runtime_status_write", 60_000)) {
        logger.warn?.(`[CloudDB] runtime status write failed (${safeErrorCode(error)}).`);
      }
    }
  }

  function transition(nextState, reason, error = null) {
    const previous = state;
    state = nextState;
    stateReason = reason;
    if (error) lastErrorCode = safeErrorCode(error);
    if (previous !== nextState) {
      lastTransitionAt = now();
      const message = `[CloudDB] ${previous} -> ${nextState} (${reason}).`;
      if (nextState === CLOUD_DATABASE_STATE.AVAILABLE) logger.info?.(message);
      else logger.warn?.(message);
    }
    persistStatus();
  }

  function shouldLogFeature(feature, intervalMs = config.featureLogIntervalMs) {
    const key = String(feature || "unknown");
    const current = now();
    const previous = featureLogTimes.get(key) ?? 0;
    if (current - previous < intervalMs) return false;
    featureLogTimes.set(key, current);
    return true;
  }

  function markOffline(error, reason = "query_failed") {
    consecutiveFailures += 1;
    queryFailures += 1;
    lastFailureAt = now();
    const exponent = Math.min(consecutiveFailures - 1, 10);
    nextProbeAt = now() + Math.min(
      config.maxBackoffMs,
      config.baseBackoffMs * 2 ** exponent,
    );
    transition(CLOUD_DATABASE_STATE.OFFLINE, reason, error);
  }

  function canQuery() {
    if (!rawSql || probeInFlight) return false;
    return state !== CLOUD_DATABASE_STATE.OFFLINE || now() >= nextProbeAt;
  }

  async function execute(operation, { probe = false, force = false } = {}) {
    if (!rawSql) {
      suppressedQueries += 1;
      persistStatus();
      throw new CloudDatabaseUnavailableError(state);
    }
    if (probeInFlight) {
      suppressedQueries += 1;
      throw new CloudDatabaseUnavailableError(state, "cloud database recovery probe is in progress");
    }
    if (!force && state === CLOUD_DATABASE_STATE.OFFLINE && now() < nextProbeAt) {
      suppressedQueries += 1;
      throw new CloudDatabaseUnavailableError(state);
    }

    const recoveryAttempt = probe || state === CLOUD_DATABASE_STATE.OFFLINE;
    if (recoveryAttempt) probeInFlight = true;
    queryAttempts += 1;
    try {
      const result = await withTimeout(operation, config.probeTimeoutMs);
      querySuccesses += 1;
      consecutiveFailures = 0;
      nextProbeAt = 0;
      lastSuccessfulQueryAt = now();
      lastErrorCode = null;
      transition(CLOUD_DATABASE_STATE.AVAILABLE, recoveryAttempt ? "probe_succeeded" : "query_succeeded");
      return result;
    } catch (error) {
      if (probe || state !== CLOUD_DATABASE_STATE.AVAILABLE || isTransientCloudDatabaseError(error)) {
        markOffline(error, probe ? "probe_failed" : "query_failed");
      } else {
        queryFailures += 1;
        lastFailureAt = now();
        lastErrorCode = safeErrorCode(error);
        persistStatus();
      }
      throw error;
    } finally {
      if (recoveryAttempt) probeInFlight = false;
      persistStatus();
    }
  }

  const sql = async (strings, ...values) => execute(() => rawSql(strings, ...values));
  sql.query = (text, parameters = []) => execute(() => rawSql.query(text, parameters));

  async function probe({ force = false } = {}) {
    if (!rawSql) {
      transition(
        configured ? CLOUD_DATABASE_STATE.OFFLINE : CLOUD_DATABASE_STATE.NOT_CONFIGURED,
        configured ? "client_initialization_failed" : "database_url_missing",
        factoryError,
      );
      return false;
    }
    if (!force && state === CLOUD_DATABASE_STATE.OFFLINE && now() < nextProbeAt) {
      return false;
    }
    try {
      await execute(() => rawSql.query("SELECT 1 AS connected", []), {
        probe: true,
        force,
      });
      return true;
    } catch {
      return false;
    }
  }

  function updateRuntimeDetails(values = {}) {
    runtimeDetails = {
      ...runtimeDetails,
      ...values,
    };
    persistStatus();
    return snapshot();
  }

  persistStatus();
  return Object.freeze({
    sql,
    probe,
    canQuery,
    isAvailable: () => state === CLOUD_DATABASE_STATE.AVAILABLE,
    getStatus: snapshot,
    updateRuntimeDetails,
    shouldLogFeature,
    persistStatus,
    config,
  });
}
