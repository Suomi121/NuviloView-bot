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
import { assertProviderId, assertSyncProvider } from "./contract.mjs";

const eventBatchSql = `
WITH incoming AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS item(
    event_id text,
    domain text,
    event_type text,
    aggregate_id text,
    payload jsonb,
    schema_version integer,
    checksum text,
    source_created_at bigint
  )
), inserted AS (
  INSERT INTO replica_event (
    event_id, domain, event_type, aggregate_id, payload,
    schema_version, checksum, source_created_at
  )
  SELECT event_id, domain, event_type, aggregate_id, payload,
         schema_version, checksum, source_created_at
  FROM incoming
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id, checksum
)
SELECT incoming.event_id, COALESCE(inserted.checksum, replica.checksum) AS checksum
FROM incoming
LEFT JOIN inserted ON inserted.event_id = incoming.event_id
LEFT JOIN replica_event AS replica ON replica.event_id = incoming.event_id
`;

function resultRows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

function snapshotBatchSql(tableName) {
  return `
WITH incoming AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS item(
    aggregate_id text,
    snapshot_version bigint,
    payload jsonb,
    checksum text,
    generated_at bigint
  )
), written AS (
  INSERT INTO ${tableName} (
    aggregate_id, snapshot_version, payload, checksum, generated_at, synced_at
  )
  SELECT aggregate_id, snapshot_version, payload, checksum, generated_at, now()
  FROM incoming
  ON CONFLICT (aggregate_id) DO UPDATE SET
    snapshot_version = EXCLUDED.snapshot_version,
    payload = EXCLUDED.payload,
    checksum = EXCLUDED.checksum,
    generated_at = EXCLUDED.generated_at,
    synced_at = now()
  WHERE EXCLUDED.snapshot_version > ${tableName}.snapshot_version
     OR (EXCLUDED.snapshot_version = ${tableName}.snapshot_version
         AND EXCLUDED.checksum = ${tableName}.checksum)
  RETURNING aggregate_id, snapshot_version, checksum, generated_at
)
SELECT incoming.aggregate_id,
       COALESCE(written.snapshot_version, replica.snapshot_version) AS snapshot_version,
       COALESCE(written.checksum, replica.checksum) AS checksum,
       COALESCE(written.generated_at, replica.generated_at) AS generated_at
FROM incoming
LEFT JOIN written ON written.aggregate_id = incoming.aggregate_id
LEFT JOIN ${tableName} AS replica ON replica.aggregate_id = incoming.aggregate_id
`;
}

export function createPostgresProviderAdapter({
  id,
  required,
  enabled,
  execute,
  close = async () => {},
}) {
  const providerId = assertProviderId(id);
  if (typeof execute !== "function") {
    throw new TypeError(`${providerId} execute function is required.`);
  }

  async function pushEvents(items) {
    const records = normalizeProviderEvents(providerId, items);
    if (records.length === 0) return { succeededEventIds: [], failed: [] };
    const result = await execute(eventBatchSql, [JSON.stringify(records)]);
    const checksums = new Map(
      resultRows(result).map((row) => [String(row.event_id), String(row.checksum)]),
    );
    for (const item of records) {
      if (checksums.get(item.event_id) !== item.checksum) {
        throw new ProviderConflictError(providerId, item.event_id);
      }
    }
    return {
      succeededEventIds: records.map((item) => item.event_id),
      failed: [],
      queryCount: 1,
    };
  }

  async function pushSnapshots(items) {
    const snapshots = normalizeProviderSnapshots(providerId, items);
    if (snapshots.length === 0) return { succeededSnapshotKeys: [], failed: [] };
    const succeededSnapshotKeys = [];
    const groups = groupSnapshotsByType(snapshots);
    for (const [snapshotType, group] of groups) {
      const tableName = snapshotTableByType[snapshotType];
      const records = group.map((item) => ({
        aggregate_id: item.aggregate_id,
        snapshot_version: item.snapshot_version,
        payload: item.payload,
        checksum: item.checksum,
        generated_at: item.generated_at,
      }));
      const result = await execute(snapshotBatchSql(tableName), [JSON.stringify(records)]);
      const stored = new Map(
        resultRows(result).map((row) => [
          String(row.aggregate_id),
          { version: Number(row.snapshot_version), checksum: String(row.checksum) },
        ]),
      );
      for (const item of group) {
        const remote = stored.get(item.aggregate_id);
        if (
          remote?.version !== item.snapshot_version ||
          remote?.checksum !== item.checksum
        ) {
          throw new ProviderConflictError(
            providerId,
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
    if (!enabled) return { status: "DISABLED", providerId };
    await execute("SELECT 1 AS healthy", []);
    return { status: "HEALTHY", providerId };
  }

  async function verifySchema() {
    if (!enabled) return { ok: false, status: "DISABLED", missing: [] };
    const tableNames = Object.keys(replicaSchemaColumns);
    const columnsResult = await execute(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [tableNames],
    );
    const presentColumns = new Map(
      tableNames.map((tableName) => [tableName, new Set()]),
    );
    for (const row of resultRows(columnsResult)) {
      presentColumns.get(String(row.table_name))?.add(String(row.column_name));
    }
    const indexResult = await execute(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = ANY($1::text[])`,
      [replicaSchemaIndexes],
    );
    const presentIndexes = new Set(
      resultRows(indexResult).map((row) => String(row.indexname)),
    );
    const missing = [];
    for (const [tableName, columns] of Object.entries(replicaSchemaColumns)) {
      const present = presentColumns.get(tableName);
      if (!present || present.size === 0) {
        missing.push(`table:${tableName}`);
        continue;
      }
      for (const columnName of columns) {
        if (!present.has(columnName)) missing.push(`column:${tableName}.${columnName}`);
      }
    }
    for (const indexName of replicaSchemaIndexes) {
      if (!presentIndexes.has(indexName)) missing.push(`index:${indexName}`);
    }
    return {
      ok: missing.length === 0,
      missing,
      checkedTables: tableNames.length,
      checkedIndexes: replicaSchemaIndexes.length,
    };
  }

  async function getRemoteCursor() {
    const result = await execute(
      `SELECT COUNT(*)::bigint AS event_count,
              MAX(source_created_at)::bigint AS source_cursor
       FROM replica_event`,
      [],
    );
    const row = resultRows(result)[0] ?? {};
    return {
      eventCount: Number(row.event_count ?? 0),
      sourceCursor: row.source_cursor == null ? null : Number(row.source_cursor),
    };
  }

  async function getEventChecksums(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return new Map();
    const result = await execute(
      "SELECT event_id, checksum FROM replica_event WHERE event_id = ANY($1::text[])",
      [eventIds.map(String)],
    );
    return new Map(
      resultRows(result).map((row) => [String(row.event_id), String(row.checksum)]),
    );
  }

  async function readSnapshot({ snapshotType, aggregateId }) {
    const tableName = snapshotTableByType[String(snapshotType)];
    if (!tableName) throw new TypeError("Unsupported snapshot type.");
    const result = await execute(
      `SELECT aggregate_id, snapshot_version, payload, checksum,
              generated_at, synced_at
       FROM ${tableName} WHERE aggregate_id = $1`,
      [String(aggregateId)],
    );
    const row = resultRows(result)[0];
    if (!row) return null;
    return {
      snapshotType,
      aggregateId: String(row.aggregate_id),
      snapshotVersion: Number(row.snapshot_version),
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      checksum: String(row.checksum),
      generatedAt: Number(row.generated_at),
      syncedAt:
        row.synced_at instanceof Date
          ? row.synced_at.getTime()
          : Number(row.synced_at ?? row.generated_at),
    };
  }

  return assertSyncProvider(
    Object.freeze({
      id: providerId,
      required: Boolean(required),
      isEnabled: () => Boolean(enabled),
      health,
      pushEvents,
      pushSnapshots,
      verifySchema,
      getRemoteCursor,
      readSnapshot,
      getEventChecksums,
      close,
    }),
  );
}

export { eventBatchSql as postgresEventBatchSql, snapshotBatchSql };
