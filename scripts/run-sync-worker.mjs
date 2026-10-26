import { pathToFileURL } from "node:url";
import { createSecurityCoordinatorRuntime } from '../lib/multi-db/runtime.mjs';
import { createQuorumReconciler } from '../lib/multi-db/reconciler.mjs';
import { createApplicationPublisher } from '../lib/multi-db/application-worker.mjs';
import { createApplicationRepairer } from '../lib/multi-db/application-repair.mjs';
import { validateApplicationConfiguration } from '../lib/multi-db/application-config.mjs';
import { installWorkerCrashDiagnostics } from "../lib/sync/worker-diagnostics.mjs";
import { Pool } from "pg";
import { createStorage } from "../lib/storage/index.mjs";
import { createNeonReplicaAdapter } from "../lib/sync/neon-replica.mjs";
import { getMultiDbSyncConfig, validateMultiDbRuntimeConfig } from "../lib/sync/multi-config.mjs";
import { MultiProviderSyncWorker } from "../lib/sync/multi-worker.mjs";
import { createProviderRegistry } from "../lib/sync/providers/registry.mjs";
import { sanitizeSyncError } from "../lib/sync/retry.mjs";
import { getSyncWorkerConfig, SyncWorker } from "../lib/sync/worker.mjs";

export async function runSyncWorker({ env = process.env, logger = console } = {}) {
  const multiConfig = getMultiDbSyncConfig(env);
  const config = getSyncWorkerConfig(env);
  if (!config.enabled) {
    logger.info("Sync Worker is disabled. No SQLite or Cloud connection was opened.");
    return { started: false, reason: "disabled" };
  }
  validateApplicationConfiguration(env,{role:'worker'});
  if (multiConfig.enabled) {
    const validation = validateMultiDbRuntimeConfig(multiConfig);
    if (!validation.ok) {
      logger.warn?.(
        `[multi-sync] Starting degraded; configuration warnings: ${validation.errors.join(", ")}.`,
      );
    }
    const storage = createStorage({ env });
    if (!storage.enabled || !storage.writeEnabled) {
      storage.close();
      throw new Error(
        "LOCAL_STORAGE_ENABLED and LOCAL_STORAGE_WRITE_ENABLED must both be true for the Sync Worker.",
      );
    }
    const registry = await createProviderRegistry({ config: multiConfig, logger });
    const quorumRuntime = await createSecurityCoordinatorRuntime(env, { storage });
    const worker = new MultiProviderSyncWorker({
      storage,
      registry,
      config: multiConfig,
      logger,
      quorumReconciler: quorumRuntime ? createQuorumReconciler({ coordinator: quorumRuntime.coordinator }) : null,
      applicationPublisher: env.APPLICATION_DATA_MODE === 'quorum' && quorumRuntime ? createApplicationPublisher({ runtime: quorumRuntime, storage,
        applicationId: env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID, publisherId: env.APPLICATION_PUBLISHER_ID, sourceEpoch: env.APPLICATION_SOURCE_EPOCH }) : null,
      applicationRepairer: env.APPLICATION_DATA_MODE === 'quorum' && quorumRuntime ? createApplicationRepairer({ ...quorumRuntime, controlId:env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID,
        key:/^[a-f0-9]{64}$/.test(env.APPLICATION_DATA_ENCRYPTION_KEY??'')?Buffer.from(env.APPLICATION_DATA_ENCRYPTION_KEY,'hex'):null,keyId:env.APPLICATION_DATA_ENCRYPTION_KEY_ID }) : null,
    });
    const onSignal = (signal) => {
      logger.info(`Multi-DB Sync Worker received ${signal}; finishing active batches.`);
      void worker.stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await worker.run();
      return { started: true, reason: "stopped", mode: "multi-db" };
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      await registry.close();
      await quorumRuntime?.close();
      storage.close();
    }
  }
  if (!config.replicaEnabled) {
    throw new Error("SYNC_NEON_REPLICA_ENABLED must be true to start the Sync Worker.");
  }
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required only when the Sync Worker is enabled.");
  }

  const storage = createStorage({ env });
  if (!storage.enabled || !storage.writeEnabled) {
    storage.close();
    throw new Error(
      "LOCAL_STORAGE_ENABLED and LOCAL_STORAGE_WRITE_ENABLED must both be true for the Sync Worker.",
    );
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: config.queryTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.queryTimeoutMs,
    application_name: "nuviloview-sync-worker",
  });
  const replica = createNeonReplicaAdapter({
    execute: (text, parameters) => pool.query(text, parameters),
    close: () => pool.end(),
  });
  const worker = new SyncWorker({ storage, replica, config, logger });
  const onSignal = (signal) => {
    logger.info(`Sync Worker received ${signal}; finishing the active batch.`);
    void worker.stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await worker.run();
    return { started: true, reason: "stopped" };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await replica.close();
    storage.close();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  installWorkerCrashDiagnostics();
  runSyncWorker().catch((error) => {
    console.error(`[sync-worker] ${sanitizeSyncError(error)}`);
    process.exitCode = 1;
  });
}
