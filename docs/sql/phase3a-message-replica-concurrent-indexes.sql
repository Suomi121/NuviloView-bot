-- Phase 3A proposal only. DO NOT apply to Production without approval.
-- These statements intentionally run outside a transaction because PostgreSQL
-- forbids CREATE INDEX CONCURRENTLY inside a transaction block.

SET lock_timeout = '5s';
SET statement_timeout = '15min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discord_message_source_event_unique_idx
  ON "discord_message" ("sourceEventId") WHERE "sourceEventId" IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS recent_activity_source_event_unique_idx
  ON "recent_activity" ("sourceEventId") WHERE "sourceEventId" IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
