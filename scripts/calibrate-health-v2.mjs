import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { calculateHealthScore } from "../lib/community-analytics-utils.mjs";
import {
  attachHealthScoresToQualityGate,
  createHealthDataQualityGate,
} from "../lib/health-data-quality.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});
const now = new Date();
const endDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);
const start = new Date(`${endDate}T00:00:00.000Z`);
start.setUTCDate(start.getUTCDate() - 29);
const startDate = start.toISOString().slice(0, 10);
const days = 30;

const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const rate = (numerator, denominator) => denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 10 : null;
const ageDays = (value) => {
  if (!value) return 0;
  const effectiveStart = Math.max(Date.parse(`${startDate}T00:00:00Z`), Date.parse(value));
  const effectiveEnd = Math.min(Date.now(), Date.parse(`${endDate}T23:59:59.999Z`));
  return Math.max(0, Math.min(days, Math.floor((effectiveEnd - effectiveStart) / 86_400_000)));
};

async function loadGuildMetrics(client, guildId, memberCount) {
  const result = await client.query(`
    WITH message_rows AS (
      SELECT "authorId", "createdAt"
      FROM "discord_message"
      WHERE "guildId" = $1 AND "authorIsBot" = false
        AND "createdAt" >= $2::date AND "createdAt" < ($3::date + 1)
    ), author_counts AS (
      SELECT "authorId", COUNT(*)::int AS messages
      FROM message_rows GROUP BY "authorId"
    ), ranked_authors AS (
      SELECT messages, ROW_NUMBER() OVER (ORDER BY messages DESC) AS rank,
        COUNT(*) OVER () AS author_count, SUM(messages) OVER () AS total_messages
      FROM author_counts
    ), join_rows AS (
      SELECT "id", "userId", "occurredAt", COALESCE("source", 'unknown') AS source
      FROM "guild_member_event"
      WHERE "guildId" = $1 AND "eventType" = 'join' AND "isBot" = false
        AND "occurredAt" >= $2::date AND "occurredAt" < ($3::date + 1)
    ), live_joins AS (
      SELECT * FROM join_rows WHERE source IN ('gateway', 'discord_live')
    ), live_retention AS (
      SELECT COUNT(*) FILTER (WHERE "occurredAt" <= now() - interval '7 days')::int AS eligible,
        COUNT(*) FILTER (WHERE "occurredAt" <= now() - interval '7 days' AND EXISTS (
          SELECT 1 FROM "discord_message" m
          WHERE m."guildId" = $1 AND m."authorId" = live_joins."userId"
            AND m."createdAt" >= live_joins."occurredAt" + interval '7 days'
            AND m."createdAt" < live_joins."occurredAt" + interval '8 days'
          UNION ALL
          SELECT 1 FROM "voice_session" v
          WHERE v."guildId" = $1 AND v."userId" = live_joins."userId"
            AND v."startedAt" >= live_joins."occurredAt" + interval '7 days'
            AND v."startedAt" < live_joins."occurredAt" + interval '8 days'
          UNION ALL
          SELECT 1 FROM "discord_reaction_event" r
          WHERE r."guildId" = $1 AND r."reactorId" = live_joins."userId"
            AND r."occurredAt" >= live_joins."occurredAt" + interval '7 days'
            AND r."occurredAt" < live_joins."occurredAt" + interval '8 days'
        ))::int AS retained
      FROM live_joins
    ), all_retention AS (
      SELECT COUNT(*) FILTER (WHERE "occurredAt" <= now() - interval '7 days')::int AS eligible,
        COUNT(*) FILTER (WHERE "occurredAt" <= now() - interval '7 days' AND EXISTS (
          SELECT 1 FROM "discord_message" m
          WHERE m."guildId" = $1 AND m."authorId" = join_rows."userId"
            AND m."createdAt" >= join_rows."occurredAt" + interval '7 days'
            AND m."createdAt" < join_rows."occurredAt" + interval '8 days'
          UNION ALL
          SELECT 1 FROM "voice_session" v
          WHERE v."guildId" = $1 AND v."userId" = join_rows."userId"
            AND v."startedAt" >= join_rows."occurredAt" + interval '7 days'
            AND v."startedAt" < join_rows."occurredAt" + interval '8 days'
          UNION ALL
          SELECT 1 FROM "discord_reaction_event" r
          WHERE r."guildId" = $1 AND r."reactorId" = join_rows."userId"
            AND r."occurredAt" >= join_rows."occurredAt" + interval '7 days'
            AND r."occurredAt" < join_rows."occurredAt" + interval '8 days'
        ))::int AS retained
      FROM join_rows
    ), scoped_voice AS (
      SELECT v.*,
        COALESCE(v."endedAt", now()) AS observed_end,
        COUNT(*) OVER (PARTITION BY v."userId", v."channelId", v."startedAt", v."endedAt") AS duplicate_count,
        LAG(COALESCE(v."endedAt", now())) OVER (PARTITION BY v."userId" ORDER BY v."startedAt", v."id") AS previous_end
      FROM "voice_session" v
      WHERE v."guildId" = $1 AND v."userIsBot" = false
        AND v."startedAt" >= $2::date AND v."startedAt" < ($3::date + 1)
    ), classified_voice AS (
      SELECT *,
        ("startedAt" > now() + interval '5 minutes') AS future_timestamp,
        ("endedAt" IS NOT NULL AND "endedAt" < "startedAt") AS negative_duration,
        (observed_end - "startedAt" > interval '24 hours') AS over_24_hours,
        ("endedAt" IS NULL AND "startedAt" < now() - interval '24 hours') AS unclosed_over_24_hours,
        (duplicate_count > 1) AS duplicate_session,
        (previous_end IS NOT NULL AND previous_end > "startedAt") AS overlapping_session
      FROM scoped_voice
    ), valid_voice AS (
      SELECT * FROM classified_voice
      WHERE NOT future_timestamp AND NOT negative_duration AND NOT over_24_hours
        AND NOT unclosed_over_24_hours AND NOT duplicate_session AND NOT overlapping_session
    )
    SELECT
      (SELECT COUNT(*)::int FROM message_rows) AS messages,
      (SELECT COUNT(*)::int FROM author_counts) AS active_users,
      COALESCE((SELECT 100.0 * SUM(messages) FILTER (WHERE rank <= CEIL(author_count * 0.1)) / NULLIF(MAX(total_messages), 0) FROM ranked_authors), NULL) AS top_share,
      (SELECT COUNT(*)::int FROM "discord_reaction_event" WHERE "guildId" = $1 AND "reactorIsBot" = false AND "occurredAt" >= $2::date AND "occurredAt" < ($3::date + 1)) AS reactions,
      (SELECT MIN("occurredAt") FROM "discord_reaction_event" WHERE "guildId" = $1) AS reaction_tracking_since,
      (SELECT COUNT(*)::int FROM live_joins) AS live_joins,
      (SELECT COUNT(*)::int FROM "guild_member_event" WHERE "guildId" = $1 AND "eventType" = 'leave' AND "isBot" = false AND "source" IN ('gateway', 'discord_live') AND "occurredAt" >= $2::date AND "occurredAt" < ($3::date + 1)) AS live_leaves,
      (SELECT COUNT(*)::int FROM join_rows) AS raw_joins,
      (SELECT COUNT(*)::int FROM "guild_member_event" WHERE "guildId" = $1 AND "eventType" = 'leave' AND "isBot" = false AND "occurredAt" >= $2::date AND "occurredAt" < ($3::date + 1)) AS raw_leaves,
      (SELECT COUNT(*)::int FROM join_rows WHERE source IN ('gateway', 'discord_live')) AS source_live,
      (SELECT COUNT(*)::int FROM join_rows WHERE source = 'discord_sync') AS source_sync,
      (SELECT COUNT(*)::int FROM join_rows WHERE source = 'historical_import') AS source_historical,
      (SELECT COUNT(*)::int FROM join_rows WHERE source NOT IN ('gateway', 'discord_live', 'discord_sync', 'historical_import')) AS source_unknown,
      (SELECT eligible FROM live_retention) AS live_retention_eligible,
      (SELECT retained FROM live_retention) AS live_retention_retained,
      (SELECT eligible FROM all_retention) AS raw_retention_eligible,
      (SELECT retained FROM all_retention) AS raw_retention_retained,
      (SELECT COUNT(*)::int FROM valid_voice) AS valid_voice_sessions,
      (SELECT COUNT(DISTINCT "userId")::int FROM valid_voice) AS valid_voice_users,
      (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (observed_end - "startedAt"))), 0)::int FROM valid_voice) AS valid_voice_seconds,
      (SELECT COUNT(*)::int FROM scoped_voice) AS raw_voice_sessions,
      (SELECT COUNT(DISTINCT "userId")::int FROM scoped_voice) AS raw_voice_users,
      (SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (observed_end - "startedAt")))), 0)::bigint FROM scoped_voice) AS raw_voice_seconds,
      (SELECT COUNT(*)::int FROM classified_voice WHERE over_24_hours) AS over_24_hours,
      (SELECT COUNT(*)::int FROM classified_voice WHERE unclosed_over_24_hours) AS unclosed_over_24_hours,
      (SELECT COUNT(*)::int FROM classified_voice WHERE future_timestamp) AS future_timestamp,
      (SELECT COUNT(*)::int FROM classified_voice WHERE negative_duration) AS negative_duration,
      (SELECT COUNT(*)::int FROM classified_voice WHERE duplicate_session) AS duplicate_session,
      (SELECT COUNT(*)::int FROM classified_voice WHERE overlapping_session) AS overlapping_session,
      (SELECT MIN("startedAt") FROM "voice_session" WHERE "guildId" = $1) AS voice_tracking_since,
      LEAST(
        COALESCE((SELECT MIN("createdAt") FROM "discord_message" WHERE "guildId" = $1), now()),
        COALESCE((SELECT MIN("occurredAt") FROM "guild_member_event" WHERE "guildId" = $1), now()),
        COALESCE((SELECT MIN("startedAt") FROM "voice_session" WHERE "guildId" = $1), now()),
        COALESCE((SELECT MIN("occurredAt") FROM "discord_reaction_event" WHERE "guildId" = $1), now())
      ) AS tracking_since
  `, [guildId, startDate, endDate]);
  const row = result.rows[0];
  const observationDays = ageDays(row.tracking_since);
  const reactionObservationDays = ageDays(row.reaction_tracking_since);
  const voiceAnomalies = {
    over24Hours: numeric(row.over_24_hours),
    unclosedOver24Hours: numeric(row.unclosed_over_24_hours),
    future: numeric(row.future_timestamp),
    negative: numeric(row.negative_duration),
    duplicate: numeric(row.duplicate_session),
    overlap: numeric(row.overlapping_session),
  };
  const quality = createHealthDataQualityGate({
    observationDays,
    messages: numeric(row.messages),
    activeUsers: numeric(row.active_users),
    uniqueAuthors: numeric(row.active_users),
    joins: numeric(row.live_joins),
    leaves: numeric(row.live_leaves),
    retention: {
      eligible7: numeric(row.live_retention_eligible),
      sources: {
        discordLive: numeric(row.source_live),
        discordSync: numeric(row.source_sync),
        historicalImport: numeric(row.source_historical),
        unknown: numeric(row.source_unknown),
      },
    },
    voice: {
      trackingSince: row.voice_tracking_since,
      observationDays,
      validSessions: numeric(row.valid_voice_sessions),
      anomalies: voiceAnomalies,
    },
    reaction: {
      trackingSince: row.reaction_tracking_since,
      observationDays: reactionObservationDays,
      events: numeric(row.reactions),
    },
  });
  const common = {
    memberCount,
    activeUsers: numeric(row.active_users),
    activityUsers: numeric(row.active_users),
    messages: numeric(row.messages),
    reactions: numeric(row.reactions),
    topMemberShare: row.top_share == null ? null : Number(row.top_share),
    uniqueMessageAuthors: numeric(row.active_users),
    observationDays,
    earlyLeaves: 0,
  };
  const before = calculateHealthScore({
    ...common,
    retention7: rate(numeric(row.raw_retention_retained), numeric(row.raw_retention_eligible)),
    retention30: null,
    voiceUsers: row.voice_tracking_since ? numeric(row.raw_voice_users) : null,
    voiceSeconds: row.voice_tracking_since ? numeric(row.raw_voice_seconds) : null,
    voiceSessions: numeric(row.raw_voice_sessions),
    joins: numeric(row.raw_joins),
    leaves: numeric(row.raw_leaves),
  });
  const afterRaw = calculateHealthScore({
    ...common,
    reactionAvailable: quality.sanitization.reactionUsable,
    retention7: quality.sanitization.retentionUsable
      ? rate(numeric(row.live_retention_retained), numeric(row.live_retention_eligible))
      : null,
    retention30: null,
    voiceUsers: quality.sanitization.voiceUsable ? numeric(row.valid_voice_users) : null,
    voiceSeconds: quality.sanitization.voiceUsable ? numeric(row.valid_voice_seconds) : null,
    voiceSessions: quality.sanitization.voiceUsable ? numeric(row.valid_voice_sessions) : 0,
    joins: numeric(row.live_joins),
    leaves: numeric(row.live_leaves),
    qualityGatePassed: quality.passes,
  });
  const after = { ...afterRaw, dataQuality: attachHealthScoresToQualityGate(quality, afterRaw) };
  return {
    memberCount,
    messages: common.messages,
    reactions: common.reactions,
    validVoiceSessions: numeric(row.valid_voice_sessions),
    invalidVoiceSessions: Object.values(voiceAnomalies).reduce((sum, value) => sum + value, 0),
    liveJoinEvents: numeric(row.source_live),
    syncJoinEvents: numeric(row.source_sync),
    reactionObservationDays,
    before,
    after,
  };
}

function variance(values) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round((values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) * 10) / 10;
}

function correlation(rows, left, right) {
  const pairs = rows.map((row) => [Number(left(row)), Number(right(row))]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 3) return null;
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  const numerator = pairs.reduce((sum, [a, b]) => sum + (a - meanA) * (b - meanB), 0);
  const denominator = Math.sqrt(
    pairs.reduce((sum, [a]) => sum + (a - meanA) ** 2, 0) *
    pairs.reduce((sum, [, b]) => sum + (b - meanB) ** 2, 0),
  );
  return denominator ? Math.round((numerator / denominator) * 1_000) / 1_000 : null;
}

const client = await pool.connect();
let report;
try {
  await client.query("BEGIN READ ONLY");
  const guilds = await client.query(`
    SELECT registry."guildId", registry."memberCount",
      LEAST(
        COALESCE((SELECT MIN("createdAt") FROM "discord_message" WHERE "guildId" = registry."guildId"), 'infinity'::timestamptz),
        COALESCE((SELECT MIN("occurredAt") FROM "guild_member_event" WHERE "guildId" = registry."guildId"), 'infinity'::timestamptz),
        COALESCE((SELECT MIN("startedAt") FROM "voice_session" WHERE "guildId" = registry."guildId"), 'infinity'::timestamptz)
      ) AS "trackingSince"
    FROM "bot_guild_registry" registry
    LEFT JOIN "bot_guild_blocklist" blocklist ON blocklist."guildId" = registry."guildId"
    WHERE registry."isConnected" = true AND blocklist."guildId" IS NULL
    ORDER BY "trackingSince" ASC, registry."guildId" ASC
    LIMIT 8
  `);
  const rows = [];
  for (const [index, guild] of guilds.rows.entries()) {
    const metrics = await loadGuildMetrics(client, guild.guildId, numeric(guild.memberCount));
    rows.push({ guild: `Guild-${String(index + 1).padStart(2, "0")}`, ...metrics });
  }
  await client.query("COMMIT");
  const afterScores = rows.map((row) => row.after.provisionalScore).filter(Number.isFinite);
  report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    period: { startDate, endDate, days, timeZone: "Asia/Tokyo" },
    privacy: { guildIdsIncluded: false, guildNamesIncluded: false, messageContentIncluded: false },
    selection: "Eight connected, unblocked Guilds with the earliest observed Analytics signal.",
    guilds: rows,
    summary: {
      reviewedGuilds: rows.length,
      beforeFormalAvailable: rows.filter((row) => row.before.score !== null).length,
      afterFormalAvailable: rows.filter((row) => row.after.score !== null).length,
      provisionalScores: afterScores,
      provisionalVariance: variance(afterScores),
      missingCategoryCounts: Object.fromEntries(["engagement", "retention", "distribution", "voice", "growth"].map((key) => [key, rows.filter((row) => row.after.categories[key] == null).length])),
      qualityStates: Object.fromEntries(["Available", "LowConfidence", "Immature", "Unavailable"].map((state) => [state, rows.flatMap((row) => Object.values(row.after.dataQuality.categories)).filter((item) => item.qualityState === state).length])),
      invalidVoiceSessions: rows.reduce((sum, row) => sum + row.invalidVoiceSessions, 0),
      syncJoinEventsExcluded: rows.reduce((sum, row) => sum + row.syncJoinEvents, 0),
      memberSizeCorrelation: correlation(rows, (row) => row.memberCount, (row) => row.after.provisionalScore),
      messageActivityCorrelation: correlation(rows, (row) => row.messages, (row) => row.after.provisionalScore),
    },
    recommendation: "Keep Health v2 in Preview/Shadow. Do not change weights from this eight-Guild sample; collect mature Reaction and live Retention cohorts first.",
  };
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}

const outputDirectory = path.resolve("output/release-readiness/health-v2");
await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `health-v2-calibration-${new Date().toISOString().replaceAll(":", "-")}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({
  outputPath,
  reviewedGuilds: report.summary.reviewedGuilds,
  beforeFormalAvailable: report.summary.beforeFormalAvailable,
  afterFormalAvailable: report.summary.afterFormalAvailable,
  invalidVoiceSessions: report.summary.invalidVoiceSessions,
  syncJoinEventsExcluded: report.summary.syncJoinEventsExcluded,
}));
