import { randomUUID } from "node:crypto";
import { requireString } from "../contracts.mjs";
import {
  assertProviderId,
  SYNC_PROVIDER_ID_LIST,
} from "../../sync/providers/contract.mjs";
import { sanitizeSyncError } from "../../sync/retry.mjs";

const activeStatuses = Object.freeze(["pending", "processing", "retry"]);

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function mapDelivery(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    providerId: row.provider_id,
    required: Number(row.provider_required) === 1,
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
    lockedAt: row.locked_at == null ? null : Number(row.locked_at),
    lockedBy: row.locked_by,
    firstFailedAt: row.first_failed_at == null ? null : Number(row.first_failed_at),
    lastAttemptAt: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
    lastError: row.last_error,
    syncedAt: row.synced_at == null ? null : Number(row.synced_at),
    remoteChecksum: row.remote_checksum,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapClaimed(row) {
  return {
    id: row.outbox_id,
    eventId: row.event_id,
    domain: row.domain,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    payload: JSON.parse(row.payload_json),
    schemaVersion: Number(row.schema_version),
    priority: Number(row.priority),
    createdAt: Number(row.source_created_at),
    checksum: row.checksum,
    delivery: {
      providerId: row.provider_id,
      required: Number(row.provider_required) === 1,
      status: row.delivery_status,
      attempts: Number(row.delivery_attempts),
      availableAt: Number(row.delivery_available_at),
      lockedAt: Number(row.delivery_locked_at),
      lockedBy: row.delivery_locked_by,
    },
  };
}

export function createProviderDeliveryRepository(
  store,
  { now = () => Date.now() } = {},
) {
  function inTransaction(callback) {
    return store.transactionActive ? callback() : store.transaction(callback);
  }

  function ensureForEvent(eventId, providerDefinitions, { at = now() } = {}) {
    const normalizedEventId = requireString(eventId, "eventId");
    if (!Array.isArray(providerDefinitions) || providerDefinitions.length === 0) {
      return [];
    }
    return providerDefinitions.map((provider) => {
      const providerId = assertProviderId(provider.id);
      const status = provider.enabled ? "pending" : "disabled";
      store.run(
        `INSERT OR IGNORE INTO sync_provider_delivery (
           event_id, provider_id, provider_required, status, attempts,
           available_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        normalizedEventId,
        providerId,
        provider.required ? 1 : 0,
        status,
        at,
        at,
        at,
      );
      return get(normalizedEventId, providerId);
    });
  }

  function applyPolicy(providerDefinitions, { at = now() } = {}) {
    if (!Array.isArray(providerDefinitions)) {
      throw new TypeError("providerDefinitions must be an array.");
    }
    return inTransaction(() =>
      providerDefinitions.map((provider) => {
        const providerId = assertProviderId(provider.id);
        store.run(
          `INSERT OR IGNORE INTO sync_provider_delivery (
             event_id, provider_id, provider_required, status, attempts,
             available_at, created_at, updated_at
           )
           SELECT event_id, ?, ?, ?, 0, ?, ?, ? FROM sync_outbox
           WHERE status <> 'dead_letter'`,
          providerId,
          provider.required ? 1 : 0,
          provider.enabled ? "pending" : "disabled",
          at,
          at,
          at,
        );
        store.run(
          `UPDATE sync_provider_delivery
           SET provider_required = ?,
               status = CASE
                 WHEN status = 'disabled' AND ? = 1 THEN 'pending'
                 WHEN status IN ('pending', 'processing', 'retry') AND ? = 0
                   THEN 'disabled'
                 ELSE status
               END,
               available_at = CASE
                 WHEN status = 'disabled' AND ? = 1 THEN ? ELSE available_at END,
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
        store.run(
          `INSERT INTO sync_provider_metrics (
             provider_id, provider_required, enabled, health_status,
             circuit_state, updated_at
           ) VALUES (?, ?, ?, ?, 'CLOSED', ?)
           ON CONFLICT (provider_id) DO UPDATE SET
             provider_required = excluded.provider_required,
             enabled = excluded.enabled,
             health_status = CASE
               WHEN excluded.enabled = 0 THEN 'DISABLED'
               WHEN sync_provider_metrics.health_status = 'DISABLED' THEN 'UNKNOWN'
               ELSE sync_provider_metrics.health_status
             END,
             updated_at = excluded.updated_at`,
          providerId,
          provider.required ? 1 : 0,
          provider.enabled ? 1 : 0,
          provider.enabled ? "UNKNOWN" : "DISABLED",
          at,
        );
        return getProviderStatus(providerId);
      }),
    );
  }

  function get(eventId, providerId) {
    return mapDelivery(
      store.get(
        `SELECT event_id, provider_id, provider_required, status, attempts,
                available_at, locked_at, locked_by, first_failed_at,
                last_attempt_at, last_error, synced_at, remote_checksum,
                created_at, updated_at
         FROM sync_provider_delivery
         WHERE event_id = ? AND provider_id = ?`,
        requireString(eventId, "eventId"),
        assertProviderId(providerId),
      ),
    );
  }

  function listForEvent(eventId) {
    return store
      .all(
        `SELECT event_id, provider_id, provider_required, status, attempts,
                available_at, locked_at, locked_by, first_failed_at,
                last_attempt_at, last_error, synced_at, remote_checksum,
                created_at, updated_at
         FROM sync_provider_delivery WHERE event_id = ? ORDER BY provider_id`,
        requireString(eventId, "eventId"),
      )
      .map(mapDelivery);
  }

  function releaseExpiredLocks(providerId, { lockTimeoutMs, at = now() }) {
    const cutoff = at - Number(lockTimeoutMs);
    const result = store.run(
      `UPDATE sync_provider_delivery
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'Provider worker lease expired'),
           updated_at = ?
       WHERE provider_id = ? AND status = 'processing' AND locked_at <= ?`,
      at,
      at,
      assertProviderId(providerId),
      cutoff,
    );
    return Number(result.changes);
  }

  function releaseWorkerLocks(providerId, workerId, { at = now() } = {}) {
    const result = store.run(
      `UPDATE sync_provider_delivery
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = COALESCE(last_error, 'Provider worker stopped'),
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
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be an integer between 1 and 1000.");
    }
    return inTransaction(() => {
      releaseExpiredLocks(normalizedProviderId, { lockTimeoutMs, at });
      const rows = store.all(
        `SELECT d.event_id
         FROM sync_provider_delivery d
         JOIN sync_outbox o ON o.event_id = d.event_id
         WHERE d.provider_id = ? AND d.status IN ('pending', 'retry')
           AND o.status <> 'dead_letter'
           AND d.available_at <= ?
         ORDER BY o.priority DESC, o.created_at ASC
         LIMIT ?`,
        normalizedProviderId,
        at,
        limit,
      );
      const eventIds = rows.map((row) => row.event_id);
      if (eventIds.length === 0) return [];
      store.run(
        `UPDATE sync_provider_delivery
         SET status = 'processing', attempts = attempts + 1,
             locked_at = ?, locked_by = ?, last_attempt_at = ?, updated_at = ?
         WHERE provider_id = ? AND event_id IN (${placeholders(eventIds)})
           AND status IN ('pending', 'retry')`,
        at,
        normalizedWorkerId,
        at,
        at,
        normalizedProviderId,
        ...eventIds,
      );
      return store
        .all(
          `SELECT
             o.id AS outbox_id, o.event_id, o.domain, o.event_type,
             o.aggregate_id, o.payload_json, o.schema_version, o.priority,
             o.created_at AS source_created_at, o.checksum,
             d.provider_id, d.provider_required, d.status AS delivery_status,
             d.attempts AS delivery_attempts,
             d.available_at AS delivery_available_at,
             d.locked_at AS delivery_locked_at,
             d.locked_by AS delivery_locked_by
           FROM sync_provider_delivery d
           JOIN sync_outbox o ON o.event_id = d.event_id
           WHERE d.provider_id = ? AND d.event_id IN (${placeholders(eventIds)})
             AND d.status = 'processing' AND d.locked_by = ?
           ORDER BY o.priority DESC, o.created_at ASC`,
          normalizedProviderId,
          ...eventIds,
          normalizedWorkerId,
        )
        .map(mapClaimed);
    });
  }

  function updateCloudCompletion(eventIds, { at = now() } = {}) {
    const ids = [...new Set(eventIds.map(String))].filter(Boolean);
    if (ids.length === 0) return 0;
    const result = store.run(
      `UPDATE sync_outbox
       SET status = 'synced', synced_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = NULL
       WHERE event_id IN (${placeholders(ids)})
         AND status IN ('pending', 'processing', 'retry')
         AND EXISTS (
           SELECT 1 FROM sync_provider_delivery required_row
           WHERE required_row.event_id = sync_outbox.event_id
             AND required_row.provider_required = 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM sync_provider_delivery incomplete
           WHERE incomplete.event_id = sync_outbox.event_id
             AND incomplete.provider_required = 1
             AND incomplete.status <> 'synced'
         )`,
      at,
      ...ids,
    );
    return Number(result.changes);
  }

  function markSynced(providerId, items, { workerId, at = now() } = {}) {
    const normalizedProviderId = assertProviderId(providerId);
    const normalizedWorkerId = requireString(workerId, "workerId");
    const normalizedItems = Array.isArray(items) ? items : [items];
    if (normalizedItems.length === 0) return 0;
    return inTransaction(() => {
      let changes = 0;
      const completed = [];
      for (const item of normalizedItems) {
        const eventId = requireString(item?.eventId ?? item, "eventId");
        const checksum = item?.remoteChecksum ?? item?.checksum ?? null;
        const result = store.run(
          `UPDATE sync_provider_delivery
           SET status = 'synced', synced_at = ?, remote_checksum = ?,
               locked_at = NULL, locked_by = NULL, last_error = NULL,
               updated_at = ?
           WHERE event_id = ? AND provider_id = ? AND status = 'processing'
             AND locked_by = ?`,
          at,
          checksum,
          at,
          eventId,
          normalizedProviderId,
          normalizedWorkerId,
        );
        if (Number(result.changes) === 1) {
          changes += 1;
          completed.push(eventId);
        }
      }
      updateCloudCompletion(completed, { at });
      return changes;
    });
  }

  function markRetry(
    providerId,
    eventId,
    { workerId, error, availableAt, at = now() },
  ) {
    const result = store.run(
      `UPDATE sync_provider_delivery
       SET status = 'retry', available_at = ?, locked_at = NULL, locked_by = NULL,
           first_failed_at = COALESCE(first_failed_at, ?), last_error = ?,
           updated_at = ?
       WHERE event_id = ? AND provider_id = ? AND status = 'processing'
         AND locked_by = ?`,
      Number(availableAt),
      at,
      sanitizeSyncError(error),
      at,
      requireString(eventId, "eventId"),
      assertProviderId(providerId),
      requireString(workerId, "workerId"),
    );
    return Number(result.changes) === 1;
  }

  function markDeadLetter(providerId, eventId, { workerId, error, at = now() }) {
    const result = store.run(
      `UPDATE sync_provider_delivery
       SET status = 'dead_letter', locked_at = NULL, locked_by = NULL,
           first_failed_at = COALESCE(first_failed_at, ?), last_error = ?,
           updated_at = ?
       WHERE event_id = ? AND provider_id = ? AND status = 'processing'
         AND locked_by = ?`,
      at,
      sanitizeSyncError(error),
      at,
      requireString(eventId, "eventId"),
      assertProviderId(providerId),
      requireString(workerId, "workerId"),
    );
    return Number(result.changes) === 1;
  }

  function isCloudComplete(eventId) {
    const row = store.get(
      `SELECT
         SUM(CASE WHEN provider_required = 1 THEN 1 ELSE 0 END) AS required_count,
         SUM(CASE WHEN provider_required = 1 AND status = 'synced' THEN 1 ELSE 0 END)
           AS synced_required_count
       FROM sync_provider_delivery WHERE event_id = ?`,
      requireString(eventId, "eventId"),
    );
    const required = Number(row?.required_count ?? 0);
    return required > 0 && required === Number(row?.synced_required_count ?? 0);
  }

  function recordAttempt(providerId, { at = now(), queryCount = 1 } = {}) {
    store.run(
      `UPDATE sync_provider_metrics
       SET query_count = query_count + ?, last_attempt_at = ?, updated_at = ?
       WHERE provider_id = ?`,
      Number(queryCount),
      at,
      at,
      assertProviderId(providerId),
    );
  }

  function recordResult(
    providerId,
    { synced = 0, failed = 0, error = null, healthStatus, at = now() } = {},
  ) {
    store.run(
      `UPDATE sync_provider_metrics
       SET synced_total = synced_total + ?, failed_total = failed_total + ?,
           last_success_at = CASE WHEN ? > 0 THEN ? ELSE last_success_at END,
           last_failure_at = CASE WHEN ? > 0 THEN ? ELSE last_failure_at END,
           last_error = CASE WHEN ? > 0 THEN ? WHEN ? > 0 THEN NULL ELSE last_error END,
           health_status = ?, updated_at = ?
       WHERE provider_id = ?`,
      Number(synced),
      Number(failed),
      Number(synced),
      at,
      Number(failed),
      at,
      Number(failed),
      error ? sanitizeSyncError(error) : null,
      Number(synced),
      healthStatus ?? (failed > 0 ? "DEGRADED" : "HEALTHY"),
      at,
      assertProviderId(providerId),
    );
  }

  function setCircuitState(providerId, circuitState, { at = now() } = {}) {
    store.run(
      `UPDATE sync_provider_metrics
       SET circuit_state = ?, health_status = CASE
         WHEN enabled = 0 THEN 'DISABLED'
         WHEN ? = 'OPEN' THEN 'OFFLINE'
         WHEN health_status = 'OFFLINE' AND ? = 'CLOSED' THEN 'UNKNOWN'
         ELSE health_status END,
         updated_at = ?
       WHERE provider_id = ?`,
      String(circuitState),
      String(circuitState),
      String(circuitState),
      at,
      assertProviderId(providerId),
    );
  }

  function getProviderStatus(providerId) {
    const normalizedProviderId = assertProviderId(providerId);
    const counts = Object.fromEntries(
      store
        .all(
          `SELECT status, COUNT(*) AS count FROM sync_provider_delivery
           WHERE provider_id = ? GROUP BY status`,
          normalizedProviderId,
        )
        .map((row) => [row.status, Number(row.count)]),
    );
    const metrics = store.get(
      `SELECT provider_required, enabled, health_status, circuit_state,
              query_count, synced_total, failed_total, last_attempt_at,
              last_success_at, last_failure_at, last_error, updated_at
       FROM sync_provider_metrics WHERE provider_id = ?`,
      normalizedProviderId,
    );
    return {
      providerId: normalizedProviderId,
      required: Number(metrics?.provider_required ?? 0) === 1,
      enabled: Number(metrics?.enabled ?? 0) === 1,
      healthStatus: metrics?.health_status ?? "DISABLED",
      circuitState: metrics?.circuit_state ?? "CLOSED",
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
      retry: counts.retry ?? 0,
      synced: counts.synced ?? 0,
      deadLetter: counts.dead_letter ?? 0,
      disabled: counts.disabled ?? 0,
      lastAttemptAt: metrics?.last_attempt_at == null ? null : Number(metrics.last_attempt_at),
      lastSuccessAt: metrics?.last_success_at == null ? null : Number(metrics.last_success_at),
      lastFailureAt: metrics?.last_failure_at == null ? null : Number(metrics.last_failure_at),
      lastError: metrics?.last_error ?? null,
      syncedTotal: Number(metrics?.synced_total ?? 0),
      failedTotal: Number(metrics?.failed_total ?? 0),
      queryCount: Number(metrics?.query_count ?? 0),
    };
  }

  function getAllProviderStatus() {
    return SYNC_PROVIDER_ID_LIST.map(getProviderStatus);
  }

  function getCloudCompletionSummary() {
    const row = store.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'synced' THEN 1 ELSE 0 END) AS complete
       FROM sync_outbox`,
    );
    return {
      total: Number(row?.total ?? 0),
      complete: Number(row?.complete ?? 0),
    };
  }

  function planBackfill(providerId) {
    const normalizedProviderId = assertProviderId(providerId);
    const row = store.get(
      `SELECT
         SUM(CASE WHEN d.event_id IS NULL THEN 1 ELSE 0 END) AS missing,
         SUM(CASE WHEN d.status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
         COUNT(*) AS retained_events
       FROM sync_outbox o
       LEFT JOIN sync_provider_delivery d
         ON d.event_id = o.event_id AND d.provider_id = ?
       WHERE o.status <> 'dead_letter'`,
      normalizedProviderId,
    );
    return {
      providerId: normalizedProviderId,
      retainedEvents: Number(row?.retained_events ?? 0),
      missing: Number(row?.missing ?? 0),
      disabled: Number(row?.disabled ?? 0),
    };
  }

  function executeBackfill(
    providerId,
    { required, limit = 100, at = now() } = {},
  ) {
    const normalizedProviderId = assertProviderId(providerId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("limit must be between 1 and 10000.");
    }
    return inTransaction(() => {
      const candidates = store.all(
        `SELECT o.event_id
         FROM sync_outbox o
         LEFT JOIN sync_provider_delivery d
           ON d.event_id = o.event_id AND d.provider_id = ?
         WHERE o.status <> 'dead_letter'
           AND (d.event_id IS NULL OR d.status = 'disabled')
         ORDER BY o.created_at ASC LIMIT ?`,
        normalizedProviderId,
        limit,
      );
      for (const candidate of candidates) {
        store.run(
          `INSERT INTO sync_provider_delivery (
             event_id, provider_id, provider_required, status, attempts,
             available_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT (event_id, provider_id) DO UPDATE SET
             provider_required = excluded.provider_required,
             status = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN 'pending' ELSE sync_provider_delivery.status END,
             attempts = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN 0 ELSE sync_provider_delivery.attempts END,
             available_at = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN excluded.available_at ELSE sync_provider_delivery.available_at END,
             locked_at = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN NULL ELSE sync_provider_delivery.locked_at END,
             locked_by = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN NULL ELSE sync_provider_delivery.locked_by END,
             first_failed_at = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN NULL ELSE sync_provider_delivery.first_failed_at END,
             last_attempt_at = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN NULL ELSE sync_provider_delivery.last_attempt_at END,
             last_error = CASE WHEN sync_provider_delivery.status = 'disabled'
               THEN NULL ELSE sync_provider_delivery.last_error END,
             updated_at = excluded.updated_at`,
          candidate.event_id,
          normalizedProviderId,
          required ? 1 : 0,
          at,
          at,
          at,
        );
      }
      return { providerId: normalizedProviderId, queued: candidates.length };
    });
  }

  function createWorkerId(providerId) {
    return `multi-sync-${assertProviderId(providerId)}-${process.pid}-${randomUUID()}`;
  }

  return Object.freeze({
    activeStatuses,
    ensureForEvent,
    applyPolicy,
    get,
    listForEvent,
    claimBatch,
    markSynced,
    markRetry,
    markDeadLetter,
    releaseExpiredLocks,
    releaseWorkerLocks,
    isCloudComplete,
    updateCloudCompletion,
    recordAttempt,
    recordResult,
    setCircuitState,
    getProviderStatus,
    getAllProviderStatus,
    getCloudCompletionSummary,
    planBackfill,
    executeBackfill,
    createWorkerId,
  });
}
