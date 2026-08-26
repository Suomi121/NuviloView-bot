import { statfsSync } from "node:fs";
import { dirname } from "node:path";

function multiplySafely(left, right) {
  const value = BigInt(left) * BigInt(right);
  return value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
}

export function getDiskFreeBytes(databasePath) {
  if (!databasePath || databasePath === ":memory:") return null;
  try {
    const stats = statfsSync(dirname(databasePath), { bigint: true });
    return multiplySafely(stats.bavail, stats.bsize);
  } catch {
    return null;
  }
}

export function evaluateSyncGuards({
  outbox,
  storage,
  integrity = null,
  thresholds,
  at = Date.now(),
}) {
  const counts = outbox.getStatusCounts();
  const pendingCount = counts.pending + counts.retry + counts.processing;
  const deadLetterCount = outbox.getDeadLetterCount();
  const oldestPendingAgeMs = outbox.getOldestPendingAge({ at });
  const size = storage.health.getStorageSize();
  const databasePath = storage.health.getDatabasePath();
  const diskFreeBytes = getDiskFreeBytes(databasePath);
  const warnings = [];
  const critical = [];

  if (integrity && !integrity.ok) critical.push("sqlite_integrity_failed");
  if (pendingCount >= thresholds.queueCriticalCount) critical.push("queue_count_critical");
  else if (pendingCount >= thresholds.queueWarnCount) warnings.push("queue_count_warning");

  if (size.totalBytes >= thresholds.sqliteCriticalBytes) critical.push("sqlite_size_critical");
  else if (size.totalBytes >= thresholds.sqliteWarnBytes) warnings.push("sqlite_size_warning");

  if (size.walBytes >= thresholds.walCriticalBytes) critical.push("wal_size_critical");
  else if (size.walBytes >= thresholds.walWarnBytes) warnings.push("wal_size_warning");

  if (diskFreeBytes !== null && diskFreeBytes <= thresholds.diskFreeCriticalBytes) {
    critical.push("disk_free_critical");
  } else if (diskFreeBytes !== null && diskFreeBytes <= thresholds.diskFreeWarnBytes) {
    warnings.push("disk_free_warning");
  }

  if (
    oldestPendingAgeMs !== null &&
    oldestPendingAgeMs >= thresholds.oldestPendingCriticalMs
  ) {
    critical.push("oldest_pending_critical");
  } else if (
    oldestPendingAgeMs !== null &&
    oldestPendingAgeMs >= thresholds.oldestPendingWarnMs
  ) {
    warnings.push("oldest_pending_warning");
  }

  if (deadLetterCount > 0) warnings.push("dead_letter_present");

  return {
    status: critical.length > 0 ? "CRITICAL" : warnings.length > 0 ? "DEGRADED" : "HEALTHY",
    warnings,
    critical,
    pendingCount,
    retryCount: counts.retry,
    processingCount: counts.processing,
    deadLetterCount,
    oldestPendingAgeMs,
    sqliteSizeBytes: size.databaseBytes,
    sqliteTotalBytes: size.totalBytes,
    walSizeBytes: size.walBytes,
    diskFreeBytes,
    integrity,
  };
}
