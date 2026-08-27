import { createHash } from "node:crypto";
import {
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";
import { assertProviderId } from "../../sync/providers/contract.mjs";
import { sanitizeSyncError } from "../../sync/retry.mjs";

export const SNAPSHOT_TYPES = Object.freeze([
  "guild_status",
  "analytics",
  "runtime",
  "sync_status",
]);

const snapshotTypeSet = new Set(SNAPSHOT_TYPES);

function assertSnapshotType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (!snapshotTypeSet.has(type)) {
    throw new TypeError(`Unsupported snapshot type: ${type || "empty"}.`);
  }
  return type;
}

function checksum(payload) {
  return createHash("sha256").update(serializeJson(payload)).digest("hex");
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function mapSnapshot(row) {
  if (!row) return null;
  return {
    snapshotType: row.snapshot_type,
    aggregateId: row.aggregate_id,
    snapshotVersion: Number(row.snapshot_version),
    payload: parseJson(row.payload_json),
    checksum: row.checksum,
    dirty: Number(row.dirty) === 1,
    generatedAt: Number(row.generated_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapClaimed(row) {
  return {
    ...mapSnapshot(row),
    delivery: {
      providerId: row.provider_id,
      required: Number(row.provider_required) === 1,
      status: row.delivery_status,
      attempts: Number(row.delivery_attempts),
      lockedAt: Number(row.delivery_locked_at),
      lockedBy: row.delivery_locked_by,
    },
  };
}

export function createSyncSnapshotRepository(
  store,
  { providerDefinitions = [], now = () => Date.now() } = {},
) {
  function inTransaction(callback) {
    return store.transactionActive ? callback() : store.transaction(callback);
  }

  function get(snapshotType, aggregateId) {
    return mapSnapshot(
      store.get(
        `SELECT snapshot_type, aggregate_id, snapshot_version, payload_json,
                checksum, dirty, generated_at, created_at, updated_at
         FROM sync_snapshot WHERE snapshot_type = ? AND aggregate_id = ?`,
        assertSnapshotType(snapshotType),
        requireString(aggregateId, "aggregateId"),
      ),
    );
  }

  function upsert(input) {
    const snapshotType = assertSnapshotType(input?.snapshotType);
    const aggregateId = requireString(input?.aggregateId, "aggregateId");
    const payload = input?.payload ?? {};
    const payloadJson = serializeJson(payload);
    // Scheduling metadata may change without changing the analytical value.
    // Callers can provide the stable semantic subset so unchanged projections
    // do not create Cloud writes merely because a refresh window advanced.
    const expectedChecksum = checksum(input?.checksumPayload ?? payload);
    const generatedAt = toEpochMilliseconds(
      input?.generatedAt ?? now(),
      "generatedAt",
    );
    const at = now();
    return inTransaction(() => {
      const current = get(snapshotType, aggregateId);
      if (current?.checksum === expectedChecksum) {
        return { ...current, changed: false };
      }
      const version = Number(current?.snapshotVersion ?? 0) + 1;
      store.run(
        `INSERT INTO sync_snapshot (
           snapshot_type, aggregate_id, snapshot_version, payload_json,
           checksum, dirty, generated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (snapshot_type, aggregate_id) DO UPDATE SET
           snapshot_version = excluded.snapshot_version,
           payload_json = excluded.payload_json,
           checksum = excluded.checksum,
           dirty = 1,
           generated_at = excluded.generated_at,
           updated_at = excluded.updated_at`,
        snapshotType,
        aggregateId,
        version,
        payloadJson,
        expectedChecksum,
        generatedAt,
        current?.createdAt ?? at,
        at,
      );
      for (const provider of providerDefinitions) {
        store.run(
          `INSERT INTO sync_provider_snapshot_delivery (
             snapshot_type, aggregate_id, provider_id, provider_required,
             snapshot_version, checksum, status, attempts, available_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT (snapshot_type, aggregate_id, provider_id) DO UPDATE SET
             provider_required = excluded.provider_required,
             snapshot_version = excluded.snapshot_version,
             checksum = excluded.checksum,
             status = excluded.status,
             attempts = 0,
             available_at = excluded.available_at,
             locked_at = NULL,
             locked_by = NULL,
             first_failed_at = NULL,
             last_attempt_at = NULL,
             last_error = NULL,
             synced_at = NULL,
             remote_checksum = NULL,
             updated_at = excluded.updated_at`,
          snapshotType,
          aggregateId,
          assertProviderId(provider.id),
          provider.required ? 1 : 0,
          version,
          expectedChecksum,
          provider.enabled ? "pending" : "disabled",
          at,
          at,
          at,
        );
      }
      return { ...get(snapshotType, aggregateId), changed: true };
    });
  }

  function applyPolicy(definitions, { at = now() } = {}) {
    if (!Array.isArray(definitions)) throw new TypeError("definitions must be an array.");
    return inTransaction(() => {
      for (const provider of definitions) {
        const providerId = assertProviderId(provider.id);
        store.run(
          `INSERT OR IGNORE INTO sync_provider_snapshot_delivery (
             snapshot_type, aggregate_id, provider_id, provider_required,
             snapshot_version, checksum, status, attempts, available_at,
             created_at, updated_at
           )
           SELECT snapshot_type, aggregate_id, ?, ?, snapshot_version, checksum,
                  ?, 0, ?, ?, ? FROM sync_snapshot`,
          providerId,
          provider.required ? 1 : 0,
          provider.enabled ? "pending" : "disabled",
          at,
          at,
          at,
        );
        store.run(
          `UPDATE sync_provider_snapshot_delivery
           SET provider_required = ?, status = CASE
               WHEN status = 'disabled' AND ? = 1 THEN 'pending'
               WHEN status IN ('pending', 'processing', 'retry') AND ? = 0
                 THEN 'disabled'
               ELSE status END,
               available_at = CASE WHEN status = 'disabled' AND ? = 1
                 THEN ? ELSE available_at END,
               locked_at = CASE WHEN ? = 0 THEN NULL ELSE locked_at END,
               locked_by = CASE WHEN ? = 0 THEN NULL ELSE locked_by END,
               updated_at = ?
           WHERE provider_id = ?`,
          provider.required ? 1 : 0,
          provider.enabled ? 1 : 0,
          provider.enabled ? 1 : 0,
          provider.enabled ? 1 : 0,
          at,
          provider.enabled ? 1 : 0,
          provider.enabled ? 1 : 0,
          at,
          providerId,
        );
      }
      return definitions.length;
    });
  }

  function releaseExpiredLocks(providerId, { lockTimeoutMs, at = now() }) {
    const result = store.run(
      `UPDATE sync_provider_snapshot_delivery
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'Snapshot worker lease expired'),
           updated_at = ?
       WHERE provider_id = ? AND status = 'processing' AND locked_at <= ?`,
      at,
      at,
      assertProviderId(providerId),
      at - Number(lockTimeoutMs),
    );
    return Number(result.changes);
  }

  function releaseWorkerLocks(providerId, workerId, { at = now() } = {}) {
    const result = store.run(
      `UPDATE sync_provider_snapshot_delivery
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'Snapshot worker stopped'),
           updated_at = ?
       WHERE provider_id = ? AND status = 'processing' AND locked_by = ?`,
      at,
      at,
      assertProviderId(providerId),
      requireString(workerId, "workerId"),
    );
    return Number(result.changes);
  }

  function claimBatch({ providerId, workerId, limit, lockTimeoutMs, at = now() }) {
    const normalizedProviderId = assertProviderId(providerId);
    const normalizedWorkerId = requireString(workerId, "workerId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new TypeError("snapshot limit must be between 1 and 250.");
    }
    return inTransaction(() => {
      releaseExpiredLocks(normalizedProviderId, { lockTimeoutMs, at });
      const rows = store.all(
        `SELECT snapshot_type, aggregate_id
         FROM sync_provider_snapshot_delivery
         WHERE provider_id = ? AND status IN ('pending', 'retry')
           AND available_at <= ?
         ORDER BY updated_at ASC LIMIT ?`,
        normalizedProviderId,
        at,
        limit,
      );
      if (rows.length === 0) return [];
      const clauses = rows.map(() => "(snapshot_type = ? AND aggregate_id = ?)").join(" OR ");
      const keys = rows.flatMap((row) => [row.snapshot_type, row.aggregate_id]);
      store.run(
        `UPDATE sync_provider_snapshot_delivery
         SET status = 'processing', attempts = attempts + 1, locked_at = ?,
             locked_by = ?, last_attempt_at = ?, updated_at = ?
         WHERE provider_id = ? AND (${clauses})
           AND status IN ('pending', 'retry')`,
        at,
        normalizedWorkerId,
        at,
        at,
        normalizedProviderId,
        ...keys,
      );
      return store
        .all(
          `SELECT s.snapshot_type, s.aggregate_id, s.snapshot_version,
                  s.payload_json, s.checksum, s.dirty, s.generated_at,
                  s.created_at, s.updated_at,
                  d.provider_id, d.provider_required,
                  d.status AS delivery_status,
                  d.attempts AS delivery_attempts,
                  d.locked_at AS delivery_locked_at,
                  d.locked_by AS delivery_locked_by
           FROM sync_provider_snapshot_delivery d
           JOIN sync_snapshot s USING (snapshot_type, aggregate_id)
           WHERE d.provider_id = ? AND (${clauses})
             AND d.status = 'processing' AND d.locked_by = ?`,
          normalizedProviderId,
          ...keys,
          normalizedWorkerId,
        )
        .map(mapClaimed);
    });
  }

  function updateDirty(snapshotType, aggregateId, { at = now() } = {}) {
    store.run(
      `UPDATE sync_snapshot SET dirty = CASE WHEN
         EXISTS (
           SELECT 1 FROM sync_provider_snapshot_delivery d
           WHERE d.snapshot_type = sync_snapshot.snapshot_type
             AND d.aggregate_id = sync_snapshot.aggregate_id
             AND d.provider_required = 1
         ) AND NOT EXISTS (
           SELECT 1 FROM sync_provider_snapshot_delivery d
           WHERE d.snapshot_type = sync_snapshot.snapshot_type
             AND d.aggregate_id = sync_snapshot.aggregate_id
             AND d.provider_required = 1 AND d.status <> 'synced'
         ) THEN 0 ELSE 1 END,
         updated_at = ?
       WHERE snapshot_type = ? AND aggregate_id = ?`,
      at,
      assertSnapshotType(snapshotType),
      requireString(aggregateId, "aggregateId"),
    );
  }

  function markSynced(providerId, items, { workerId, at = now() } = {}) {
    const normalizedProviderId = assertProviderId(providerId);
    const normalizedWorkerId = requireString(workerId, "workerId");
    const normalizedItems = Array.isArray(items) ? items : [items];
    return inTransaction(() => {
      let changes = 0;
      for (const item of normalizedItems) {
        const snapshotType = assertSnapshotType(item.snapshotType);
        const aggregateId = requireString(item.aggregateId, "aggregateId");
        const result = store.run(
          `UPDATE sync_provider_snapshot_delivery
           SET status = 'synced', synced_at = ?, remote_checksum = ?,
               locked_at = NULL, locked_by = NULL, last_error = NULL,
               updated_at = ?
           WHERE snapshot_type = ? AND aggregate_id = ? AND provider_id = ?
             AND snapshot_version = ? AND checksum = ?
             AND status = 'processing' AND locked_by = ?`,
          at,
          item.remoteChecksum ?? item.checksum,
          at,
          snapshotType,
          aggregateId,
          normalizedProviderId,
          Number(item.snapshotVersion),
          item.checksum,
          normalizedWorkerId,
        );
        if (Number(result.changes) === 1) {
          changes += 1;
          updateDirty(snapshotType, aggregateId, { at });
        }
      }
      return changes;
    });
  }

  function markRetry(
    providerId,
    item,
    { workerId, error, availableAt, at = now() },
  ) {
    const result = store.run(
      `UPDATE sync_provider_snapshot_delivery
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           first_failed_at = COALESCE(first_failed_at, ?), last_error = ?,
           updated_at = ?
       WHERE snapshot_type = ? AND aggregate_id = ? AND provider_id = ?
         AND status = 'processing' AND locked_by = ?`,
      Number(availableAt),
      at,
      sanitizeSyncError(error),
      at,
      assertSnapshotType(item.snapshotType),
      requireString(item.aggregateId, "aggregateId"),
      assertProviderId(providerId),
      requireString(workerId, "workerId"),
    );
    return Number(result.changes) === 1;
  }

  function markDeadLetter(providerId, item, { workerId, error, at = now() }) {
    const result = store.run(
      `UPDATE sync_provider_snapshot_delivery
       SET status = 'dead_letter', locked_at = NULL, locked_by = NULL,
           first_failed_at = COALESCE(first_failed_at, ?), last_error = ?,
           updated_at = ?
       WHERE snapshot_type = ? AND aggregate_id = ? AND provider_id = ?
         AND status = 'processing' AND locked_by = ?`,
      at,
      sanitizeSyncError(error),
      at,
      assertSnapshotType(item.snapshotType),
      requireString(item.aggregateId, "aggregateId"),
      assertProviderId(providerId),
      requireString(workerId, "workerId"),
    );
    return Number(result.changes) === 1;
  }

  function listGuildIds() {
    return store
      .all("SELECT DISTINCT guild_id FROM message_events ORDER BY guild_id")
      .map((row) => String(row.guild_id));
  }

  function getGuildMaterial(guildId, { at = now() } = {}) {
    const normalizedGuildId = requireString(guildId, "guildId");
    const dateUtc = new Date(at).toISOString().slice(0, 10);
    const daily = store.get(
      `SELECT message_count, member_count, updated_at
       FROM local_message_daily_stats WHERE guild_id = ? AND date_utc = ?`,
      normalizedGuildId,
      dateUtc,
    );
    const active = store.get(
      `SELECT COUNT(*) AS count FROM local_message_active_member
       WHERE guild_id = ? AND date_utc = ?`,
      normalizedGuildId,
      dateUtc,
    );
    const current = store.get(
      `SELECT COUNT(*) AS count, MAX(occurred_at) AS last_event_at
       FROM message_events WHERE guild_id = ? AND event_type <> 'delete'`,
      normalizedGuildId,
    );
    const recent = store.get(
      `SELECT COUNT(*) AS count FROM local_message_recent_activity
       WHERE guild_id = ? AND occurred_at >= ?`,
      normalizedGuildId,
      at - 86_400_000,
    );
    return {
      guildId: normalizedGuildId,
      dateUtc,
      memberCount: daily?.member_count == null ? null : Number(daily.member_count),
      messageCountToday: Number(daily?.message_count ?? 0),
      activeMemberCount: Number(active?.count ?? 0),
      currentMessageCount: Number(current?.count ?? 0),
      recentActivityCount: Number(recent?.count ?? 0),
      lastEventAt: current?.last_event_at == null ? null : Number(current.last_event_at),
      sourceUpdatedAt: daily?.updated_at == null ? null : Number(daily.updated_at),
    };
  }

  function getStatusCounts(providerId) {
    return Object.fromEntries(
      store
        .all(
          `SELECT status, COUNT(*) AS count
           FROM sync_provider_snapshot_delivery
           WHERE provider_id = ? GROUP BY status`,
          assertProviderId(providerId),
        )
        .map((row) => [row.status, Number(row.count)]),
    );
  }

  function listForReconciliation({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be between 1 and 1000.");
    }
    return store
      .all(
        `SELECT snapshot_type, aggregate_id, snapshot_version, payload_json,
                checksum, dirty, generated_at, created_at, updated_at
         FROM sync_snapshot ORDER BY updated_at DESC LIMIT ?`,
        limit,
      )
      .map(mapSnapshot);
  }

  return Object.freeze({
    upsert,
    get,
    applyPolicy,
    claimBatch,
    markSynced,
    markRetry,
    markDeadLetter,
    releaseExpiredLocks,
    releaseWorkerLocks,
    listGuildIds,
    getGuildMaterial,
    getStatusCounts,
    listForReconciliation,
  });
}

export { assertSnapshotType };
