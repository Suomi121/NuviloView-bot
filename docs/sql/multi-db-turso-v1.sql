-- NuviloView Multi-DB Sync v1 - Turso/libSQL Cloud Replica schema.
-- Additive and idempotent. Review and run manually on an isolated database first.

CREATE TABLE IF NOT EXISTS replica_event (
  event_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  checksum TEXT NOT NULL,
  source_created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS replica_event_domain_cursor_idx
  ON replica_event (domain, source_created_at DESC);
CREATE INDEX IF NOT EXISTS replica_event_aggregate_cursor_idx
  ON replica_event (aggregate_id, source_created_at DESC);

CREATE TABLE IF NOT EXISTS guild_status_snapshot (
  aggregate_id TEXT PRIMARY KEY,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  checksum TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS guild_status_snapshot_generated_idx
  ON guild_status_snapshot (generated_at DESC);

CREATE TABLE IF NOT EXISTS analytics_snapshot (
  aggregate_id TEXT PRIMARY KEY,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  checksum TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS analytics_snapshot_generated_idx
  ON analytics_snapshot (generated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_snapshot (
  aggregate_id TEXT PRIMARY KEY,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  checksum TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS runtime_snapshot_generated_idx
  ON runtime_snapshot (generated_at DESC);

CREATE TABLE IF NOT EXISTS sync_status_snapshot (
  aggregate_id TEXT PRIMARY KEY,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  checksum TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sync_status_snapshot_generated_idx
  ON sync_status_snapshot (generated_at DESC);
