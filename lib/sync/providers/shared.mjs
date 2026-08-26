import {
  assertReplicaDomain,
  calculateEnvelopeChecksum,
} from "../conflict-policy.mjs";
import { assertSnapshotType } from "../../storage/repositories/sync-snapshots.mjs";

export const snapshotTableByType = Object.freeze({
  guild_status: "guild_status_snapshot",
  analytics: "analytics_snapshot",
  runtime: "runtime_snapshot",
  sync_status: "sync_status_snapshot",
});

export const replicaSchemaColumns = Object.freeze({
  replica_event: Object.freeze([
    "event_id",
    "domain",
    "event_type",
    "aggregate_id",
    "payload",
    "schema_version",
    "checksum",
    "source_created_at",
    "received_at",
  ]),
  guild_status_snapshot: Object.freeze([
    "aggregate_id",
    "snapshot_version",
    "payload",
    "checksum",
    "generated_at",
    "synced_at",
  ]),
  analytics_snapshot: Object.freeze([
    "aggregate_id",
    "snapshot_version",
    "payload",
    "checksum",
    "generated_at",
    "synced_at",
  ]),
  runtime_snapshot: Object.freeze([
    "aggregate_id",
    "snapshot_version",
    "payload",
    "checksum",
    "generated_at",
    "synced_at",
  ]),
  sync_status_snapshot: Object.freeze([
    "aggregate_id",
    "snapshot_version",
    "payload",
    "checksum",
    "generated_at",
    "synced_at",
  ]),
});

export const replicaSchemaIndexes = Object.freeze([
  "replica_event_domain_cursor_idx",
  "replica_event_aggregate_cursor_idx",
  "guild_status_snapshot_generated_idx",
  "analytics_snapshot_generated_idx",
  "runtime_snapshot_generated_idx",
  "sync_status_snapshot_generated_idx",
]);

export class ProviderConflictError extends Error {
  constructor(providerId, identity, kind = "event") {
    super(`${providerId} ${kind} checksum conflict for ${identity}.`);
    this.name = "ProviderConflictError";
    this.code = "SYNC_CHECKSUM_MISMATCH";
    this.providerId = providerId;
    this.identity = identity;
  }
}

export function normalizeProviderEvents(providerId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item) => {
    const domain = assertReplicaDomain(item.domain);
    const expectedChecksum = calculateEnvelopeChecksum(item);
    if (item.checksum !== expectedChecksum) {
      throw new ProviderConflictError(providerId, item.eventId);
    }
    return {
      event_id: item.eventId,
      domain,
      event_type: item.eventType,
      aggregate_id: item.aggregateId,
      payload: item.payload,
      schema_version: item.schemaVersion,
      checksum: item.checksum,
      source_created_at: item.createdAt,
    };
  });
}

export function normalizeProviderSnapshots(providerId, snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return [];
  return snapshots.map((snapshot) => {
    const snapshotType = assertSnapshotType(snapshot.snapshotType);
    const aggregateId = String(snapshot.aggregateId ?? "").trim();
    const checksum = String(snapshot.checksum ?? "").trim();
    const snapshotVersion = Number(snapshot.snapshotVersion);
    if (!aggregateId || !checksum || !Number.isSafeInteger(snapshotVersion) || snapshotVersion < 1) {
      const error = new TypeError("Snapshot identity, version, and checksum are required.");
      error.code = "SYNC_INVALID_PAYLOAD";
      throw error;
    }
    return {
      snapshot_type: snapshotType,
      aggregate_id: aggregateId,
      snapshot_version: snapshotVersion,
      payload: snapshot.payload ?? {},
      checksum,
      generated_at: Number(snapshot.generatedAt),
      source: snapshot,
      provider_id: providerId,
    };
  });
}

export function groupSnapshotsByType(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const items = groups.get(snapshot.snapshot_type) ?? [];
    items.push(snapshot);
    groups.set(snapshot.snapshot_type, items);
  }
  return groups;
}

export function snapshotKey(snapshot) {
  return `${snapshot.snapshotType ?? snapshot.snapshot_type}:${snapshot.aggregateId ?? snapshot.aggregate_id}`;
}
