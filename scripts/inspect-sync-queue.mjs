import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createLocalStorage,
  getLocalStorageConfig,
} from "../lib/storage/index.mjs";

export function inspectSyncQueue({ env = process.env, cwd = process.cwd() } = {}) {
  const config = getLocalStorageConfig(env, { cwd });
  if (!existsSync(config.databasePath)) {
    throw new Error("The configured local SQLite database does not exist.");
  }
  const storage = createLocalStorage({
    databasePath: config.databasePath,
    writeEnabled: false,
    readOnly: true,
  });
  try {
    const counts = storage.outbox.getStatusCounts();
    const circuit = storage.syncMetadata.get("circuit_breaker");
    const metrics = storage.syncMetadata.get("sync_worker_metrics");
    const size = storage.health.getStorageSize();
    let providers = [];
    let cloudComplete = null;
    try {
      providers = storage.providerDeliveries.getAllProviderStatus();
      cloudComplete = storage.providerDeliveries.getCloudCompletionSummary();
    } catch {
      // A pre-v4 read-only database remains inspectable through legacy fields.
    }
    return {
      databasePath: config.databasePath,
      pending: counts.pending,
      retry: counts.retry,
      processing: counts.processing,
      synced: counts.synced,
      deadLetter: storage.outbox.getDeadLetterCount(),
      circuit: circuit?.metadata ?? { state: "CLOSED" },
      lastSuccess: metrics?.lastSuccessAt ?? null,
      oldestPendingAgeMs: storage.outbox.getOldestPendingAge(),
      databaseBytes: size.databaseBytes,
      walBytes: size.walBytes,
      totalBytes: size.totalBytes,
      providers,
      cloudComplete,
    };
  } finally {
    storage.close();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(inspectSyncQueue(), null, 2));
  } catch (error) {
    console.error(`[sync-inspect] ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}
