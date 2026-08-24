import {
  createStableEventId,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../storage/contracts.mjs";
import { normalizeSyncEnvelope } from "./conflict-policy.mjs";
import { sanitizeSyncError } from "./retry.mjs";

const claimableStatuses = ["pending", "retry"];

function mapOutbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    domain: row.domain,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    payload: parseJson(row.payload_json),
    schemaVersion: Number(row.schema_version),
    status: row.status,
    attempts: Number(row.attempts),
    priority: Number(row.priority),
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    lockedAt: row.locked_at === null ? null : Number(row.locked_at),
    lockedBy: row.locked_by,
    firstFailedAt:
      row.first_failed_at === null ? null : Number(row.first_failed_at),
    lastAttemptAt:
      row.last_attempt_at === null ? null : Number(row.last_attempt_at),
    lastError: row.last_error,
    syncedAt: row.synced_at === null ? null : Number(row.synced_at),
    checksum: row.checksum,
  };
}

function mapDeadLetter(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    sourceOutboxId: row.source_outbox_id,
    domain: row.domain,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    payload: parseJson(row.payload_json),
    schemaVersion: Number(row.schema_version),
    checksum: row.checksum,
    error: row.error,
    attempts: Number(row.attempts),
    firstFailedAt: Number(row.first_failed_at),
    lastFailedAt: Number(row.last_failed_at),
    createdAt: Number(row.created_at),
    requeuedAt: row.requeued_at === null ? null : Number(row.requeued_at),
    requeueCount: Number(row.requeue_count),
  };
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

export function createOutboxRepository(store, { now = () => Date.now() } = {}) {
  function inTransaction(callback) {
    return store.transactionActive ? callback() : store.transaction(callback);
  }

  function getByEventId(eventId) {
    return mapOutbox(
      store.get(
        "SELECT * FROM sync_outbox WHERE event_id = ?",
        requireString(eventId, "eventId"),
      ),
    );
  }

  function getById(id) {
    return mapOutbox(
      store.get("SELECT * FROM sync_outbox WHERE id = ?", requireString(id, "id")),
    );
  }

  function enqueue(input) {
    const envelope = normalizeSyncEnvelope(input, { now });
    const result = store.run(
      `INSERT OR IGNORE INTO sync_outbox (
         id, event_id, domain, event_type, aggregate_id, payload_json,
         schema_version, status, attempts, priority, created_at, available_at,
         checksum
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      envelope.id,
      envelope.eventId,
      envelope.domain,
      envelope.eventType,
      envelope.aggregateId,
      serializeJson(envelope.payload),
      envelope.schemaVersion,
      envelope.priority,
      envelope.createdAt,
      envelope.availableAt,
      envelope.checksum,
    );
    const stored = getByEventId(envelope.eventId);
    if (!stored || stored.checksum !== envelope.checksum) {
      const error = new Error(
        `Event ID collision with different content: ${envelope.eventId}.`,
      );
      error.code = "SYNC_EVENT_ID_COLLISION";
      throw error;
    }
    return { ...stored, inserted: Number(result.changes) === 1 };
  }

  function enqueueMany(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    const normalized = inputs.map((input) => normalizeSyncEnvelope(input, { now }));
    return inTransaction(() => normalized.map(enqueue));
  }

  function releaseExpiredLocks({ lockTimeoutMs, at = now() }) {
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError("lockTimeoutMs must be a positive integer.");
    }
    const cutoff = at - lockTimeoutMs;
    const result = store.run(
      `UPDATE sync_outbox
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'Worker lease expired before completion')
       WHERE status = 'processing' AND locked_at <= ?`,
      at,
      cutoff,
    );
    return Number(result.changes);
  }

  function releaseWorkerLocks(workerId, { at = now() } = {}) {
    const result = store.run(
      `UPDATE sync_outbox
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'Worker stopped before completion')
       WHERE status = 'processing' AND locked_by = ?`,
      at,
      requireString(workerId, "workerId"),
    );
    return Number(result.changes);
  }

  function claimBatch({ workerId, limit, lockTimeoutMs, at = now() }) {
    const normalizedWorkerId = requireString(workerId, "workerId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be an integer between 1 and 1000.");
    }
    return inTransaction(() => {
      releaseExpiredLocks({ lockTimeoutMs, at });
      const rows = store.all(
        `SELECT id FROM sync_outbox
         WHERE status IN ('pending', 'retry') AND available_at <= ?
         ORDER BY priority DESC, created_at ASC
         LIMIT ?`,
        at,
        limit,
      );
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return [];
      store.run(
        `UPDATE sync_outbox
         SET status = 'processing', attempts = attempts + 1,
             locked_at = ?, locked_by = ?, last_attempt_at = ?
         WHERE id IN (${placeholders(ids)})
           AND status IN ('pending', 'retry')`,
        at,
        normalizedWorkerId,
        at,
        ...ids,
      );
      return store
        .all(
          `SELECT * FROM sync_outbox
           WHERE id IN (${placeholders(ids)})
             AND status = 'processing' AND locked_by = ?
           ORDER BY priority DESC, created_at ASC`,
          ...ids,
          normalizedWorkerId,
        )
        .map(mapOutbox);
    });
  }

  function markSynced(ids, { workerId, at = now() }) {
    const normalizedIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))]
      .filter(Boolean);
    if (normalizedIds.length === 0) return 0;
    const result = store.run(
      `UPDATE sync_outbox
       SET status = 'synced', synced_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = NULL
       WHERE id IN (${placeholders(normalizedIds)})
         AND status = 'processing' AND locked_by = ?`,
      at,
      ...normalizedIds,
      requireString(workerId, "workerId"),
    );
    return Number(result.changes);
  }

  function markRetry(id, { workerId, error, availableAt, at = now() }) {
    const result = store.run(
      `UPDATE sync_outbox
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           first_failed_at = COALESCE(first_failed_at, ?), last_error = ?
       WHERE id = ? AND status = 'processing' AND locked_by = ?`,
      toEpochMilliseconds(availableAt, "availableAt"),
      at,
      sanitizeSyncError(error),
      requireString(id, "id"),
      requireString(workerId, "workerId"),
    );
    return Number(result.changes) === 1;
  }

  function moveToDeadLetter(id, { workerId, error, at = now() }) {
    return inTransaction(() => {
      const item = getById(id);
      if (
        !item ||
        item.status !== "processing" ||
        item.lockedBy !== requireString(workerId, "workerId")
      ) {
        return null;
      }
      const errorMessage = sanitizeSyncError(error);
      const firstFailedAt = item.firstFailedAt ?? at;
      const deadLetterId = createStableEventId("dead-letter", [item.id]);
      store.run(
        `INSERT INTO sync_dead_letter (
           id, event_id, source_outbox_id, domain, event_type, aggregate_id,
           payload_json, schema_version, checksum, error, attempts,
           first_failed_at, last_failed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET
           error = excluded.error,
           attempts = excluded.attempts,
           last_failed_at = excluded.last_failed_at`,
        deadLetterId,
        item.eventId,
        item.id,
        item.domain,
        item.eventType,
        item.aggregateId,
        serializeJson(item.payload),
        item.schemaVersion,
        item.checksum,
        errorMessage,
        item.attempts,
        firstFailedAt,
        at,
        at,
      );
      store.run(
        `UPDATE sync_outbox
         SET status = 'dead_letter', locked_at = NULL, locked_by = NULL,
             first_failed_at = COALESCE(first_failed_at, ?), last_error = ?
         WHERE id = ? AND status = 'processing' AND locked_by = ?`,
        firstFailedAt,
        errorMessage,
        item.id,
        workerId,
      );
      return getDeadLetter(item.eventId);
    });
  }

  function getDeadLetter(eventId) {
    return mapDeadLetter(
      store.get(
        "SELECT * FROM sync_dead_letter WHERE event_id = ?",
        requireString(eventId, "eventId"),
      ),
    );
  }

  function listDeadLetters({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be between 1 and 1000.");
    }
    return store
      .all("SELECT * FROM sync_dead_letter ORDER BY last_failed_at DESC LIMIT ?", limit)
      .map(mapDeadLetter);
  }

  function requeueDeadLetter(eventId, { at = now() } = {}) {
    return inTransaction(() => {
      const deadLetter = getDeadLetter(eventId);
      if (!deadLetter) return null;
      store.run(
        `UPDATE sync_outbox
         SET status = 'pending', attempts = 0, available_at = ?, locked_at = NULL,
             locked_by = NULL, first_failed_at = NULL, last_attempt_at = NULL,
             last_error = NULL, synced_at = NULL
         WHERE id = ? AND status = 'dead_letter'`,
        at,
        deadLetter.sourceOutboxId,
      );
      store.run(
        `UPDATE sync_dead_letter
         SET requeued_at = ?, requeue_count = requeue_count + 1
         WHERE event_id = ?`,
        at,
        deadLetter.eventId,
      );
      return getByEventId(deadLetter.eventId);
    });
  }

  function count(status) {
    return Number(
      store.get("SELECT COUNT(*) AS count FROM sync_outbox WHERE status = ?", status)
        ?.count ?? 0,
    );
  }

  function getPendingCount() {
    return count("pending");
  }

  function getRetryCount() {
    return count("retry");
  }

  function getProcessingCount() {
    return count("processing");
  }

  function getDeadLetterCount() {
    return Number(
      store.get("SELECT COUNT(*) AS count FROM sync_dead_letter")?.count ?? 0,
    );
  }

  function getOldestPendingAge({ at = now() } = {}) {
    const row = store.get(
      `SELECT MIN(created_at) AS oldest
       FROM sync_outbox WHERE status IN ('pending', 'retry', 'processing')`,
    );
    return row?.oldest === null || row?.oldest === undefined
      ? null
      : Math.max(0, at - Number(row.oldest));
  }

  function getMessagePendingCount() {
    return Number(
      store.get(
        `SELECT COUNT(*) AS count FROM sync_outbox
         WHERE event_type LIKE 'message_%'
           AND status IN ('pending', 'retry', 'processing')`,
      )?.count ?? 0,
    );
  }

  function getMessageOldestPendingAge({ at = now() } = {}) {
    const row = store.get(
      `SELECT MIN(created_at) AS oldest FROM sync_outbox
       WHERE event_type LIKE 'message_%'
         AND status IN ('pending', 'retry', 'processing')`,
    );
    return row?.oldest == null ? null : Math.max(0, at - Number(row.oldest));
  }

  function purgeSynced({ olderThan, limit = 500 } = {}) {
    const cutoff = toEpochMilliseconds(olderThan, "olderThan");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("limit must be an integer between 1 and 10000.");
    }
    const rows = store.all(
      `SELECT id FROM sync_outbox
       WHERE status = 'synced' AND synced_at IS NOT NULL AND synced_at < ?
       ORDER BY synced_at ASC LIMIT ?`,
      cutoff,
      limit,
    );
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return 0;
    const result = store.run(
      `DELETE FROM sync_outbox
       WHERE status = 'synced' AND id IN (${placeholders(ids)})`,
      ...ids,
    );
    return Number(result.changes);
  }

  function getQueueSize() {
    const row = store.get(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(length(payload_json)), 0) AS payload_bytes
       FROM sync_outbox WHERE status <> 'synced'`,
    );
    return {
      count: Number(row?.count ?? 0),
      payloadBytes: Number(row?.payload_bytes ?? 0),
    };
  }

  function getStatusCounts() {
    const counts = Object.fromEntries(
      store
        .all("SELECT status, COUNT(*) AS count FROM sync_outbox GROUP BY status")
        .map((row) => [row.status, Number(row.count)]),
    );
    return Object.fromEntries(
      ["pending", "processing", "retry", "synced", "dead_letter"].map(
        (status) => [status, counts[status] ?? 0],
      ),
    );
  }

  return Object.freeze({
    enqueue,
    enqueueMany,
    claimBatch,
    markSynced,
    markRetry,
    moveToDeadLetter,
    releaseExpiredLocks,
    releaseWorkerLocks,
    getPendingCount,
    getRetryCount,
    getProcessingCount,
    getDeadLetterCount,
    getOldestPendingAge,
    getMessagePendingCount,
    getMessageOldestPendingAge,
    getQueueSize,
    getStatusCounts,
    getByEventId,
    getById,
    getDeadLetter,
    listDeadLetters,
    requeueDeadLetter,
    purgeSynced,
    claimableStatuses: Object.freeze([...claimableStatuses]),
  });
}
