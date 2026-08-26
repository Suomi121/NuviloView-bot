import { pathToFileURL } from "node:url";
import { getLocalStorageConfig, createLocalStorage } from "../lib/storage/index.mjs";
import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { assertProviderId } from "../lib/sync/providers/contract.mjs";
import { createProviderRegistry } from "../lib/sync/providers/registry.mjs";
import { sanitizeSyncError } from "../lib/sync/retry.mjs";

function parseArguments(argv) {
  const providerValue = argv.find((value) => value.startsWith("--provider="));
  const limitValue = argv.find((value) => value.startsWith("--limit="));
  const providerId = assertProviderId(providerValue?.slice("--provider=".length));
  const limit = limitValue ? Number(limitValue.slice("--limit=".length)) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError("--limit must be between 1 and 10000.");
  }
  return { providerId, limit };
}

function providerEnv(providerId, env) {
  return {
    ...env,
    MULTI_DB_SYNC_ENABLED: "true",
    SYNC_SUPABASE_ENABLED: providerId === "supabase" ? "true" : "false",
    SYNC_TURSO_ENABLED: providerId === "turso" ? "true" : "false",
    SYNC_NEON_ENABLED: providerId === "neon" ? "true" : "false",
  };
}

export async function reconcileProvider({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  logger = console,
} = {}) {
  const { providerId, limit } = parseArguments(argv);
  const storageConfig = getLocalStorageConfig(env, { cwd });
  const storage = createLocalStorage({
    databasePath: storageConfig.databasePath,
    writeEnabled: false,
    readOnly: true,
  });
  const config = getMultiDbSyncConfig(providerEnv(providerId, env), { cwd });
  const registry = await createProviderRegistry({ config, logger });
  try {
    const provider = registry.get(providerId);
    if (!provider) throw new Error(`${providerId} is not configured for reconciliation.`);
    const schema = await provider.verifySchema();
    if (!schema.ok) {
      return { providerId, schema, checked: 0, missing: [], mismatched: [] };
    }
    const local = storage.outbox.listForReconciliation({ limit });
    const remoteChecksums = await provider.getEventChecksums(
      local.map((item) => item.eventId),
    );
    const missing = local
      .filter((item) => !remoteChecksums.has(item.eventId))
      .map((item) => item.eventId);
    const mismatched = local
      .filter(
        (item) =>
          remoteChecksums.has(item.eventId) &&
          remoteChecksums.get(item.eventId) !== item.checksum,
      )
      .map((item) => item.eventId);
    const localSnapshots = storage.snapshots.listForReconciliation({ limit });
    const remoteSnapshots = await provider.getSnapshotStates(localSnapshots);
    const snapshotMissing = localSnapshots
      .filter(
        (item) => !remoteSnapshots.has(`${item.snapshotType}:${item.aggregateId}`),
      )
      .map((item) => `${item.snapshotType}:${item.aggregateId}`);
    const snapshotMismatched = localSnapshots
      .filter((item) => {
        const remote = remoteSnapshots.get(`${item.snapshotType}:${item.aggregateId}`);
        return Boolean(
          remote &&
            (remote.snapshotVersion !== item.snapshotVersion ||
              remote.checksum !== item.checksum),
        );
      })
      .map((item) => ({
        key: `${item.snapshotType}:${item.aggregateId}`,
        localVersion: item.snapshotVersion,
        remoteVersion: remoteSnapshots.get(`${item.snapshotType}:${item.aggregateId}`)
          ?.snapshotVersion,
      }));
    return {
      providerId,
      mode: "read_only",
      schema,
      cursor: await provider.getRemoteCursor(),
      checked: local.length,
      missing,
      mismatched,
      match: local.length - missing.length - mismatched.length,
      snapshotChecked: localSnapshots.length,
      snapshotMissing,
      snapshotMismatched,
      snapshotMatch:
        localSnapshots.length - snapshotMissing.length - snapshotMismatched.length,
    };
  } finally {
    await registry.close();
    storage.close();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  reconcileProvider()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`[reconcile-provider] ${sanitizeSyncError(error)}`);
      process.exitCode = 1;
    });
}
