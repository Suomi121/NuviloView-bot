import {
  groupSnapshotsByType,
  normalizeProviderEvents,
  normalizeProviderSnapshots,
  ProviderConflictError,
  replicaSchemaColumns,
  replicaSchemaIndexes,
  snapshotKey,
  snapshotTableByType,
} from "./shared.mjs";
import { assertSyncProvider } from "./contract.mjs";

const eventInsertSql = `
INSERT INTO replica_event (
  event_id, domain, event_type, aggregate_id, payload,
  schema_version, checksum, source_created_at, received_at
)
SELECT
  json_extract(value, '$.event_id'),
  json_extract(value, '$.domain'),
  json_extract(value, '$.event_type'),
  json_extract(value, '$.aggregate_id'),
  json_extract(value, '$.payload'),
  json_extract(value, '$.schema_version'),
  json_extract(value, '$.checksum'),
  json_extract(value, '$.source_created_at'),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM json_each(?)
WHERE true
ON CONFLICT (event_id) DO NOTHING
`;

const eventVerifySql = `
SELECT event_id, checksum FROM replica_event
WHERE event_id IN (
  SELECT json_extract(value, '$.event_id') FROM json_each(?)
)
`;

function rows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function getValue(row, key, index) {
  if (row && typeof row === "object" && !Array.isArray(row)) return row[key];
  return Array.isArray(row) ? row[index] : undefined;
}

function snapshotInsertSql(tableName) {
  return `
INSERT INTO ${tableName} (
  aggregate_id, snapshot_version, payload, checksum, generated_at, synced_at
)
SELECT
  json_extract(value, '$.aggregate_id'),
  json_extract(value, '$.snapshot_version'),
  json_extract(value, '$.payload'),
  json_extract(value, '$.checksum'),
  json_extract(value, '$.generated_at'),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM json_each(?)
WHERE true
ON CONFLICT (aggregate_id) DO UPDATE SET
  snapshot_version = excluded.snapshot_version,
  payload = excluded.payload,
  checksum = excluded.checksum,
  generated_at = excluded.generated_at,
  synced_at = excluded.synced_at
WHERE excluded.snapshot_version > ${tableName}.snapshot_version
   OR (excluded.snapshot_version = ${tableName}.snapshot_version
       AND excluded.checksum = ${tableName}.checksum)
`;
}

function snapshotVerifySql(tableName) {
  return `
SELECT aggregate_id, snapshot_version, checksum, generated_at, synced_at
FROM ${tableName}
WHERE aggregate_id IN (
  SELECT json_extract(value, '$.aggregate_id') FROM json_each(?)
)
`;
}

export function createTursoProviderAdapter({
  enabled = false,
  client,
  close = async () => client?.close?.(),
} = {}) {
  if (!client || typeof client.execute !== "function" || typeof client.batch !== "function") {
    throw new TypeError("Turso client with execute() and batch() is required.");
  }

  async function pushEvents(items) {
    const records = normalizeProviderEvents("turso", items).map((item) => ({
      ...item,
      payload: JSON.stringify(item.payload),
    }));
    if (records.length === 0) return { succeededEventIds: [], failed: [] };
    const encoded = JSON.stringify(records);
    const result = await client.batch(
      [
        { sql: eventInsertSql, args: [encoded] },
        { sql: eventVerifySql, args: [encoded] },
      ],
      "write",
    );
    const checksums = new Map(
      rows(result[1]).map((row) => [
        String(getValue(row, "event_id", 0)),
        String(getValue(row, "checksum", 1)),
      ]),
    );
    for (const item of records) {
      if (checksums.get(item.event_id) !== item.checksum) {
        throw new ProviderConflictError("turso", item.event_id);
      }
    }
    return {
      succeededEventIds: records.map((item) => item.event_id),
      failed: [],
      queryCount: 1,
    };
  }

  async function pushSnapshots(items) {
    const snapshots = normalizeProviderSnapshots("turso", items);
    if (snapshots.length === 0) return { succeededSnapshotKeys: [], failed: [] };
    const succeededSnapshotKeys = [];
    const groups = groupSnapshotsByType(snapshots);
    for (const [snapshotType, group] of groups) {
      const tableName = snapshotTableByType[snapshotType];
      const encoded = JSON.stringify(
        group.map((item) => ({
          aggregate_id: item.aggregate_id,
          snapshot_version: item.snapshot_version,
          payload: JSON.stringify(item.payload),
          checksum: item.checksum,
          generated_at: item.generated_at,
        })),
      );
      const result = await client.batch(
        [
          { sql: snapshotInsertSql(tableName), args: [encoded] },
          { sql: snapshotVerifySql(tableName), args: [encoded] },
        ],
        "write",
      );
      const stored = new Map(
        rows(result[1]).map((row) => [
          String(getValue(row, "aggregate_id", 0)),
          {
            version: Number(getValue(row, "snapshot_version", 1)),
            checksum: String(getValue(row, "checksum", 2)),
          },
        ]),
      );
      for (const item of group) {
        const remote = stored.get(item.aggregate_id);
        if (
          remote?.version !== item.snapshot_version ||
          remote?.checksum !== item.checksum
        ) {
          throw new ProviderConflictError(
            "turso",
            `${snapshotType}:${item.aggregate_id}`,
            "snapshot",
          );
        }
        succeededSnapshotKeys.push(snapshotKey(item));
      }
    }
    return { succeededSnapshotKeys, failed: [], queryCount: groups.size };
  }

  async function health() {
    if (!enabled) return { status: "DISABLED", providerId: "turso" };
    await client.execute("SELECT 1 AS healthy");
    return { status: "HEALTHY", providerId: "turso" };
  }

  async function verifySchema() {
    if (!enabled) return { ok: false, status: "DISABLED", missing: [] };
    const tableNames = Object.keys(replicaSchemaColumns);
    const objectNames = [...tableNames, ...replicaSchemaIndexes];
    const objectsResult = await client.execute({
      sql: `SELECT type, name FROM sqlite_master
            WHERE name IN (${objectNames.map(() => "?").join(", ")})`,
      args: objectNames,
    });
    const presentObjects = new Map(
      rows(objectsResult).map((row) => [
        String(getValue(row, "name", 1)),
        String(getValue(row, "type", 0)),
      ]),
    );
    const missing = [];
    for (const [tableName, columns] of Object.entries(replicaSchemaColumns)) {
      if (presentObjects.get(tableName) !== "table") {
        missing.push(`table:${tableName}`);
        continue;
      }
      const columnResult = await client.execute(`PRAGMA table_info(${tableName})`);
      const presentColumns = new Set(
        rows(columnResult).map((row) => String(getValue(row, "name", 1))),
      );
      for (const columnName of columns) {
        if (!presentColumns.has(columnName)) {
          missing.push(`column:${tableName}.${columnName}`);
        }
      }
    }
    for (const indexName of replicaSchemaIndexes) {
      if (presentObjects.get(indexName) !== "index") missing.push(`index:${indexName}`);
    }
    return {
      ok: missing.length === 0,
      missing,
      checkedTables: tableNames.length,
      checkedIndexes: replicaSchemaIndexes.length,
    };
  }

  async function getRemoteCursor() {
    const result = await client.execute(
      "SELECT COUNT(*) AS event_count, MAX(source_created_at) AS source_cursor FROM replica_event",
    );
    const row = rows(result)[0];
    return {
      eventCount: Number(getValue(row, "event_count", 0) ?? 0),
      sourceCursor:
        getValue(row, "source_cursor", 1) == null
          ? null
          : Number(getValue(row, "source_cursor", 1)),
    };
  }

  async function getEventChecksums(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return new Map();
    const encoded = JSON.stringify(eventIds.map(String));
    const result = await client.execute({
      sql: `SELECT event_id, checksum FROM replica_event
            WHERE event_id IN (SELECT value FROM json_each(?))`,
      args: [encoded],
    });
    return new Map(
      rows(result).map((row) => [
        String(getValue(row, "event_id", 0)),
        String(getValue(row, "checksum", 1)),
      ]),
    );
  }

  async function getSnapshotStates(items) {
    if (!Array.isArray(items) || items.length === 0) return new Map();
    const groups = new Map();
    for (const item of items) {
      const snapshotType = String(item?.snapshotType ?? "");
      const tableName = snapshotTableByType[snapshotType];
      if (!tableName) throw new TypeError("Unsupported snapshot type.");
      const aggregateIds = groups.get(snapshotType) ?? [];
      aggregateIds.push(String(item.aggregateId));
      groups.set(snapshotType, aggregateIds);
    }
    const states = new Map();
    for (const [snapshotType, aggregateIds] of groups) {
      const tableName = snapshotTableByType[snapshotType];
      const encoded = JSON.stringify([...new Set(aggregateIds)]);
      const result = await client.execute({
        sql: `SELECT aggregate_id, snapshot_version, checksum
              FROM ${tableName}
              WHERE aggregate_id IN (SELECT value FROM json_each(?))`,
        args: [encoded],
      });
      for (const row of rows(result)) {
        states.set(`${snapshotType}:${String(getValue(row, "aggregate_id", 0))}`, {
          snapshotVersion: Number(getValue(row, "snapshot_version", 1)),
          checksum: String(getValue(row, "checksum", 2)),
        });
      }
    }
    return states;
  }

  async function readSnapshot({ snapshotType, aggregateId }) {
    const tableName = snapshotTableByType[String(snapshotType)];
    if (!tableName) throw new TypeError("Unsupported snapshot type.");
    const result = await client.execute({
      sql: `SELECT aggregate_id, snapshot_version, payload, checksum,
                   generated_at, synced_at
            FROM ${tableName} WHERE aggregate_id = ?`,
      args: [String(aggregateId)],
    });
    const row = rows(result)[0];
    if (!row) return null;
    return {
      snapshotType,
      aggregateId: String(getValue(row, "aggregate_id", 0)),
      snapshotVersion: Number(getValue(row, "snapshot_version", 1)),
      payload: JSON.parse(String(getValue(row, "payload", 2))),
      checksum: String(getValue(row, "checksum", 3)),
      generatedAt: Number(getValue(row, "generated_at", 4)),
      syncedAt: Number(getValue(row, "synced_at", 5)),
    };
  }

  return assertSyncProvider(
    Object.freeze({
      id: "turso",
      required: true,
      isEnabled: () => Boolean(enabled),
      health,
      pushEvents,
      pushSnapshots,
      verifySchema,
      getRemoteCursor,
      readSnapshot,
      getEventChecksums,
      getSnapshotStates,
      close,
    }),
  );
}

export { eventInsertSql as tursoEventInsertSql, snapshotInsertSql };
