import { analyticsCurrentProjectionKey } from "./sync/analytics-compaction.mjs";
import { analyticsProjectionKey } from "./storage/repositories/analytics-projections.mjs";

export const WEB_READ_PROVIDER_PRIORITY = Object.freeze([
  "supabase",
  "turso",
  "neon",
]);

const FATAL_DATABASE_CODE_PREFIXES = Object.freeze(["22", "23", "28", "42"]);
const FATAL_CODES = new Set([
  "SYNC_CHECKSUM_MISMATCH",
  "SYNC_INVALID_PAYLOAD",
  "ERR_INVALID_ARG_TYPE",
]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const metricsState = globalThis.__nuviloWebReadMetrics ??= {
  supabaseReads: 0,
  tursoFallbackReads: 0,
  neonReads: 0,
  readFailures: 0,
  staleReads: 0,
  degradedResponses: 0,
  rawAnalyticsQueries: 0,
};

const lastKnownGood = globalThis.__nuviloWebReadLastKnownGood ??= new Map();

function cloneMetrics() {
  return Object.freeze({ ...metricsState });
}

function increment(name) {
  metricsState[name] = Number(metricsState[name] ?? 0) + 1;
}

function normalizedErrorCode(error) {
  return String(error?.code ?? error?.cause?.code ?? "").trim().toUpperCase();
}

function logProviderFallback(logger, providerId, operation, error) {
  const code = normalizedErrorCode(error) || String(error?.name ?? "UNKNOWN_ERROR");
  logger?.warn?.(
    `[web-read-router] ${providerId} ${operation} fallback (${code}).`,
  );
}

export function isWebReadFallbackError(error) {
  const code = normalizedErrorCode(error);
  if (TRANSIENT_NETWORK_CODES.has(code)) return true;
  if (
    error instanceof TypeError
    && /(?:fetch failed|failed to fetch|network error)/i.test(String(error?.message ?? ""))
  ) return true;
  if (error instanceof TypeError) return false;
  if (FATAL_CODES.has(code)) return false;
  if (FATAL_DATABASE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return false;
  }
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if ([400, 401, 403, 404, 409, 422].includes(status)) return false;
  return true;
}

export function classifyWebReadFreshness({
  generatedAt,
  at = Date.now(),
  intervalMs = 900_000,
}) {
  const updatedAt = Number(generatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "unavailable";
  const ageMs = Math.max(0, at - updatedAt);
  if (ageMs <= intervalMs * 1.5) return "fresh";
  if (ageMs <= intervalMs * 4) return "stale";
  return "very_stale";
}

function readMetadata(current, provider, {
  at,
  intervalMs,
  degraded = false,
  truncated = false,
  observedAt = null,
  observationSource = null,
}) {
  const payload = current?.payload ?? {};
  const lastUpdatedAt = Number(payload.lastUpdatedAt ?? current?.generatedAt ?? 0) || null;
  const normalizedObservedAt = Number(observedAt) > 0 ? Number(observedAt) : null;
  const freshnessReferenceAt = normalizedObservedAt ?? lastUpdatedAt;
  const configuredNext = Number(payload.nextUpdateAt ?? 0);
  const baseNextUpdateAt = normalizedObservedAt !== null
    ? normalizedObservedAt + intervalMs
    : configuredNext > 0
      ? configuredNext
      : lastUpdatedAt === null
        ? null
        : lastUpdatedAt + intervalMs;
  const nextUpdateAt = baseNextUpdateAt === null
    ? null
    : baseNextUpdateAt > at
      ? baseNextUpdateAt
      : baseNextUpdateAt
        + (Math.floor((at - baseNextUpdateAt) / intervalMs) + 1) * intervalMs;
  const freshness = classifyWebReadFreshness({
    generatedAt: freshnessReferenceAt,
    at,
    intervalMs,
  });
  return Object.freeze({
    provider,
    snapshotVersion: Number(current?.snapshotVersion ?? 0) || null,
    checksum: current?.checksum ?? null,
    lastUpdatedAt,
    observedAt: normalizedObservedAt,
    observationSource,
    nextUpdateAt,
    freshness,
    degraded: Boolean(degraded || truncated || freshness !== "fresh"),
    truncated: Boolean(truncated),
  });
}

function providerSyncObservation(snapshot, providerId, { at, intervalMs }) {
  if (!snapshot?.payload || typeof snapshot.payload !== "object") return null;
  if (
    classifyWebReadFreshness({ generatedAt: snapshot.generatedAt, at, intervalMs })
    !== "fresh"
  ) return null;
  const providers = Array.isArray(snapshot.payload.providers)
    ? snapshot.payload.providers
    : [];
  const status = providers.find(
    (item) => String(item?.providerId ?? "").toLowerCase() === providerId,
  );
  if (!status || status.enabled === false) return null;
  if (String(status.status ?? "").toUpperCase() !== "HEALTHY") return null;
  if (String(status.circuit ?? "").toUpperCase() !== "CLOSED") return null;
  if (
    Number(status.pending ?? 0) > 0
    || Number(status.retry ?? 0) > 0
    || Number(status.deadLetter ?? 0) > 0
  ) return null;
  const lastSuccessAt = Number(status.lastSuccessAt ?? 0);
  if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return null;
  const observedAt = Math.min(Number(snapshot.generatedAt), lastSuccessAt);
  if (
    classifyWebReadFreshness({ generatedAt: observedAt, at, intervalMs })
    !== "fresh"
  ) return null;
  return Object.freeze({ observedAt, observationSource: "sync_status" });
}

async function readProviderSyncObservation(provider, providerId, options) {
  try {
    const snapshot = await provider.readSnapshot({
      snapshotType: "sync_status",
      aggregateId: "nuviloview-sync",
    });
    return providerSyncObservation(snapshot, providerId, options);
  } catch {
    // Analytics remains readable as stale when the independent observation
    // snapshot cannot be read. It must never be promoted to fresh in this case.
    return null;
  }
}

function recordRead(providerId, metadata) {
  if (providerId === "supabase") increment("supabaseReads");
  else if (providerId === "turso") increment("tursoFallbackReads");
  else if (providerId === "neon") increment("neonReads");
  if (metadata.freshness !== "fresh") increment("staleReads");
  if (metadata.degraded) increment("degradedResponses");
}

function remember(cacheKey, result) {
  lastKnownGood.set(cacheKey, result);
  if (lastKnownGood.size <= 100) return;
  const firstKey = lastKnownGood.keys().next().value;
  if (firstKey !== undefined) lastKnownGood.delete(firstKey);
}

export function createWebReadRouter({
  registry,
  intervalMs = 900_000,
  priority = WEB_READ_PROVIDER_PRIORITY,
  neonCompatibilityEnabled = false,
  now = () => Date.now(),
  logger = null,
} = {}) {
  if (!registry?.get) throw new TypeError("Provider Registry is required.");
  const allowedPriority = priority.filter(
    (providerId) => providerId !== "neon" || neonCompatibilityEnabled,
  );

  async function readAnalyticsBundle({
    guildId,
    dateFrom,
    dateTo,
    limit = 50_000,
  }) {
    const normalizedGuildId = String(guildId ?? "");
    if (!/^\d{16,22}$/.test(normalizedGuildId)) {
      throw new TypeError("A valid Guild ID is required.");
    }
    const cacheKey = `analytics:${normalizedGuildId}`;
    const normalizedLimit = Math.min(50_000, Math.max(1, Number(limit) || 50_000));
    const at = now();
    let bestStale = null;
    const attempts = [];
    for (const providerId of allowedPriority) {
      const provider = registry.get(providerId);
      if (!provider?.isEnabled?.()) continue;
      attempts.push(providerId);
      try {
        if (typeof provider.listSnapshots !== "function") {
          throw new TypeError(`Provider ${providerId} does not support Projection reads.`);
        }
        const current = await provider.readSnapshot({
          snapshotType: "analytics",
          aggregateId: analyticsCurrentProjectionKey(normalizedGuildId),
        });
        if (!current) continue;
        const snapshots = await provider.listSnapshots({
          snapshotType: "analytics",
          aggregateIdPrefix: `v2:guild:${normalizedGuildId}:`,
          dateFrom,
          dateTo,
          limit: normalizedLimit,
        });
        const truncated = snapshots.length >= normalizedLimit;
        let metadata = readMetadata(current, providerId, {
          at,
          intervalMs,
          truncated,
        });
        if (metadata.freshness !== "fresh") {
          const observation = await readProviderSyncObservation(
            provider,
            providerId,
            { at, intervalMs },
          );
          if (observation) {
            metadata = readMetadata(current, providerId, {
              at,
              intervalMs,
              truncated,
              ...observation,
            });
          }
        }
        const result = Object.freeze({
          available: true,
          current,
          snapshots: Object.freeze(snapshots),
          metadata,
          attempts: Object.freeze([...attempts]),
        });
        if (metadata.freshness === "fresh") {
          recordRead(providerId, metadata);
          remember(cacheKey, result);
          return result;
        }
        if (
          !bestStale
          || Number(current.generatedAt) > Number(bestStale.current.generatedAt)
        ) {
          bestStale = result;
        }
      } catch (error) {
        increment("readFailures");
        logProviderFallback(logger, providerId, "analytics", error);
        if (!isWebReadFallbackError(error)) throw error;
      }
    }
    if (bestStale) {
      recordRead(bestStale.metadata.provider, bestStale.metadata);
      remember(cacheKey, bestStale);
      return bestStale;
    }
    increment("degradedResponses");
    const cached = lastKnownGood.get(cacheKey) ?? null;
    return Object.freeze({
      available: false,
      current: cached?.current ?? null,
      snapshots: cached?.snapshots ?? Object.freeze([]),
      metadata: cached
        ? Object.freeze({ ...cached.metadata, freshness: "very_stale", degraded: true })
        : Object.freeze({
            provider: null,
            snapshotVersion: null,
            checksum: null,
            lastUpdatedAt: null,
            observedAt: null,
            observationSource: null,
            nextUpdateAt: null,
            freshness: "unavailable",
            degraded: true,
            truncated: false,
          }),
      attempts: Object.freeze([...attempts]),
    });
  }

  async function readSnapshot({ snapshotType, aggregateId }) {
    const at = now();
    const cacheKey = `snapshot:${String(snapshotType)}:${String(aggregateId)}`;
    const attempts = [];
    let bestStale = null;
    for (const providerId of allowedPriority) {
      const provider = registry.get(providerId);
      if (!provider?.isEnabled?.()) continue;
      attempts.push(providerId);
      try {
        const current = await provider.readSnapshot({ snapshotType, aggregateId });
        if (!current) continue;
        let metadata = readMetadata(current, providerId, { at, intervalMs });
        if (snapshotType === "analytics" && metadata.freshness !== "fresh") {
          const observation = await readProviderSyncObservation(
            provider,
            providerId,
            { at, intervalMs },
          );
          if (observation) {
            metadata = readMetadata(current, providerId, {
              at,
              intervalMs,
              ...observation,
            });
          }
        }
        const result = { available: true, snapshot: current, metadata, attempts };
        if (metadata.freshness === "fresh") {
          recordRead(providerId, metadata);
          remember(cacheKey, result);
          return result;
        }
        if (!bestStale || current.generatedAt > bestStale.snapshot.generatedAt) {
          bestStale = result;
        }
      } catch (error) {
        increment("readFailures");
        logProviderFallback(logger, providerId, "snapshot", error);
        if (!isWebReadFallbackError(error)) throw error;
      }
    }
    if (bestStale) {
      recordRead(bestStale.metadata.provider, bestStale.metadata);
      remember(cacheKey, bestStale);
      return bestStale;
    }
    increment("degradedResponses");
    const cached = lastKnownGood.get(cacheKey) ?? null;
    if (cached) {
      return {
        available: false,
        snapshot: cached.snapshot,
        metadata: Object.freeze({
          ...cached.metadata,
          freshness: "very_stale",
          degraded: true,
        }),
        attempts,
      };
    }
    return {
      available: false,
      snapshot: null,
      metadata: readMetadata(null, null, { at, intervalMs, degraded: true }),
      attempts,
    };
  }

  function readGuildCurrent(guildId) {
    return readSnapshot({
      snapshotType: "analytics",
      aggregateId: analyticsCurrentProjectionKey(guildId),
    });
  }

  function readGuildDaily(guildId, dateUtc) {
    return readSnapshot({
      snapshotType: "analytics",
      aggregateId: analyticsProjectionKey({
        kind: "guild_daily",
        guildId,
        dateUtc,
      }),
    });
  }

  function readChannelDaily(guildId, channelId, dateUtc) {
    return readSnapshot({
      snapshotType: "analytics",
      aggregateId: analyticsProjectionKey({
        kind: "channel_daily",
        guildId,
        channelId,
        dateUtc,
      }),
    });
  }

  function readUserDaily(guildId, userId, dateUtc) {
    return readSnapshot({
      snapshotType: "analytics",
      aggregateId: analyticsProjectionKey({
        kind: "user_daily",
        guildId,
        userId,
        dateUtc,
      }),
    });
  }

  function readRuntimeSnapshot() {
    return readSnapshot({
      snapshotType: "runtime",
      aggregateId: "nuviloview-bot",
    });
  }

  function readSyncStatusSnapshot() {
    return readSnapshot({
      snapshotType: "sync_status",
      aggregateId: "nuviloview-sync",
    });
  }

  return Object.freeze({
    readAnalyticsBundle,
    readSnapshot,
    readGuildCurrent,
    readGuildDaily,
    readChannelDaily,
    readUserDaily,
    readRuntimeSnapshot,
    readSyncStatusSnapshot,
    getMetrics: cloneMetrics,
    priority: Object.freeze([...allowedPriority]),
  });
}

export function getWebReadMetrics() {
  return cloneMetrics();
}

export function resetWebReadMetricsForTests() {
  for (const key of Object.keys(metricsState)) metricsState[key] = 0;
  lastKnownGood.clear();
}
