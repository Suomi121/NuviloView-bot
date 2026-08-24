-- NuviloView Multi-DB Sync v1 - PostgreSQL/Supabase Cloud Replica schema.
-- Additive and idempotent. Review and run manually on an isolated project first.
-- This schema is also suitable for the optional Neon snapshot/read-model tables.

CREATE TABLE IF NOT EXISTS replica_event (
  event_id text PRIMARY KEY,
  domain text NOT NULL,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  checksum text NOT NULL,
  source_created_at bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replica_event_domain_cursor_idx
  ON replica_event (domain, source_created_at DESC);
CREATE INDEX IF NOT EXISTS replica_event_aggregate_cursor_idx
  ON replica_event (aggregate_id, source_created_at DESC);

CREATE TABLE IF NOT EXISTS guild_status_snapshot (
  aggregate_id text PRIMARY KEY,
  snapshot_version bigint NOT NULL CHECK (snapshot_version > 0),
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  generated_at bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_snapshot (
  aggregate_id text PRIMARY KEY,
  snapshot_version bigint NOT NULL CHECK (snapshot_version > 0),
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  generated_at bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_snapshot (
  aggregate_id text PRIMARY KEY,
  snapshot_version bigint NOT NULL CHECK (snapshot_version > 0),
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  generated_at bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_status_snapshot (
  aggregate_id text PRIMARY KEY,
  snapshot_version bigint NOT NULL CHECK (snapshot_version > 0),
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  generated_at bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guild_status_snapshot_generated_idx
  ON guild_status_snapshot (generated_at DESC);
CREATE INDEX IF NOT EXISTS analytics_snapshot_generated_idx
  ON analytics_snapshot (generated_at DESC);
CREATE INDEX IF NOT EXISTS runtime_snapshot_generated_idx
  ON runtime_snapshot (generated_at DESC);
CREATE INDEX IF NOT EXISTS sync_status_snapshot_generated_idx
  ON sync_status_snapshot (generated_at DESC);
