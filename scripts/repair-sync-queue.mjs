import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createLocalStorage,
  createStorage,
  getLocalStorageConfig,
} from "../lib/storage/index.mjs";
import { getSyncWorkerConfig } from "../lib/sync/worker.mjs";

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : null;
}

export function getRepairRequest(argumentsList) {
  const execute = argumentsList.includes("--execute");
  const releaseStale = argumentsList.includes("--release-stale");
  const requeueEventId = argumentValue(argumentsList, "--requeue");
  const inspectEventId = argumentValue(argumentsList, "--inspect-dead-letter");
  const actionCount = Number(releaseStale) + Number(Boolean(requeueEventId)) + Number(Boolean(inspectEventId));
  if (actionCount !== 1) {
    throw new Error(
      "Choose exactly one: --inspect-dead-letter EVENT_ID, --release-stale --execute, or --requeue EVENT_ID --execute.",
    );
  }
  if ((releaseStale || requeueEventId) && !execute) {
    throw new Error("Queue mutation requires the explicit --execute flag.");
  }
  if (inspectEventId && execute) {
    throw new Error("Dead Letter inspection is read-only and does not accept --execute.");
  }
  return { execute, releaseStale, requeueEventId, inspectEventId };
}

export function repairSyncQueue({
  argumentsList = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const request = getRepairRequest(argumentsList);
  const localConfig = getLocalStorageConfig(env, { cwd });
  if (!existsSync(localConfig.databasePath)) {
    throw new Error("The configured local SQLite database does not exist.");
  }

  if (request.inspectEventId) {
    const storage = createLocalStorage({
      databasePath: localConfig.databasePath,
      writeEnabled: false,
      readOnly: true,
    });
    try {
      return {
        action: "inspect",
        deadLetter: storage.outbox.getDeadLetter(request.inspectEventId),
      };
    } finally {
      storage.close();
    }
  }

  const storage = createStorage({ env, cwd });
  if (!storage.enabled || !storage.writeEnabled) {
    storage.close();
    throw new Error(
      "LOCAL_STORAGE_ENABLED and LOCAL_STORAGE_WRITE_ENABLED must both be true for repair actions.",
    );
  }
  try {
    if (request.releaseStale) {
      const syncConfig = getSyncWorkerConfig(env, { cwd });
      return {
        action: "release-stale",
        released: storage.outbox.releaseExpiredLocks({
          lockTimeoutMs: syncConfig.lockTimeoutMs,
        }),
      };
    }
    const requeued = storage.outbox.requeueDeadLetter(request.requeueEventId);
    if (!requeued) throw new Error("The requested Dead Letter event was not found.");
    return { action: "requeue", eventId: requeued.eventId, status: requeued.status };
  } finally {
    storage.close();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    console.log(JSON.stringify(repairSyncQueue(), null, 2));
  } catch (error) {
    console.error(`[sync-repair] ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}
