-- Phase 3A proposal only. DO NOT apply to Production without a reviewed rollout.
-- This is additive and preserves the existing Dashboard read model.

BEGIN;

CREATE TABLE IF NOT EXISTS message_event_replica (
  event_id text PRIMARY KEY,
  event_type text NOT NULL CHECK (
    event_type IN ('message_create', 'message_update', 'message_delete', 'message_active_member')
  ),
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  checksum text NOT NULL,
  source_created_at bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_event_replica_message_order_idx
  ON message_event_replica (
    (payload->>'guildId'), (payload->>'messageId'),
    ((payload->>'sourceSequence')::bigint), event_type
  )
  WHERE event_type <> 'message_active_member';
CREATE INDEX IF NOT EXISTS message_event_replica_occurred_idx
  ON message_event_replica (((payload->>'occurredAt')::bigint));

CREATE TABLE IF NOT EXISTS message_daily_stat_baseline (
  "guildId" text NOT NULL,
  "date" date NOT NULL,
  "legacyMessageCount" integer NOT NULL DEFAULT 0,
  "capturedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("guildId", "date")
);

ALTER TABLE "discord_message"
  ADD COLUMN IF NOT EXISTS "sourceEventId" text,
  ADD COLUMN IF NOT EXISTS "sourceRevision" text,
  ADD COLUMN IF NOT EXISTS "sourceSequence" bigint,
  ADD COLUMN IF NOT EXISTS "sourceEventRank" integer;
CREATE UNIQUE INDEX IF NOT EXISTS discord_message_source_event_unique_idx
  ON "discord_message" ("sourceEventId") WHERE "sourceEventId" IS NOT NULL;

ALTER TABLE "recent_activity"
  ADD COLUMN IF NOT EXISTS "sourceEventId" text;
CREATE UNIQUE INDEX IF NOT EXISTS recent_activity_source_event_unique_idx
  ON "recent_activity" ("sourceEventId") WHERE "sourceEventId" IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_message_event_batch(input_events jsonb)
RETURNS TABLE(event_id text, checksum text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
  IF jsonb_typeof(input_events) <> 'array' THEN
    RAISE EXCEPTION 'input_events must be a JSON array' USING ERRCODE = '22023';
  END IF;

  -- Capture the legacy counter once, before the first local event for a day is inserted.
  INSERT INTO message_daily_stat_baseline ("guildId", "date", "legacyMessageCount")
  SELECT DISTINCT
    item.payload->>'guildId',
    (to_timestamp(((item.payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date,
    COALESCE(stats."messageCount", 0)
  FROM jsonb_to_recordset(input_events) AS item(
    event_id text, event_type text, aggregate_id text, payload jsonb,
    schema_version integer, checksum text, source_created_at bigint
  )
  LEFT JOIN "daily_stats" stats
    ON stats."guildId" = item.payload->>'guildId'
   AND stats."date" = (to_timestamp(((item.payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date
  WHERE item.event_type = 'message_create'
  ON CONFLICT ("guildId", "date") DO NOTHING;

  INSERT INTO message_event_replica (
    event_id, event_type, aggregate_id, payload, schema_version,
    checksum, source_created_at
  )
  SELECT item.event_id, item.event_type, item.aggregate_id, item.payload,
         item.schema_version, item.checksum, item.source_created_at
  FROM jsonb_to_recordset(input_events) AS item(
    event_id text, event_type text, aggregate_id text, payload jsonb,
    schema_version integer, checksum text, source_created_at bigint
  )
  ON CONFLICT (event_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(input_events) AS item(
      event_id text, event_type text, aggregate_id text, payload jsonb,
      schema_version integer, checksum text, source_created_at bigint
    )
    JOIN message_event_replica replica USING (event_id)
    WHERE replica.checksum <> item.checksum
  ) THEN
    RAISE EXCEPTION 'message event checksum conflict' USING ERRCODE = '23505';
  END IF;

  -- Rebuild the current row from the latest event across the whole replica,
  -- not merely the current batch. This prevents a late Update from reviving a
  -- Message whose newer Tombstone was synced earlier.
  WITH affected AS (
    SELECT DISTINCT item.aggregate_id
    FROM jsonb_to_recordset(input_events) AS item(
      event_id text, event_type text, aggregate_id text, payload jsonb,
      schema_version integer, checksum text, source_created_at bigint
    )
    WHERE item.event_type <> 'message_active_member'
  ), winner AS (
    SELECT DISTINCT ON (replica.payload->>'guildId', replica.payload->>'messageId')
      replica.*
    FROM message_event_replica replica
    JOIN affected USING (aggregate_id)
    WHERE replica.event_type <> 'message_active_member'
    ORDER BY replica.payload->>'guildId', replica.payload->>'messageId',
      (replica.payload->>'sourceSequence')::bigint DESC,
      CASE replica.event_type
        WHEN 'message_delete' THEN 2
        WHEN 'message_update' THEN 1
        ELSE 0
      END DESC,
      replica.payload->>'revision' DESC
  )
  INSERT INTO "discord_message" (
    "id", "guildId", "channelId", "channelName", "authorId", "authorName",
    "authorIsBot", "authorRoleIds", "content", "source", "importJobId",
    "createdAt", "updatedAt", "sourceEventId", "sourceRevision",
    "sourceSequence", "sourceEventRank"
  )
  SELECT
    payload->>'messageId', payload->>'guildId', payload->>'channelId',
    COALESCE(payload->>'channelName', '不明なチャンネル'),
    COALESCE(payload->>'authorId', 'unknown'),
    COALESCE(payload->>'authorName', '不明なユーザー'),
    COALESCE((payload->>'authorIsBot')::boolean, false),
    COALESCE(payload->'authorRoleIds', '[]'::jsonb),
    COALESCE(payload->>'content', ''), 'live', NULL,
    to_timestamp(((payload->>'occurredAt')::bigint) / 1000.0), now(),
    event_id, payload->>'revision', (payload->>'sourceSequence')::bigint,
    CASE event_type WHEN 'message_create' THEN 0 ELSE 1 END
  FROM winner
  WHERE event_type IN ('message_create', 'message_update')
  ON CONFLICT ("id") DO UPDATE SET
    "channelId" = EXCLUDED."channelId",
    "channelName" = EXCLUDED."channelName",
    "authorId" = EXCLUDED."authorId",
    "authorName" = EXCLUDED."authorName",
    "authorIsBot" = EXCLUDED."authorIsBot",
    "authorRoleIds" = EXCLUDED."authorRoleIds",
    "content" = EXCLUDED."content",
    "source" = EXCLUDED."source",
    "importJobId" = NULL,
    "updatedAt" = now(),
    "sourceEventId" = EXCLUDED."sourceEventId",
    "sourceRevision" = EXCLUDED."sourceRevision",
    "sourceSequence" = EXCLUDED."sourceSequence",
    "sourceEventRank" = EXCLUDED."sourceEventRank"
  WHERE EXCLUDED."sourceSequence" > COALESCE("discord_message"."sourceSequence", -1)
     OR (EXCLUDED."sourceSequence" = COALESCE("discord_message"."sourceSequence", -1)
         AND EXCLUDED."sourceEventRank" > COALESCE("discord_message"."sourceEventRank", -1))
     OR (EXCLUDED."sourceSequence" = COALESCE("discord_message"."sourceSequence", -1)
         AND EXCLUDED."sourceEventRank" = COALESCE("discord_message"."sourceEventRank", -1)
         AND EXCLUDED."sourceRevision" > COALESCE("discord_message"."sourceRevision", ''));

  WITH affected AS (
    SELECT DISTINCT item.aggregate_id
    FROM jsonb_to_recordset(input_events) AS item(
      event_id text, event_type text, aggregate_id text, payload jsonb,
      schema_version integer, checksum text, source_created_at bigint
    )
    WHERE item.event_type <> 'message_active_member'
  ), winner AS (
    SELECT DISTINCT ON (replica.payload->>'guildId', replica.payload->>'messageId')
      replica.*
    FROM message_event_replica replica
    JOIN affected USING (aggregate_id)
    WHERE replica.event_type <> 'message_active_member'
    ORDER BY replica.payload->>'guildId', replica.payload->>'messageId',
      (replica.payload->>'sourceSequence')::bigint DESC,
      CASE replica.event_type
        WHEN 'message_delete' THEN 2
        WHEN 'message_update' THEN 1
        ELSE 0
      END DESC,
      replica.payload->>'revision' DESC
  )
  DELETE FROM "discord_message" message
  USING winner
  WHERE winner.event_type = 'message_delete'
    AND message."id" = winner.payload->>'messageId';

  INSERT INTO "daily_active_member" ("guildId", "userId", "date")
  SELECT DISTINCT
    payload->>'guildId', payload->>'authorId',
    (to_timestamp(((payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date
  FROM message_event_replica replica
  WHERE replica.event_type = 'message_create'
    AND replica.payload->>'authorId' IS NOT NULL
    AND replica.event_id IN (SELECT value->>'event_id' FROM jsonb_array_elements(input_events))
  UNION
  SELECT replica.payload->>'guildId', replica.payload->>'userId',
         (replica.payload->>'dateUtc')::date
  FROM message_event_replica replica
  WHERE replica.event_type = 'message_active_member'
    AND replica.event_id IN (SELECT value->>'event_id' FROM jsonb_array_elements(input_events))
  ON CONFLICT ("guildId", "userId", "date") DO NOTHING;

  INSERT INTO "recent_activity" (
    "guildId", "type", "actorName", "channelName", "occurredAt", "sourceEventId"
  )
  SELECT replica.payload->>'guildId', 'message',
         COALESCE(replica.payload->>'authorName', '不明なユーザー'),
         replica.payload->>'channelName',
         to_timestamp(((replica.payload->>'occurredAt')::bigint) / 1000.0),
         replica.event_id
  FROM message_event_replica replica
  WHERE replica.event_type = 'message_create'
    AND replica.event_id IN (SELECT value->>'event_id' FROM jsonb_array_elements(input_events))
  ON CONFLICT DO NOTHING;

  INSERT INTO "daily_stats" ("guildId", "memberCount", "messageCount", "date")
  SELECT baseline."guildId", COALESCE(existing."memberCount", 0),
         baseline."legacyMessageCount" + COUNT(replica.event_id)::integer,
         baseline."date"
  FROM message_daily_stat_baseline baseline
  LEFT JOIN "daily_stats" existing
    ON existing."guildId" = baseline."guildId" AND existing."date" = baseline."date"
  LEFT JOIN message_event_replica replica
    ON replica.event_type = 'message_create'
   AND replica.payload->>'guildId' = baseline."guildId"
   AND (to_timestamp(((replica.payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date = baseline."date"
  WHERE (baseline."guildId", baseline."date") IN (
    SELECT item.payload->>'guildId',
           (to_timestamp(((item.payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date
    FROM jsonb_to_recordset(input_events) AS item(
      event_id text, event_type text, aggregate_id text, payload jsonb,
      schema_version integer, checksum text, source_created_at bigint
    )
    WHERE item.event_type = 'message_create'
  )
  GROUP BY baseline."guildId", baseline."date", baseline."legacyMessageCount", existing."memberCount"
  ON CONFLICT ("guildId", "date") DO UPDATE SET
    "messageCount" = EXCLUDED."messageCount",
    "memberCount" = GREATEST("daily_stats"."memberCount", EXCLUDED."memberCount"),
    "updatedAt" = now();

  RETURN QUERY
  SELECT replica.event_id, replica.checksum
  FROM message_event_replica replica
  JOIN jsonb_to_recordset(input_events) AS item(
    event_id text, event_type text, aggregate_id text, payload jsonb,
    schema_version integer, checksum text, source_created_at bigint
  ) item ON item.event_id = replica.event_id;
END;
$$;

COMMIT;
