import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createStorage, getLocalStorageConfig } from "../lib/storage/index.mjs";

const projectRoot = resolve(process.argv[2] || process.cwd());
const config = getLocalStorageConfig(process.env, { cwd: projectRoot });

if (!config.enabled) {
  process.stdout.write(JSON.stringify({
    status: "DISABLED",
    enabled: false,
    writeEnabled: false,
    databasePath: config.databasePath,
  }));
  process.exit(0);
}

let storage;
try {
  storage = createStorage({ env: process.env, cwd: projectRoot });
  let writable = false;
  if (storage.writeEnabled) {
    const streamName = `termux-preflight:${randomUUID()}`;
    const rollback = new Error("termux preflight rollback");
    try {
      storage.transaction(() => {
        storage.syncMetadata.set({
          streamName,
          state: "probe",
          metadata: { schemaVersion: 1 },
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    writable = storage.syncMetadata.get(streamName) === null;
  }
  const health = storage.health.getStatus();
  const sizes = storage.health.getStorageSize();
  process.stdout.write(JSON.stringify({
    status:
      health.integrity?.ok === true && health.journalMode === "wal"
        ? "HEALTHY"
        : "UNHEALTHY",
    enabled: true,
    writeEnabled: storage.writeEnabled,
    writable,
    databasePath: health.databasePath,
    integrity: health.integrity?.ok === true,
    journalMode: health.journalMode,
    databaseBytes: Number(sizes.databaseBytes ?? 0),
    walBytes: Number(sizes.walBytes ?? 0),
    totalBytes: Number(sizes.totalBytes ?? 0),
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: "UNHEALTHY",
    enabled: true,
    writeEnabled: config.writeEnabled,
    databasePath: config.databasePath,
    errorCode: String(error?.code ?? error?.name ?? "STORAGE_ERROR"),
  }));
  process.exitCode = 1;
} finally {
  storage?.close();
}
