-- Phase 3A review-only rollback proposal. DO NOT run in Production without
-- first archiving message_event_replica, message_tombstone, and baseline data.
--
-- This removes only Phase 3A replica infrastructure. Materialized rows already
-- written to discord_message, daily_stats, recent_activity, and
-- daily_active_member are intentionally retained because deleting them could
-- remove valid pre-existing data.

BEGIN;

DROP FUNCTION IF EXISTS sync_message_event_batch(jsonb);

DROP INDEX IF EXISTS recent_activity_source_event_unique_idx;
DROP INDEX IF EXISTS discord_message_source_event_unique_idx;
DROP INDEX IF EXISTS message_tombstone_deleted_at_idx;
DROP INDEX IF EXISTS message_event_replica_occurred_idx;
DROP INDEX IF EXISTS message_event_replica_aggregate_order_idx;
DROP INDEX IF EXISTS message_event_replica_message_order_idx;

-- These tables contain only Phase 3A replica metadata. Dropping them is
-- destructive to replica history and requires an archive before Production use.
DROP TABLE IF EXISTS message_tombstone;
DROP TABLE IF EXISTS message_daily_stat_baseline;
DROP TABLE IF EXISTS message_event_replica;

-- The additive columns are intentionally retained. Dropping columns takes a
-- stronger lock and destroys ordering provenance. If a later maintenance window
-- explicitly approves removal, the separate destructive statements would be:
-- ALTER TABLE "discord_message"
--   DROP COLUMN IF EXISTS "sourceEventId",
--   DROP COLUMN IF EXISTS "sourceRevision",
--   DROP COLUMN IF EXISTS "sourceSequence",
--   DROP COLUMN IF EXISTS "sourceEventRank";
-- ALTER TABLE "recent_activity" DROP COLUMN IF EXISTS "sourceEventId";

COMMIT;
