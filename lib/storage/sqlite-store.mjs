import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  StorageClosedError,
  StorageReadOnlyError,
} from "./contracts.mjs";
import { applyLocalStorageMigrations } from "./migrations.mjs";

const checkpointModes = new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]);

function fileSize(path) {
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

export class SqliteStore {
  #database;
  #closed = false;
  #transactionActive = false;
  #now;

  constructor({
    databasePath,
    writeEnabled = true,
    readOnly = false,
    busyTimeoutMs = 5_000,
    now = () => Date.now(),
  }) {
    if (!databasePath) throw new TypeError("databasePath is required.");
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new TypeError("busyTimeoutMs must be a non-negative integer.");
    }

    this.databasePath =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);
    this.writeEnabled = Boolean(writeEnabled);
    this.readOnly = Boolean(readOnly);
    this.busyTimeoutMs = busyTimeoutMs;
    this.#now = now;

    if (this.databasePath !== ":memory:" && !this.readOnly) {
      mkdirSync(dirname(this.databasePath), { recursive: true });
    }

    this.#database = new DatabaseSync(this.databasePath, {
      readOnly: this.readOnly,
    });
    try {
      this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.#database.exec("PRAGMA foreign_keys = ON");
      if (this.readOnly) {
        this.#database.exec("PRAGMA query_only = ON");
        this.migrationResult = { currentVersion: null, appliedNow: [] };
      } else {
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#database.exec("PRAGMA synchronous = NORMAL");
        this.migrationResult = applyLocalStorageMigrations(this.#database, { now });
      }
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  get isOpen() {
    return !this.#closed && Boolean(this.#database?.isOpen);
  }

  get transactionActive() {
    return this.#transactionActive;
  }

  assertOpen() {
    if (!this.isOpen) throw new StorageClosedError();
  }

  assertWritable() {
    this.assertOpen();
    if (!this.writeEnabled || this.readOnly) throw new StorageReadOnlyError();
  }

  run(sql, ...parameters) {
    this.assertWritable();
    return this.#database.prepare(sql).run(...parameters);
  }

  get(sql, ...parameters) {
    this.assertOpen();
    return this.#database.prepare(sql).get(...parameters) ?? null;
  }

  all(sql, ...parameters) {
    this.assertOpen();
    return this.#database.prepare(sql).all(...parameters);
  }

  transaction(callback) {
    this.assertWritable();
    if (typeof callback !== "function") {
      throw new TypeError("transaction callback is required.");
    }
    if (this.#transactionActive) {
      throw new Error("Nested local storage transactions are not supported.");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionActive = true;
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        throw new TypeError("SQLite transaction callbacks must be synchronous.");
      }
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  checkIntegrity({ quick = false } = {}) {
    this.assertOpen();
    const pragma = quick ? "quick_check" : "integrity_check";
    const rows = this.#database.prepare(`PRAGMA ${pragma}`).all();
    const messages = rows.map((row) => String(Object.values(row)[0]));
    return {
      ok: messages.length === 1 && messages[0].toLowerCase() === "ok",
      check: pragma,
      messages,
      checkedAt: this.#now(),
    };
  }

  checkpoint(mode = "PASSIVE") {
    this.assertOpen();
    const normalizedMode = String(mode).trim().toUpperCase();
    if (!checkpointModes.has(normalizedMode)) {
      throw new TypeError("Unsupported WAL checkpoint mode.");
    }
    const row = this.#database
      .prepare(`PRAGMA wal_checkpoint(${normalizedMode})`)
      .get();
    return {
      mode: normalizedMode,
      busy: Number(row?.busy ?? 0),
      logFrames: Number(row?.log ?? 0),
      checkpointedFrames: Number(row?.checkpointed ?? 0),
      checkedAt: this.#now(),
    };
  }

  getStorageSize() {
    if (this.databasePath === ":memory:") {
      return { totalBytes: 0, databaseBytes: 0, walBytes: 0, sharedMemoryBytes: 0 };
    }
    const databaseBytes = fileSize(this.databasePath);
    const walBytes = fileSize(`${this.databasePath}-wal`);
    const sharedMemoryBytes = fileSize(`${this.databasePath}-shm`);
    return {
      totalBytes: databaseBytes + walBytes + sharedMemoryBytes,
      databaseBytes,
      walBytes,
      sharedMemoryBytes,
    };
  }

  getStatus() {
    const base = {
      enabled: true,
      writeEnabled: this.writeEnabled,
      readOnly: this.readOnly,
      open: this.isOpen,
      databasePath: this.databasePath,
      storage: this.getStorageSize(),
    };
    if (!this.isOpen) return base;

    const journal = this.get("PRAGMA journal_mode");
    const foreignKeys = this.get("PRAGMA foreign_keys");
    const busyTimeout = this.get("PRAGMA busy_timeout");
    const schema = this.get("SELECT MAX(version) AS version FROM migration_history");
    return {
      ...base,
      journalMode: String(journal?.journal_mode ?? "unknown"),
      foreignKeys: Number(foreignKeys?.foreign_keys ?? 0) === 1,
      busyTimeoutMs: Number(busyTimeout?.timeout ?? this.busyTimeoutMs),
      schemaVersion: Number(schema?.version ?? 0),
      integrity: this.checkIntegrity({ quick: true }),
    };
  }

  close() {
    if (!this.isOpen) return false;
    if (this.#transactionActive) {
      throw new Error("Cannot close local storage during a transaction.");
    }
    this.#database.close();
    this.#closed = true;
    return true;
  }
}
