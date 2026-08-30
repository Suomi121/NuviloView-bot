export const DEFAULT_ANALYTICS_REFRESH_INTERVAL_MS = 15 * 60_000;
export const MINIMUM_ANALYTICS_REFRESH_INTERVAL_MS = 60_000;
export const MAXIMUM_ANALYTICS_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

const FRESHNESS_VALUES = new Set([
  "fresh",
  "stale",
  "very_stale",
  "unavailable",
]);

const metricsState = globalThis.__nuviloAnalyticsRefreshMetrics ??= {
  analytics_fetches: 0,
  countdown_refetches: 0,
  visibility_refetches: 0,
};

function finiteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function positiveTimestamp(value) {
  const normalized = finiteNumber(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function normalizeAnalyticsRefreshIntervalMs(intervalMs) {
  return Math.min(
    MAXIMUM_ANALYTICS_REFRESH_INTERVAL_MS,
    Math.max(
      MINIMUM_ANALYTICS_REFRESH_INTERVAL_MS,
      finiteNumber(intervalMs) ?? DEFAULT_ANALYTICS_REFRESH_INTERVAL_MS,
    ),
  );
}

export function getAnalyticsRefreshIntervalMs(env = {}) {
  const seconds = Number(env?.ANALYTICS_SNAPSHOT_INTERVAL_SECONDS ?? 900);
  if (!Number.isSafeInteger(seconds)) return DEFAULT_ANALYTICS_REFRESH_INTERVAL_MS;
  return Math.min(
    MAXIMUM_ANALYTICS_REFRESH_INTERVAL_MS,
    Math.max(MINIMUM_ANALYTICS_REFRESH_INTERVAL_MS, seconds * 1_000),
  );
}

export function getNextAnalyticsRefreshBoundary(
  at = Date.now(),
  intervalMs = DEFAULT_ANALYTICS_REFRESH_INTERVAL_MS,
) {
  const normalizedAt = Math.max(0, finiteNumber(at) ?? Date.now());
  const normalizedIntervalMs = normalizeAnalyticsRefreshIntervalMs(intervalMs);
  return (Math.floor(normalizedAt / normalizedIntervalMs) + 1)
    * normalizedIntervalMs;
}

export function createAnalyticsRefreshContract(
  metadata,
  {
    at = Date.now(),
    intervalMs = DEFAULT_ANALYTICS_REFRESH_INTERVAL_MS,
  } = {},
) {
  const normalizedAt = Math.max(0, finiteNumber(at) ?? Date.now());
  const normalizedIntervalMs = normalizeAnalyticsRefreshIntervalMs(intervalMs);
  const lastUpdatedAt = positiveTimestamp(
    metadata?.lastUpdatedAt ?? metadata?.last_updated_at,
  );
  // Refresh deadlines are wall-clock boundaries, not request-relative leases.
  // Projection freshness remains independent from this display/fetch schedule.
  const nextUpdateAt = getNextAnalyticsRefreshBoundary(
    normalizedAt,
    normalizedIntervalMs,
  );
  const snapshotVersion = finiteNumber(
    metadata?.snapshotVersion ?? metadata?.snapshot_version,
  );
  const freshnessCandidate = String(metadata?.freshness ?? "unavailable");
  return Object.freeze({
    server_time: normalizedAt,
    last_updated_at: lastUpdatedAt,
    next_update_at: nextUpdateAt,
    snapshot_version:
      snapshotVersion !== null && snapshotVersion > 0
        ? Math.trunc(snapshotVersion)
        : null,
    checksum:
      typeof metadata?.checksum === "string" && metadata.checksum.length > 0
        ? metadata.checksum
        : null,
    freshness: FRESHNESS_VALUES.has(freshnessCandidate)
      ? freshnessCandidate
      : "unavailable",
    interval_ms: normalizedIntervalMs,
  });
}

export function toAnalyticsRefreshSchedule(value, { at = Date.now() } = {}) {
  if (!value || typeof value !== "object") return null;
  const requestedInterval = finiteNumber(value.interval_ms ?? value.intervalMs);
  const intervalMs = normalizeAnalyticsRefreshIntervalMs(requestedInterval);
  const serverTime = positiveTimestamp(
    value.server_time ?? value.serverTime,
  ) ?? Math.max(0, finiteNumber(at) ?? Date.now());
  const nextUpdateAt = positiveTimestamp(
    value.next_update_at ?? value.nextUpdateAt,
  ) ?? getNextAnalyticsRefreshBoundary(serverTime, intervalMs);
  const snapshotVersion = finiteNumber(
    value.snapshot_version ?? value.snapshotVersion,
  );
  const freshnessCandidate = String(value.freshness ?? "unavailable");
  return Object.freeze({
    serverTime,
    lastUpdatedAt: positiveTimestamp(
      value.last_updated_at ?? value.lastUpdatedAt,
    ) ?? 0,
    nextUpdateAt,
    snapshotVersion:
      snapshotVersion !== null && snapshotVersion > 0
        ? Math.trunc(snapshotVersion)
        : null,
    checksum:
      typeof value.checksum === "string" && value.checksum.length > 0
        ? value.checksum
        : null,
    freshness: FRESHNESS_VALUES.has(freshnessCandidate)
      ? freshnessCandidate
      : "unavailable",
    intervalMs,
  });
}

export function recordAnalyticsFetch(reason = "initial") {
  metricsState.analytics_fetches += 1;
  if (reason === "countdown") metricsState.countdown_refetches += 1;
  if (reason === "visibility") metricsState.visibility_refetches += 1;
  return getAnalyticsRefreshMetrics();
}

export function getAnalyticsRefreshMetrics() {
  return Object.freeze({ ...metricsState });
}

export function resetAnalyticsRefreshMetricsForTests() {
  metricsState.analytics_fetches = 0;
  metricsState.countdown_refetches = 0;
  metricsState.visibility_refetches = 0;
}

export function isAnalyticsRefreshDue({
  at = Date.now(),
  nextUpdateAt,
  inFlight = false,
  lastRequestedNextUpdateAt = null,
} = {}) {
  const deadline = positiveTimestamp(nextUpdateAt);
  return Boolean(
    deadline !== null
    && at >= deadline
    && !inFlight
    && lastRequestedNextUpdateAt !== deadline,
  );
}
