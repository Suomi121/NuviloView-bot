import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildMessageCanarySnapshot,
  compareMessageCanarySnapshots,
  evaluateMessageCanaryHealth,
  getMessageCanaryConfig,
} from "../lib/message-canary.mjs";
import {
  checkMessageReplicaSchema,
  fetchMessageReplicaComparison,
} from "../lib/message-canary-postgres.mjs";
import {
  createLocalStorage,
  getLocalStorageConfig,
} from "../lib/storage/index.mjs";
import {
  analyticsCurrentProjectionKey,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";
import {
  loadWorkerSnapshot,
  printJson,
  withReadonlyMessageReplica,
} from "./message-canary-cli-utils.mjs";

export async function checkMessageCanary({
  env = process.env,
  cwd = process.cwd(),
  compare = false,
  now = () => Date.now(),
} = {}) {
  const config = getMessageCanaryConfig(env);
  const compaction = getAnalyticsCompactionConfig(env);
  const localConfig = getLocalStorageConfig(env, { cwd });
  if (!existsSync(localConfig.databasePath)) {
    return {
      health: { status: "ABORT", warnings: [], abort: ["sqlite_database_missing"] },
      databasePath: localConfig.databasePath,
      snapshot: null,
    };
  }
  const storage = createLocalStorage({
    databasePath: localConfig.databasePath,
    readOnly: true,
    writeEnabled: false,
    now,
  });
  try {
    const worker = loadWorkerSnapshot(env, { cwd });
    let replicaSchema = null;
    let comparisons = [];
    const projectionMode = config.allGuildsEnabled
      ? compaction.allGuildsEnabled
      : config.guildIds.length > 0 &&
        config.guildIds.every((guildId) => compaction.isEnabledForGuild(guildId));
    if (projectionMode) {
      comparisons = config.guildIds.map((guildId) => {
        const local = storage.messageDomain.getComparisonSnapshot(guildId);
        const projection = storage.snapshots.get(
          "analytics",
          analyticsCurrentProjectionKey(guildId),
        );
        return {
          guildId,
          local,
          projection: projection
            ? {
                snapshotVersion: projection.snapshotVersion,
                checksum: projection.checksum,
                messageCount: projection.payload?.messageCount ?? null,
              }
            : null,
          matched:
            projection !== null &&
            Number(projection.payload?.messageCount) === Number(local.createCount),
        };
      });
      replicaSchema = {
        ready: comparisons.every((item) => item.projection !== null),
        mode: "analytics_projection_v2",
      };
    } else {
      const replica = await withReadonlyMessageReplica(env, async (execute) => {
        replicaSchema = await checkMessageReplicaSchema(execute);
        if (!compare) return null;
        for (const guildId of config.guildIds) {
          const local = storage.messageDomain.getComparisonSnapshot(guildId);
          const remote = await fetchMessageReplicaComparison(execute, guildId);
          comparisons.push({
            guildId,
            local,
            replica: remote,
            ...compareMessageCanarySnapshots(local, remote),
          });
        }
        return true;
      });
      if (!replica.available) {
        replicaSchema = { ready: false, reason: "read_only_replica_url_missing" };
      }
    }
    const comparison = compare
      ? {
          matched: comparisons.every((item) => item.matched),
          guilds: comparisons,
        }
      : null;
    const snapshot = buildMessageCanarySnapshot({
      config,
      storage,
      workerSnapshot: worker.snapshot,
      replicaSchema,
      comparison,
      configuredWriteEnabled: localConfig.writeEnabled,
      now,
    });
    const baseline = storage.syncMetadata.get("message_canary_baseline")?.metadata ?? {};
    const health = evaluateMessageCanaryHealth(snapshot, config, { baseline, now });
    return { health, baseline, workerSnapshotPath: worker.path, snapshot };
  } finally {
    storage.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  checkMessageCanary({ compare: process.argv.includes("--compare") })
    .then((result) => {
      printJson(result);
      if (result.health.status === "ABORT") process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[message-canary] ${String(error?.message ?? error)}`);
      process.exitCode = 1;
    });
}
