import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeSyncError } from "./retry.mjs";

export class SyncMetrics {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.workerStatus = "OFFLINE";
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastSyncAttempt = null;
    this.lastSyncSuccess = null;
    this.lastSyncFailure = null;
    this.lastError = null;
    this.syncedEventsTotal = 0;
    this.failedEventsTotal = 0;
    this.currentBatchSize = 0;
    this.replicaBatchQueryCount = 0;
  }

  start() {
    this.workerStatus = "RUNNING";
    this.startedAt = this.now();
    this.stoppedAt = null;
  }

  beginAttempt(batchSize) {
    this.lastSyncAttempt = this.now();
    this.currentBatchSize = batchSize;
    this.replicaBatchQueryCount += 1;
  }

  success(count) {
    this.lastSyncSuccess = this.now();
    this.syncedEventsTotal += Number(count) || 0;
    this.lastError = null;
  }

  failure(count, error) {
    this.lastSyncFailure = this.now();
    this.failedEventsTotal += Number(count) || 0;
    this.lastError = sanitizeSyncError(error);
  }

  stopping() {
    this.workerStatus = "STOPPING";
  }

  stop() {
    this.workerStatus = "OFFLINE";
    this.stoppedAt = this.now();
    this.currentBatchSize = 0;
  }

  snapshot({ circuit, guards, configuredBatchSize }) {
    const circuitSnapshot = circuit.getSnapshot();
    const neonStatus =
      circuitSnapshot.state === "OPEN"
        ? "UNAVAILABLE"
        : this.lastSyncSuccess !== null &&
            (this.lastSyncFailure === null || this.lastSyncSuccess >= this.lastSyncFailure)
          ? "AVAILABLE"
          : this.lastSyncFailure !== null
            ? "UNAVAILABLE"
            : "UNKNOWN";
    const health =
      guards.status === "CRITICAL"
        ? "CRITICAL"
        : this.workerStatus === "OFFLINE"
          ? "OFFLINE"
          : circuitSnapshot.state === "OPEN" || guards.status === "DEGRADED"
            ? "DEGRADED"
            : "HEALTHY";
    return {
      schemaVersion: 1,
      generatedAt: this.now(),
      workerStatus: this.workerStatus,
      workerHealth: health,
      neonStatus,
      circuitState: circuitSnapshot.state,
      circuit: circuitSnapshot,
      pendingCount: guards.pendingCount,
      retryCount: guards.retryCount,
      processingCount: guards.processingCount,
      deadLetterCount: guards.deadLetterCount,
      oldestPendingAgeMs: guards.oldestPendingAgeMs,
      lastSyncAttempt: this.lastSyncAttempt,
      lastSyncSuccess: this.lastSyncSuccess,
      lastSyncFailure: this.lastSyncFailure,
      lastError: this.lastError,
      syncedEventsTotal: this.syncedEventsTotal,
      failedEventsTotal: this.failedEventsTotal,
      currentBatchSize: this.currentBatchSize || configuredBatchSize,
      replicaBatchQueryCount: this.replicaBatchQueryCount,
      circuitOpenCount: Number(circuitSnapshot.openCount ?? 0),
      sqliteSizeBytes: guards.sqliteSizeBytes,
      sqliteTotalBytes: guards.sqliteTotalBytes,
      walSizeBytes: guards.walSizeBytes,
      diskFreeBytes: guards.diskFreeBytes,
      warnings: guards.warnings,
      critical: guards.critical,
      integrity: guards.integrity,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
    };
  }
}

export async function writeSyncMetricsSnapshot(snapshotPath, snapshot) {
  if (!snapshotPath) return;
  await mkdir(dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, snapshotPath);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await rm(snapshotPath, { force: true });
    await rename(temporaryPath, snapshotPath);
  }
}
