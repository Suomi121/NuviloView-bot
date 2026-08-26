-- PHASE 2 DESIGN ARTIFACT ONLY.
-- Do not apply to Production as part of Phase 2.
-- Review and validate in an isolated PostgreSQL/Neon database before a future rollout.

CREATE TABLE IF NOT EXISTS bot_event_replica (
  event_id text PRIMARY KEY,
  domain text NOT NULL CHECK (
    domain IN ('bot_event', 'analytics', 'security', 'moderation', 'inventory', 'history', 'health')
  ),
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  checksum text NOT NULL CHECK (length(checksum) = 64),
  source_created_at bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_event_replica_domain_created_idx
  ON bot_event_replica (domain, source_created_at DESC);
