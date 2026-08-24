const replicaSchemaSql = `
SELECT
  to_regclass(format('%I.message_event_replica', current_schema())) IS NOT NULL AS "eventTable",
  to_regclass(format('%I.message_tombstone', current_schema())) IS NOT NULL AS "tombstoneTable",
  to_regclass(format('%I.message_daily_stat_baseline', current_schema())) IS NOT NULL AS "baselineTable",
  to_regprocedure(format('%I.sync_message_event_batch(jsonb)', current_schema())) IS NOT NULL AS "syncFunction",
  COALESCE((
    SELECT COUNT(*) = 6 AND bool_and(indisvalid AND indisready)
    FROM pg_index
    WHERE indexrelid IN (
      to_regclass(format('%I.message_event_replica_message_order_idx', current_schema())),
      to_regclass(format('%I.message_event_replica_aggregate_order_idx', current_schema())),
      to_regclass(format('%I.message_event_replica_occurred_idx', current_schema())),
      to_regclass(format('%I.message_tombstone_deleted_at_idx', current_schema())),
      to_regclass(format('%I.discord_message_source_event_unique_idx', current_schema())),
      to_regclass(format('%I.recent_activity_source_event_unique_idx', current_schema()))
    )
  ), false) AS "indexesValid",
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'discord_message'
      AND column_name = 'sourceEventId'
  ) AS "messageSourceColumn",
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'recent_activity'
      AND column_name = 'sourceEventId'
  ) AS "activitySourceColumn"
`;

const replicaComparisonSql = `
WITH guild_events AS (
  SELECT * FROM message_event_replica
  WHERE payload->>'guildId' = $1
), ordered AS (
  SELECT guild_events.*,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'messageId'
      ORDER BY (payload->>'sourceSequence')::bigint DESC,
        CASE event_type WHEN 'message_delete' THEN 2 WHEN 'message_update' THEN 1 ELSE 0 END DESC,
        payload->>'revision' DESC
    ) AS winner_rank
  FROM guild_events
  WHERE event_type <> 'message_active_member'
), winners AS (
  SELECT * FROM ordered WHERE winner_rank = 1
), expected_active AS (
  SELECT DISTINCT payload->>'authorId' AS user_id,
    (to_timestamp(((payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date AS date_utc
  FROM guild_events
  WHERE event_type = 'message_create' AND payload->>'authorId' IS NOT NULL
  UNION
  SELECT DISTINCT payload->>'userId', (payload->>'dateUtc')::date
  FROM guild_events
  WHERE event_type = 'message_active_member'
), daily_expected AS (
  SELECT baseline."date",
    baseline."legacyMessageCount" + COUNT(events.event_id)::integer AS expected_count
  FROM message_daily_stat_baseline baseline
  LEFT JOIN guild_events events
    ON events.event_type = 'message_create'
   AND (to_timestamp(((events.payload->>'occurredAt')::bigint) / 1000.0) AT TIME ZONE 'UTC')::date = baseline."date"
  WHERE baseline."guildId" = $1
  GROUP BY baseline."date", baseline."legacyMessageCount"
)
SELECT
  (SELECT COUNT(*)::integer FROM guild_events WHERE event_type <> 'message_active_member') AS "replicaEventCount",
  (SELECT COALESCE(SUM(CASE event_type
      WHEN 'message_create' THEN 4
      WHEN 'message_update' THEN 1
      WHEN 'message_delete' THEN 2
      ELSE 0 END), 0)::integer FROM guild_events) AS "legacyEquivalentQueryCount",
  (SELECT COUNT(*)::integer FROM winners WHERE event_type IN ('message_create', 'message_update')) AS "expectedMessageCount",
  (SELECT COUNT(*)::integer FROM "discord_message" message
    JOIN winners ON winners.event_id = message."sourceEventId"
    WHERE winners.event_type IN ('message_create', 'message_update')) AS "materializedMessageCount",
  (SELECT COUNT(*)::integer FROM winners WHERE event_type = 'message_delete') AS "expectedDeletedCount",
  (SELECT COUNT(*)::integer FROM message_tombstone WHERE "guildId" = $1) AS "tombstoneCount",
  (SELECT COUNT(*)::integer FROM guild_events WHERE event_type = 'message_create') AS "expectedRecentActivityCount",
  (SELECT COUNT(*)::integer FROM "recent_activity" activity
    JOIN guild_events events ON events.event_id = activity."sourceEventId"
    WHERE events.event_type = 'message_create') AS "recentActivityCount",
  (SELECT COUNT(*)::integer FROM expected_active) AS "expectedActiveMemberCount",
  (SELECT COUNT(*)::integer FROM expected_active expected
    LEFT JOIN "daily_active_member" active
      ON active."guildId" = $1 AND active."userId" = expected.user_id AND active."date" = expected.date_utc
    WHERE active."id" IS NULL) AS "activeMemberMissingCount",
  (SELECT COUNT(*)::integer FROM daily_expected expected
    LEFT JOIN "daily_stats" stats ON stats."guildId" = $1 AND stats."date" = expected."date"
    WHERE stats."messageCount" IS DISTINCT FROM expected.expected_count) AS "dailyStatsMismatchCount",
  (SELECT MAX((payload->>'occurredAt')::bigint) FROM guild_events WHERE event_type = 'message_create') AS "latestCreateAt"
`;

export async function checkMessageReplicaSchema(execute) {
  if (typeof execute !== "function") throw new TypeError("execute is required.");
  const result = await execute(replicaSchemaSql, []);
  const row = result?.rows?.[0] ?? result?.[0] ?? {};
  const checks = {
    eventTable: row.eventTable === true,
    tombstoneTable: row.tombstoneTable === true,
    baselineTable: row.baselineTable === true,
    syncFunction: row.syncFunction === true,
    indexesValid: row.indexesValid === true,
    messageSourceColumn: row.messageSourceColumn === true,
    activitySourceColumn: row.activitySourceColumn === true,
  };
  return {
    version: "phase3a-message-replica-proposal-v1",
    ready: Object.values(checks).every(Boolean),
    checks,
  };
}

export async function fetchMessageReplicaComparison(execute, guildId) {
  if (typeof execute !== "function") throw new TypeError("execute is required.");
  const normalizedGuildId = String(guildId ?? "").trim();
  if (!/^[1-9]\d{16,19}$/.test(normalizedGuildId)) {
    throw new TypeError("A valid Discord Guild ID is required for comparison.");
  }
  const result = await execute(replicaComparisonSql, [normalizedGuildId]);
  const row = result?.rows?.[0] ?? result?.[0] ?? {};
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null || value === undefined ? null : Number(value),
    ]),
  );
}

export { replicaComparisonSql, replicaSchemaSql };
