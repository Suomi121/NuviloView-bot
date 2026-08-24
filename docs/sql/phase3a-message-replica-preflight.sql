-- Read-only Production/Staging inventory for Phase 3A review.
-- This does not create, alter, update, or delete anything.

SELECT COUNT(*)::integer AS "publicTableCount"
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p');

SELECT c.relname AS "name", c.relkind AS "kind",
       pg_total_relation_size(c.oid) AS "bytes"
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN (
    'message_event_replica',
    'message_tombstone',
    'message_daily_stat_baseline',
    'message_event_replica_message_order_idx',
    'message_event_replica_aggregate_order_idx',
    'message_event_replica_occurred_idx',
    'message_tombstone_deleted_at_idx',
    'discord_message_source_event_unique_idx',
    'recent_activity_source_event_unique_idx'
  )
ORDER BY c.relname;

SELECT table_name AS "table", column_name AS "column", data_type AS "type",
       is_nullable AS "nullable"
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'discord_message' AND column_name IN (
      'id', 'guildId', 'channelId', 'content', 'createdAt', 'updatedAt',
      'sourceEventId', 'sourceRevision', 'sourceSequence', 'sourceEventRank'
    ))
    OR
    (table_name = 'recent_activity' AND column_name IN (
      'guildId', 'occurredAt', 'sourceEventId'
    ))
  )
ORDER BY table_name, column_name;

SELECT relname AS "table", n_live_tup AS "estimatedRows",
       n_dead_tup AS "estimatedDeadRows", last_analyze AS "lastAnalyze",
       last_autoanalyze AS "lastAutoAnalyze"
FROM pg_stat_user_tables
WHERE relname IN ('discord_message', 'recent_activity', 'daily_stats', 'daily_active_member')
ORDER BY relname;

SELECT locktype, mode, granted, COUNT(*)::integer AS "count"
FROM pg_locks
WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
GROUP BY locktype, mode, granted
ORDER BY granted, mode;
