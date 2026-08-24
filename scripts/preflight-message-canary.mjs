import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildMessageCanarySnapshot,
  evaluateMessageCanaryHealth,
  getMessageCanaryConfig,
  probeMessageOutboxWritable,
} from "../lib/message-canary.mjs";
import { checkMessageReplicaSchema } from "../lib/message-canary-postgres.mjs";
import {
  createLocalStorage,
  getLocalStorageConfig,
} from "../lib/storage/index.mjs";
import {
  loadWorkerSnapshot,
  printJson,
  withReadonlyMessageReplica,
} from "./message-canary-cli-utils.mjs";

export async function preflightMessageCanary({
  env = process.env,
  cwd = process.cwd(),
  requireArmed = false,
  now = () => Date.now(),
} = {}) {
  const config = getMessageCanaryConfig(env);
  const localConfig = getLocalStorageConfig(env, { cwd });
  if (!existsSync(localConfig.databasePath)) {
    return {
      result: "FAIL",
      health: { status: "ABORT", warnings: [], abort: ["sqlite_database_missing"] },
      snapshot: null,
    };
  }
  const storage = createLocalStorage({
    databasePath: localConfig.databasePath,
    writeEnabled: localConfig.writeEnabled,
    now,
  });
  try {
    let outboxWritable = false;
    try {
      outboxWritable = probeMessageOutboxWritable(storage, { now });
    } catch {
      outboxWritable = false;
    }
    const worker = loadWorkerSnapshot(env, { cwd });
    let replicaSchema = { ready: false, reason: "read_only_replica_url_missing" };
    const replica = await withReadonlyMessageReplica(env, async (execute) => {
      replicaSchema = await checkMessageReplicaSchema(execute);
      return replicaSchema;
    });
    if (!replica.available) {
      replicaSchema = { ready: false, reason: "read_only_replica_url_missing" };
    }
    const snapshot = buildMessageCanarySnapshot({
      config,
      storage,
      workerSnapshot: worker.snapshot,
      replicaSchema,
      outboxWritable,
      configuredWriteEnabled: localConfig.writeEnabled,
      now,
    });
    const health = evaluateMessageCanaryHealth(snapshot, config, {
      requireArmed,
      now,
    });
    return {
      result: health.status === "HEALTHY" ? "PASS" : health.status === "DEGRADED" ? "WARN" : "FAIL",
      health,
      workerSnapshotPath: worker.path,
      snapshot,
    };
  } finally {
    storage.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  preflightMessageCanary({ requireArmed: process.argv.includes("--require-armed") })
    .then((result) => {
      printJson(result);
      if (result.result === "FAIL") process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[message-canary-preflight] ${String(error?.message ?? error)}`);
      process.exitCode = 1;
    });
}
