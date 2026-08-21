import "server-only";

import { pool } from "@/lib/db";
import {
  buildInsights,
  calculateHealthScore,
  channelStatus,
  comparison,
  contribution,
  percentagePointChange,
  safeRate,
} from "@/lib/community-analytics-utils.mjs";
import {
  healthV2HistoryEntry,
  healthV2SnapshotScore,
  resolveHealthV2ReleaseConfig,
} from "@/lib/health-v2-release.mjs";
import {
  attachHealthScoresToQualityGate,
  createHealthDataQualityGate,
} from "@/lib/health-data-quality.mjs";
import { getMessageImportConfig } from "@/lib/message-history-import.mjs";

const messageImportConfig = getMessageImportConfig(process.env);

export type AnalyticsRange = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  days: number;
  timeZone: string;
  roleId: string | null;
  channelId: string | null;
  excludeBots: boolean;
};

type NumericRow = Record<string, number | string | null>;

function number(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nullableRate(numerator: unknown, denominator: unknown) {
  return safeRate(number(numerator), number(denominator));
}

function boundsSql(alias: string, timestampColumn: string, period: "current" | "previous") {
  const start = period === "current" ? "$2" : "$4";
  const end = period === "current" ? "$3" : "$5";
  return `${alias}."${timestampColumn}" >= (${start}::date::timestamp AT TIME ZONE $6)
    AND ${alias}."${timestampColumn}" < (((${end}::date + 1)::timestamp) AT TIME ZONE $6)`;
}

function baseParams(guildId: string, range: AnalyticsRange) {
  return [guildId, range.startDate, range.endDate, range.previousStartDate, range.previousEndDate, range.timeZone, range.roleId, range.channelId, range.excludeBots];
}

async function loadRetention(guildId: string, range: AnalyticsRange, previous = false) {
  const startIndex = previous ? 4 : 2;
  const endIndex = previous ? 5 : 3;
  const result = await pool.query<NumericRow>(`
    WITH parameter_types AS (SELECT $2::date, $3::date, $4::date, $5::date), raw_joins AS (
      SELECT e."id", e."userId", e."occurredAt", e."roleIds", COALESCE(e."source", 'unknown') AS "source"
      FROM "guild_member_event" e
      WHERE e."guildId" = $1 AND e."eventType" = 'join'
        AND (NOT $9::boolean OR e."isBot" = false)
    ), all_joins AS (
      SELECT e."id", e."userId", e."occurredAt" AS "joinedAt", e."roleIds",
        LEAD(e."occurredAt") OVER (PARTITION BY e."userId" ORDER BY e."occurredAt", e."id") AS "nextJoinAt"
      FROM raw_joins e
      WHERE e."source" IN ('gateway', 'discord_live')
    ), joins AS (
      SELECT "id", "userId", "joinedAt", "roleIds", "nextJoinAt"
      FROM all_joins
      WHERE "joinedAt" >= ($${startIndex}::date::timestamp AT TIME ZONE $6)
        AND "joinedAt" < ((($${endIndex}::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR "roleIds" ? $7::text)
    ), enriched AS (
      SELECT joins.*,
        first_message."at" AS "firstMessageAt",
        first_voice."at" AS "firstVoiceAt",
        first_reaction."at" AS "firstReactionAt",
        first_received."at" AS "firstReactionReceivedAt",
        next_leave."at" AS "leftAt",
        EXISTS (
          SELECT 1 FROM "discord_message" m
          WHERE m."guildId" = $1 AND m."authorId" = joins."userId"
            AND m."createdAt" >= joins."joinedAt" + interval '7 day'
            AND m."createdAt" < joins."joinedAt" + interval '8 day'
            AND ($8::text IS NULL OR m."channelId" = $8::text)
            AND (NOT $9::boolean OR m."authorIsBot" = false)
          UNION ALL
          SELECT 1 FROM "voice_session" v
          WHERE v."guildId" = $1 AND v."userId" = joins."userId"
            AND v."startedAt" >= joins."joinedAt" + interval '7 day'
            AND v."startedAt" < joins."joinedAt" + interval '8 day'
            AND ($8::text IS NULL OR v."channelId" = $8::text)
            AND (NOT $9::boolean OR v."userIsBot" = false)
          UNION ALL
          SELECT 1 FROM "discord_reaction_event" r
          WHERE r."guildId" = $1 AND r."reactorId" = joins."userId"
            AND r."occurredAt" >= joins."joinedAt" + interval '7 day'
            AND r."occurredAt" < joins."joinedAt" + interval '8 day'
            AND ($8::text IS NULL OR r."channelId" = $8::text)
            AND (NOT $9::boolean OR r."reactorIsBot" = false)
        ) AS "retained7",
        EXISTS (
          SELECT 1 FROM "discord_message" m
          WHERE m."guildId" = $1 AND m."authorId" = joins."userId"
            AND m."createdAt" >= joins."joinedAt" + interval '30 day'
            AND m."createdAt" < joins."joinedAt" + interval '31 day'
            AND ($8::text IS NULL OR m."channelId" = $8::text)
            AND (NOT $9::boolean OR m."authorIsBot" = false)
          UNION ALL
          SELECT 1 FROM "voice_session" v
          WHERE v."guildId" = $1 AND v."userId" = joins."userId"
            AND v."startedAt" >= joins."joinedAt" + interval '30 day'
            AND v."startedAt" < joins."joinedAt" + interval '31 day'
            AND ($8::text IS NULL OR v."channelId" = $8::text)
            AND (NOT $9::boolean OR v."userIsBot" = false)
          UNION ALL
          SELECT 1 FROM "discord_reaction_event" r
          WHERE r."guildId" = $1 AND r."reactorId" = joins."userId"
            AND r."occurredAt" >= joins."joinedAt" + interval '30 day'
            AND r."occurredAt" < joins."joinedAt" + interval '31 day'
            AND ($8::text IS NULL OR r."channelId" = $8::text)
            AND (NOT $9::boolean OR r."reactorIsBot" = false)
        ) AS "retained30"
      FROM joins
      LEFT JOIN LATERAL (
        SELECT MIN(m."createdAt") AS "at" FROM "discord_message" m
        WHERE m."guildId" = $1 AND m."authorId" = joins."userId" AND m."createdAt" >= joins."joinedAt"
          AND (joins."nextJoinAt" IS NULL OR m."createdAt" < joins."nextJoinAt")
          AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      ) first_message ON true
      LEFT JOIN LATERAL (
        SELECT MIN(v."startedAt") AS "at" FROM "voice_session" v
        WHERE v."guildId" = $1 AND v."userId" = joins."userId" AND v."startedAt" >= joins."joinedAt"
          AND (joins."nextJoinAt" IS NULL OR v."startedAt" < joins."nextJoinAt")
          AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false)
      ) first_voice ON true
      LEFT JOIN LATERAL (
        SELECT MIN(r."occurredAt") AS "at" FROM "discord_reaction_event" r
        WHERE r."guildId" = $1 AND r."reactorId" = joins."userId" AND r."occurredAt" >= joins."joinedAt"
          AND (joins."nextJoinAt" IS NULL OR r."occurredAt" < joins."nextJoinAt")
          AND ($8::text IS NULL OR r."channelId" = $8::text) AND (NOT $9::boolean OR r."reactorIsBot" = false)
      ) first_reaction ON true
      LEFT JOIN LATERAL (
        SELECT MIN(r."occurredAt") AS "at" FROM "discord_reaction_event" r
        WHERE r."guildId" = $1 AND r."recipientId" = joins."userId" AND r."occurredAt" >= joins."joinedAt"
          AND (joins."nextJoinAt" IS NULL OR r."occurredAt" < joins."nextJoinAt")
          AND ($8::text IS NULL OR r."channelId" = $8::text)
      ) first_received ON true
      LEFT JOIN LATERAL (
        SELECT MIN(e."occurredAt") AS "at" FROM "guild_member_event" e
        WHERE e."guildId" = $1 AND e."userId" = joins."userId" AND e."eventType" = 'leave'
          AND e."occurredAt" >= joins."joinedAt" AND (joins."nextJoinAt" IS NULL OR e."occurredAt" < joins."nextJoinAt")
      ) next_leave ON true
    )
    SELECT
      COUNT(*)::int AS "joined",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day')::int AS "eligible7",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "retained7")::int AS "retained7",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '30 day')::int AS "eligible30",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '30 day' AND "retained30")::int AS "retained30",
      COUNT(*) FILTER (WHERE "firstMessageAt" < "joinedAt" + interval '1 hour')::int AS "message1h",
      COUNT(*) FILTER (WHERE "firstMessageAt" < "joinedAt" + interval '24 hour')::int AS "message24h",
      COUNT(*) FILTER (WHERE "firstMessageAt" < "joinedAt" + interval '7 day')::int AS "message7d",
      COUNT(*) FILTER (WHERE "firstMessageAt" IS NULL)::int AS "neverMessaged",
      COUNT(*) FILTER (WHERE "firstVoiceAt" < "joinedAt" + interval '24 hour')::int AS "voice24h",
      COUNT(*) FILTER (WHERE "firstVoiceAt" < "joinedAt" + interval '7 day')::int AS "voice7d",
      COUNT(*) FILTER (WHERE "firstVoiceAt" IS NULL)::int AS "neverVoice",
      AVG(EXTRACT(EPOCH FROM ("firstVoiceAt" - "joinedAt"))) FILTER (WHERE "firstVoiceAt" IS NOT NULL)::int AS "averageFirstVoiceSeconds",
      COUNT(*) FILTER (WHERE "firstReactionAt" IS NOT NULL)::int AS "reacted",
      COUNT(*) FILTER (WHERE "firstReactionReceivedAt" IS NOT NULL)::int AS "reactionReceived",
      COUNT(*) FILTER (WHERE "leftAt" < "joinedAt" + interval '24 hour')::int AS "left24h",
      COUNT(*) FILTER (WHERE "leftAt" < "joinedAt" + interval '3 day')::int AS "left3d",
      COUNT(*) FILTER (WHERE "leftAt" < "joinedAt" + interval '7 day')::int AS "left7d",
      COUNT(*) FILTER (WHERE "leftAt" < "joinedAt" + interval '30 day')::int AS "left30d",
      AVG(EXTRACT(EPOCH FROM ("leftAt" - "joinedAt"))) FILTER (WHERE "leftAt" IS NOT NULL)::int AS "averageTenureSeconds",
      COUNT(*) FILTER (WHERE "firstMessageAt" IS NOT NULL)::int AS "messageAny",
      COUNT(*) FILTER (WHERE "firstVoiceAt" IS NOT NULL)::int AS "voiceAny",
      COUNT(*) FILTER (WHERE "firstReactionAt" IS NOT NULL OR "firstReactionReceivedAt" IS NOT NULL)::int AS "reactionAny",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstMessageAt" IS NOT NULL)::int AS "eligible7Messaged",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstMessageAt" IS NOT NULL AND "retained7")::int AS "retained7Messaged",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstMessageAt" IS NULL)::int AS "eligible7NoMessage",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstMessageAt" IS NULL AND "retained7")::int AS "retained7NoMessage",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstVoiceAt" IS NOT NULL)::int AS "eligible7Voice",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstVoiceAt" IS NOT NULL AND "retained7")::int AS "retained7Voice",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstVoiceAt" IS NULL)::int AS "eligible7NoVoice",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstVoiceAt" IS NULL AND "retained7")::int AS "retained7NoVoice",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND ("firstReactionAt" IS NOT NULL OR "firstReactionReceivedAt" IS NOT NULL))::int AS "eligible7Reaction",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND ("firstReactionAt" IS NOT NULL OR "firstReactionReceivedAt" IS NOT NULL) AND "retained7")::int AS "retained7Reaction",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstReactionAt" IS NULL AND "firstReactionReceivedAt" IS NULL)::int AS "eligible7NoReaction",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND "firstReactionAt" IS NULL AND "firstReactionReceivedAt" IS NULL AND "retained7")::int AS "retained7NoReaction",
      (SELECT COUNT(*)::int FROM raw_joins source_join
        WHERE source_join."occurredAt" >= ($${startIndex}::date::timestamp AT TIME ZONE $6)
          AND source_join."occurredAt" < ((($${endIndex}::date + 1)::timestamp) AT TIME ZONE $6)
          AND ($7::text IS NULL OR source_join."roleIds" ? $7::text)
          AND source_join."source" IN ('gateway', 'discord_live')) AS "discordLiveJoins",
      (SELECT COUNT(*)::int FROM raw_joins source_join
        WHERE source_join."occurredAt" >= ($${startIndex}::date::timestamp AT TIME ZONE $6)
          AND source_join."occurredAt" < ((($${endIndex}::date + 1)::timestamp) AT TIME ZONE $6)
          AND ($7::text IS NULL OR source_join."roleIds" ? $7::text)
          AND source_join."source" = 'discord_sync') AS "discordSyncJoins",
      (SELECT COUNT(*)::int FROM raw_joins source_join
        WHERE source_join."occurredAt" >= ($${startIndex}::date::timestamp AT TIME ZONE $6)
          AND source_join."occurredAt" < ((($${endIndex}::date + 1)::timestamp) AT TIME ZONE $6)
          AND ($7::text IS NULL OR source_join."roleIds" ? $7::text)
          AND source_join."source" = 'historical_import') AS "historicalImportJoins",
      (SELECT COUNT(*)::int FROM raw_joins source_join
        WHERE source_join."occurredAt" >= ($${startIndex}::date::timestamp AT TIME ZONE $6)
          AND source_join."occurredAt" < ((($${endIndex}::date + 1)::timestamp) AT TIME ZONE $6)
          AND ($7::text IS NULL OR source_join."roleIds" ? $7::text)
          AND source_join."source" NOT IN ('gateway', 'discord_live', 'discord_sync', 'historical_import')) AS "unknownJoins"
    FROM enriched
  `, baseParams(guildId, range));
  const row = result.rows[0] ?? {};
  return {
    joined: number(row.joined),
    sourceQuality: {
      discordLive: number(row.discordLiveJoins),
      discordSync: number(row.discordSyncJoins),
      historicalImport: number(row.historicalImportJoins),
      unknown: number(row.unknownJoins),
    },
    retention7: { eligible: number(row.eligible7), retained: number(row.retained7), rate: nullableRate(row.retained7, row.eligible7) },
    retention30: { eligible: number(row.eligible30), retained: number(row.retained30), rate: nullableRate(row.retained30, row.eligible30) },
    firstMessage: {
      within1Hour: number(row.message1h), within24Hours: number(row.message24h), within7Days: number(row.message7d), never: number(row.neverMessaged),
      rate: nullableRate(row.messageAny, row.joined),
    },
    firstVoice: {
      within24Hours: number(row.voice24h), within7Days: number(row.voice7d), never: number(row.neverVoice), averageSeconds: row.averageFirstVoiceSeconds === null ? null : number(row.averageFirstVoiceSeconds),
      rate: nullableRate(row.voiceAny, row.joined),
    },
    reactions: { made: number(row.reacted), received: number(row.reactionReceived), any: number(row.reactionAny), rate: nullableRate(row.reactionAny, row.joined) },
    departures: {
      within24Hours: number(row.left24h), within3Days: number(row.left3d), within7Days: number(row.left7d), within30Days: number(row.left30d),
      averageTenureSeconds: row.averageTenureSeconds === null ? null : number(row.averageTenureSeconds),
    },
    behavior: [
      { key: "message", withRate: nullableRate(row.retained7Messaged, row.eligible7Messaged), withoutRate: nullableRate(row.retained7NoMessage, row.eligible7NoMessage), withSample: number(row.eligible7Messaged), withoutSample: number(row.eligible7NoMessage) },
      { key: "voice", withRate: nullableRate(row.retained7Voice, row.eligible7Voice), withoutRate: nullableRate(row.retained7NoVoice, row.eligible7NoVoice), withSample: number(row.eligible7Voice), withoutSample: number(row.eligible7NoVoice) },
      { key: "reaction", withRate: nullableRate(row.retained7Reaction, row.eligible7Reaction), withoutRate: nullableRate(row.retained7NoReaction, row.eligible7NoReaction), withSample: number(row.eligible7Reaction), withoutSample: number(row.eligible7NoReaction) },
    ],
  };
}

async function loadCohorts(guildId: string, range: AnalyticsRange) {
  const result = await pool.query<NumericRow>(`
    WITH parameter_types AS (SELECT $4::date, $5::date), joins AS (
      SELECT e."userId", e."occurredAt" AS "joinedAt"
      FROM "guild_member_event" e
      WHERE e."guildId" = $1 AND e."eventType" = 'join'
        AND e."source" IN ('gateway', 'discord_live')
        AND ${boundsSql("e", "occurredAt", "current")}
        AND (NOT $9::boolean OR e."isBot" = false)
        AND ($7::text IS NULL OR e."roleIds" ? $7::text)
    )
    SELECT to_char(date_trunc('week', "joinedAt" AT TIME ZONE $6), 'YYYY-MM-DD') AS "cohort",
      COUNT(*)::int AS "joined",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '1 day')::int AS "eligible1",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '1 day' AND EXISTS (
        SELECT 1 FROM "discord_message" m WHERE m."guildId" = $1 AND m."authorId" = joins."userId"
          AND m."createdAt" >= joins."joinedAt" + interval '1 day' AND m."createdAt" < joins."joinedAt" + interval '2 day'
          AND ($8::text IS NULL OR m."channelId" = $8::text)
        UNION ALL SELECT 1 FROM "voice_session" v WHERE v."guildId" = $1 AND v."userId" = joins."userId"
          AND v."startedAt" >= joins."joinedAt" + interval '1 day' AND v."startedAt" < joins."joinedAt" + interval '2 day'
          AND ($8::text IS NULL OR v."channelId" = $8::text)
        UNION ALL SELECT 1 FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND r."reactorId" = joins."userId"
          AND r."occurredAt" >= joins."joinedAt" + interval '1 day' AND r."occurredAt" < joins."joinedAt" + interval '2 day'
          AND ($8::text IS NULL OR r."channelId" = $8::text)))::int AS "day1",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day')::int AS "eligible7",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '7 day' AND EXISTS (
        SELECT 1 FROM "discord_message" m WHERE m."guildId" = $1 AND m."authorId" = joins."userId"
          AND m."createdAt" >= joins."joinedAt" + interval '7 day' AND m."createdAt" < joins."joinedAt" + interval '8 day'
          AND ($8::text IS NULL OR m."channelId" = $8::text)
        UNION ALL SELECT 1 FROM "voice_session" v WHERE v."guildId" = $1 AND v."userId" = joins."userId"
          AND v."startedAt" >= joins."joinedAt" + interval '7 day' AND v."startedAt" < joins."joinedAt" + interval '8 day'
          AND ($8::text IS NULL OR v."channelId" = $8::text)
        UNION ALL SELECT 1 FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND r."reactorId" = joins."userId"
          AND r."occurredAt" >= joins."joinedAt" + interval '7 day' AND r."occurredAt" < joins."joinedAt" + interval '8 day'
          AND ($8::text IS NULL OR r."channelId" = $8::text)))::int AS "day7",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '30 day')::int AS "eligible30",
      COUNT(*) FILTER (WHERE "joinedAt" <= now() - interval '30 day' AND EXISTS (
        SELECT 1 FROM "discord_message" m WHERE m."guildId" = $1 AND m."authorId" = joins."userId"
          AND m."createdAt" >= joins."joinedAt" + interval '30 day' AND m."createdAt" < joins."joinedAt" + interval '31 day'
          AND ($8::text IS NULL OR m."channelId" = $8::text)
        UNION ALL SELECT 1 FROM "voice_session" v WHERE v."guildId" = $1 AND v."userId" = joins."userId"
          AND v."startedAt" >= joins."joinedAt" + interval '30 day' AND v."startedAt" < joins."joinedAt" + interval '31 day'
          AND ($8::text IS NULL OR v."channelId" = $8::text)
        UNION ALL SELECT 1 FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND r."reactorId" = joins."userId"
          AND r."occurredAt" >= joins."joinedAt" + interval '30 day' AND r."occurredAt" < joins."joinedAt" + interval '31 day'
          AND ($8::text IS NULL OR r."channelId" = $8::text)))::int AS "day30"
    FROM joins GROUP BY date_trunc('week', "joinedAt" AT TIME ZONE $6) ORDER BY 1
  `, baseParams(guildId, range));
  return result.rows.map((row) => ({
    cohort: String(row.cohort), joined: number(row.joined),
    day1: { eligible: number(row.eligible1), retained: number(row.day1), rate: nullableRate(row.day1, row.eligible1) },
    day7: { eligible: number(row.eligible7), retained: number(row.day7), rate: nullableRate(row.day7, row.eligible7) },
    day30: { eligible: number(row.eligible30), retained: number(row.day30), rate: nullableRate(row.day30, row.eligible30) },
  }));
}

async function loadCoreMetrics(guildId: string, range: AnalyticsRange) {
  const result = await pool.query<NumericRow>(`
    SELECT
      (SELECT COUNT(*) FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", "current")}
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false))::int AS "messages",
      (SELECT COUNT(*) FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", "previous")}
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false))::int AS "previousMessages",
      (SELECT COUNT(DISTINCT m."authorId") FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", "current")}
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false))::int AS "activeUsers",
      (SELECT COUNT(DISTINCT m."authorId") FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", "previous")}
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false))::int AS "previousActiveUsers",
      (SELECT COUNT(DISTINCT activity."userId") FROM (
        SELECT m."authorId" AS "userId" FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", "current")}
          AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
        UNION
        SELECT v."userId" FROM "voice_session" v WHERE v."guildId" = $1
          AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
          AND (v."endedAt" IS NULL OR v."endedAt" > ($2::date::timestamp AT TIME ZONE $6))
          AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false)
        UNION
        SELECT r."reactorId" FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND ${boundsSql("r", "occurredAt", "current")}
          AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text) AND ($8::text IS NULL OR r."channelId" = $8::text) AND (NOT $9::boolean OR r."reactorIsBot" = false)
      ) activity)::int AS "activityUsers",
      (SELECT COUNT(DISTINCT activity."userId") FROM (
        SELECT m."authorId" AS "userId" FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", "previous")}
          AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
        UNION
        SELECT v."userId" FROM "voice_session" v WHERE v."guildId" = $1
          AND v."startedAt" < ((($5::date + 1)::timestamp) AT TIME ZONE $6)
          AND (v."endedAt" IS NULL OR v."endedAt" > ($4::date::timestamp AT TIME ZONE $6))
          AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false)
        UNION
        SELECT r."reactorId" FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND ${boundsSql("r", "occurredAt", "previous")}
          AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text) AND ($8::text IS NULL OR r."channelId" = $8::text) AND (NOT $9::boolean OR r."reactorIsBot" = false)
      ) activity)::int AS "previousActivityUsers",
      (SELECT COUNT(*) FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND ${boundsSql("r", "occurredAt", "current")}
        AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text) AND ($8::text IS NULL OR r."channelId" = $8::text) AND (NOT $9::boolean OR r."reactorIsBot" = false))::int AS "reactions",
      (SELECT COUNT(*) FROM "discord_reaction_event" r WHERE r."guildId" = $1 AND ${boundsSql("r", "occurredAt", "previous")}
        AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text) AND ($8::text IS NULL OR r."channelId" = $8::text) AND (NOT $9::boolean OR r."reactorIsBot" = false))::int AS "previousReactions",
      (SELECT COUNT(DISTINCT v."userId") FROM "voice_session" v WHERE v."guildId" = $1
        AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6) AND (v."endedAt" IS NULL OR v."endedAt" > ($2::date::timestamp AT TIME ZONE $6))
        AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false))::int AS "voiceUsers",
      (SELECT COUNT(DISTINCT v."userId") FROM "voice_session" v WHERE v."guildId" = $1
        AND v."startedAt" < ((($5::date + 1)::timestamp) AT TIME ZONE $6) AND (v."endedAt" IS NULL OR v."endedAt" > ($4::date::timestamp AT TIME ZONE $6))
        AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false))::int AS "previousVoiceUsers",
      (SELECT COUNT(*) FROM "voice_session" v WHERE v."guildId" = $1 AND ${boundsSql("v", "startedAt", "current")}
        AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false))::int AS "voiceSessions",
      (SELECT COUNT(*) FROM "voice_session" v WHERE v."guildId" = $1 AND ${boundsSql("v", "startedAt", "previous")}
        AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false))::int AS "previousVoiceSessions",
      (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(v."endedAt", now()), ((($3::date + 1)::timestamp) AT TIME ZONE $6)) - GREATEST(v."startedAt", ($2::date::timestamp AT TIME ZONE $6))))), 0)
        FROM "voice_session" v WHERE v."guildId" = $1 AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
          AND (v."endedAt" IS NULL OR v."endedAt" >= ($2::date::timestamp AT TIME ZONE $6))
          AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false))::int AS "voiceSeconds",
      (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(v."endedAt", now()), ((($5::date + 1)::timestamp) AT TIME ZONE $6)) - GREATEST(v."startedAt", ($4::date::timestamp AT TIME ZONE $6))))), 0)
        FROM "voice_session" v WHERE v."guildId" = $1 AND v."startedAt" < ((($5::date + 1)::timestamp) AT TIME ZONE $6)
          AND (v."endedAt" IS NULL OR v."endedAt" >= ($4::date::timestamp AT TIME ZONE $6))
          AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false))::int AS "previousVoiceSeconds",
      (SELECT COUNT(*) FROM "guild_member_event" e WHERE e."guildId" = $1 AND e."eventType" = 'join' AND e."source" IN ('gateway', 'discord_live') AND ${boundsSql("e", "occurredAt", "current")} AND (NOT $9::boolean OR e."isBot" = false))::int AS "joins",
      (SELECT COUNT(*) FROM "guild_member_event" e WHERE e."guildId" = $1 AND e."eventType" = 'join' AND e."source" IN ('gateway', 'discord_live') AND ${boundsSql("e", "occurredAt", "previous")} AND (NOT $9::boolean OR e."isBot" = false))::int AS "previousJoins",
      (SELECT COUNT(*) FROM "guild_member_event" e WHERE e."guildId" = $1 AND e."eventType" = 'leave' AND e."source" IN ('gateway', 'discord_live') AND ${boundsSql("e", "occurredAt", "current")} AND (NOT $9::boolean OR e."isBot" = false))::int AS "leaves",
      (SELECT COUNT(*) FROM "guild_member_event" e WHERE e."guildId" = $1 AND e."eventType" = 'leave' AND e."source" IN ('gateway', 'discord_live') AND ${boundsSql("e", "occurredAt", "previous")} AND (NOT $9::boolean OR e."isBot" = false))::int AS "previousLeaves",
      COALESCE((SELECT "memberCount" FROM "bot_guild_registry" WHERE "guildId" = $1), 0)::int AS "memberCount",
      COALESCE((SELECT "memberCount" FROM "daily_stats" WHERE "guildId" = $1 AND "date" <= $5::date ORDER BY "date" DESC LIMIT 1), 0)::int AS "previousMemberCount"
  `, baseParams(guildId, range));
  const row = result.rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, number(value)])) as Record<string, number>;
}

async function loadChannels(guildId: string, range: AnalyticsRange) {
  const params = baseParams(guildId, range);
  const [registry, messages, reactions, voice, voicePeaks] = await Promise.all([
    pool.query<NumericRow>(`SELECT "channelId", "channelName", "channelType", "deletedAt" FROM "guild_channel_registry" WHERE "guildId" = $1`, [guildId]),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $8::text)
      SELECT COALESCE(m."channelId", 'name:' || m."channelName") AS "channelKey", MAX(m."channelId") AS "channelId", MAX(m."channelName") AS "channelName",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "messages",
        COUNT(DISTINCT m."authorId") FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "uniqueAuthors",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")})::int AS "previousMessages"
      FROM "discord_message" m WHERE m."guildId" = $1
        AND m."createdAt" >= ($4::date::timestamp AT TIME ZONE $6)
        AND m."createdAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      GROUP BY COALESCE(m."channelId", 'name:' || m."channelName")
    `, params),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $5::date, $8::text)
      SELECT r."channelId", COUNT(*) FILTER (WHERE ${boundsSql("r", "occurredAt", "current")})::int AS "reactions"
      FROM "discord_reaction_event" r WHERE r."guildId" = $1
        AND r."occurredAt" >= ($4::date::timestamp AT TIME ZONE $6) AND r."occurredAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text) AND (NOT $9::boolean OR r."reactorIsBot" = false)
      GROUP BY r."channelId"
    `, params),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $8::text)
      SELECT v."channelId",
        COUNT(DISTINCT v."userId") FILTER (WHERE ${boundsSql("v", "startedAt", "current")})::int AS "voiceUsers",
        COUNT(*) FILTER (WHERE ${boundsSql("v", "startedAt", "current")})::int AS "voiceSessions",
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(v."endedAt", now()) - v."startedAt"))) FILTER (WHERE ${boundsSql("v", "startedAt", "current")}), 0)::int AS "voiceSeconds",
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(v."endedAt", now()) - v."startedAt"))) FILTER (WHERE ${boundsSql("v", "startedAt", "previous")}), 0)::int AS "previousVoiceSeconds"
      FROM "voice_session" v WHERE v."guildId" = $1
        AND v."startedAt" >= ($4::date::timestamp AT TIME ZONE $6) AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND (NOT $9::boolean OR v."userIsBot" = false)
      GROUP BY v."channelId"
    `, params),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $4::date, $5::date, $8::text), selected AS (
        SELECT v."channelId", GREATEST(v."startedAt", ($2::date::timestamp AT TIME ZONE $6)) AS "startedAt",
          LEAST(COALESCE(v."endedAt", now()), ((($3::date + 1)::timestamp) AT TIME ZONE $6)) AS "endedAt"
        FROM "voice_session" v WHERE v."guildId" = $1
          AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
          AND (v."endedAt" IS NULL OR v."endedAt" >= ($2::date::timestamp AT TIME ZONE $6))
          AND ($7::text IS NULL OR v."userRoleIds" ? $7::text) AND (NOT $9::boolean OR v."userIsBot" = false)
      ), events AS (
        SELECT "channelId", "startedAt" AS "at", 1 AS delta FROM selected
        UNION ALL SELECT "channelId", "endedAt" AS "at", -1 AS delta FROM selected
      ), running AS (
        SELECT "channelId", SUM(delta) OVER (PARTITION BY "channelId" ORDER BY "at", delta DESC ROWS UNBOUNDED PRECEDING) AS concurrent FROM events
      )
      SELECT "channelId", MAX(concurrent)::int AS "peakConcurrentUsers" FROM running GROUP BY "channelId"
    `, params),
  ]);
  const map = new Map<string, any>();
  for (const row of registry.rows) map.set(String(row.channelId), {
    channelId: String(row.channelId), name: String(row.channelName), type: String(row.channelType), deleted: Boolean(row.deletedAt),
    messages: 0, previousMessages: 0, uniqueAuthors: 0, reactions: 0, voiceUsers: 0, voiceSeconds: 0, previousVoiceSeconds: 0, voiceSessions: 0,
  });
  for (const row of messages.rows) {
    const key = row.channelId ? String(row.channelId) : String(row.channelKey);
    const item = map.get(key) ?? { channelId: row.channelId ? String(row.channelId) : null, name: String(row.channelName || "Deleted Channel"), type: "unknown", deleted: !row.channelId, reactions: 0, voiceUsers: 0, voiceSeconds: 0, previousVoiceSeconds: 0, voiceSessions: 0 };
    Object.assign(item, { messages: number(row.messages), previousMessages: number(row.previousMessages), uniqueAuthors: number(row.uniqueAuthors) });
    map.set(key, item);
  }
  for (const row of reactions.rows) {
    if (!row.channelId) continue;
    const item = map.get(String(row.channelId));
    if (item) item.reactions = number(row.reactions);
  }
  for (const row of voice.rows) {
    const item = map.get(String(row.channelId));
    if (item) Object.assign(item, { voiceUsers: number(row.voiceUsers), voiceSeconds: number(row.voiceSeconds), previousVoiceSeconds: number(row.previousVoiceSeconds), voiceSessions: number(row.voiceSessions) });
  }
  for (const row of voicePeaks.rows) {
    const item = map.get(String(row.channelId));
    if (item) item.peakConcurrentUsers = number(row.peakConcurrentUsers);
  }
  const totalMessages = [...map.values()].reduce((sum, item) => sum + item.messages, 0);
  return [...map.values()].map((item) => {
    const change = comparison(item.messages || item.voiceSeconds, item.previousMessages || item.previousVoiceSeconds, { minimumSample: item.messages ? 5 : 300 });
    return {
      ...item,
      reactionRate: nullableRate(item.reactions, item.messages),
      messagesPerActiveUser: item.uniqueAuthors ? Math.round((item.messages / item.uniqueAuthors) * 10) / 10 : null,
      share: nullableRate(item.messages, totalMessages),
      trendPercent: change.percent,
      status: channelStatus({ current: item.messages || item.voiceSeconds, previous: item.previousMessages || item.previousVoiceSeconds, uniqueUsers: item.uniqueAuthors || item.voiceUsers }),
      averageVoiceSessionSeconds: item.voiceSessions ? Math.round(item.voiceSeconds / item.voiceSessions) : null,
      peakConcurrentUsers: item.peakConcurrentUsers ?? 0,
    };
  }).filter((item) => !range.channelId || item.channelId === range.channelId).sort((left, right) => (right.messages + right.voiceSeconds / 60) - (left.messages + left.voiceSeconds / 60));
}

async function loadRoles(guildId: string, range: AnalyticsRange, core: Record<string, number>) {
  const params = baseParams(guildId, range);
  const [registry, messages, reactions, voice] = await Promise.all([
    pool.query<NumericRow>(`SELECT "roleId", "roleName", "memberCount", "isManaged", "isBotRole", "isEveryone", "deletedAt" FROM "guild_role_registry" WHERE "guildId" = $1`, [guildId]),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $7::text)
      SELECT role."roleId", COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "messages",
        COUNT(DISTINCT m."authorId") FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "activeMembers",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")})::int AS "previousMessages"
      FROM "discord_message" m CROSS JOIN LATERAL jsonb_array_elements_text(m."authorRoleIds") role("roleId")
      WHERE m."guildId" = $1 AND m."createdAt" >= ($4::date::timestamp AT TIME ZONE $6) AND m."createdAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      GROUP BY role."roleId"
    `, params),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $5::date, $7::text)
      SELECT role."roleId", COUNT(*) FILTER (WHERE ${boundsSql("r", "occurredAt", "current")})::int AS "reactions"
      FROM "discord_reaction_event" r CROSS JOIN LATERAL jsonb_array_elements_text(r."reactorRoleIds") role("roleId")
      WHERE r."guildId" = $1 AND r."occurredAt" >= ($4::date::timestamp AT TIME ZONE $6) AND r."occurredAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($8::text IS NULL OR r."channelId" = $8::text) AND (NOT $9::boolean OR r."reactorIsBot" = false)
      GROUP BY role."roleId"
    `, params),
    pool.query<NumericRow>(`
      WITH parameter_types AS (SELECT $5::date, $7::text)
      SELECT role."roleId", COUNT(DISTINCT v."userId") FILTER (WHERE ${boundsSql("v", "startedAt", "current")})::int AS "voiceUsers",
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(v."endedAt", now()) - v."startedAt"))) FILTER (WHERE ${boundsSql("v", "startedAt", "current")}), 0)::int AS "voiceSeconds"
      FROM "voice_session" v CROSS JOIN LATERAL jsonb_array_elements_text(v."userRoleIds") role("roleId")
      WHERE v."guildId" = $1 AND v."startedAt" >= ($4::date::timestamp AT TIME ZONE $6) AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($8::text IS NULL OR v."channelId" = $8::text) AND (NOT $9::boolean OR v."userIsBot" = false)
      GROUP BY role."roleId"
    `, params),
  ]);
  const map = new Map<string, any>();
  for (const row of registry.rows) map.set(String(row.roleId), {
    roleId: String(row.roleId), name: String(row.roleName), memberCount: number(row.memberCount), isManaged: Boolean(row.isManaged), isBotRole: Boolean(row.isBotRole), isEveryone: Boolean(row.isEveryone), deleted: Boolean(row.deletedAt),
    messages: 0, previousMessages: 0, activeMembers: 0, reactions: 0, voiceUsers: 0, voiceSeconds: 0,
  });
  for (const result of [messages.rows, reactions.rows, voice.rows]) {
    for (const row of result) {
      const item = map.get(String(row.roleId));
      if (item) Object.assign(item, Object.fromEntries(Object.entries(row).filter(([key]) => key !== "roleId").map(([key, value]) => [key, number(value)])));
    }
  }
  for (const item of map.values()) {
    if (item.isEveryone) Object.assign(item, { messages: core.messages, previousMessages: core.previousMessages, activeMembers: core.activeUsers, reactions: core.reactions, voiceUsers: core.voiceUsers, voiceSeconds: core.voiceSeconds });
  }
  return [...map.values()]
    .filter((item) => (!range.excludeBots || !item.isBotRole) && (!range.roleId || item.roleId === range.roleId))
    .map((item) => ({ ...item, activeRate: nullableRate(item.activeMembers, item.memberCount), messageShare: nullableRate(item.messages, core.messages), trendPercent: comparison(item.messages, item.previousMessages, { minimumSample: 5 }).percent }))
    .sort((left, right) => right.messages - left.messages || right.activeMembers - left.activeMembers);
}

async function loadDistribution(guildId: string, range: AnalyticsRange, previous = false) {
  const period = previous ? "previous" : "current";
  const result = await pool.query<{ share: number | null }>(`
    WITH parameter_types AS (SELECT $2::date, $3::date, $4::date, $5::date), counts AS (
      SELECT m."authorId", COUNT(*)::numeric AS value
      FROM "discord_message" m WHERE m."guildId" = $1 AND ${boundsSql("m", "createdAt", period)}
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      GROUP BY m."authorId"
    ), ranked AS (
      SELECT value, ROW_NUMBER() OVER (ORDER BY value DESC) AS rank, COUNT(*) OVER () AS authors, SUM(value) OVER () AS total FROM counts
    )
    SELECT ROUND((SUM(value) FILTER (WHERE rank <= GREATEST(1, CEIL(authors * 0.1))) / NULLIF(MAX(total), 0)) * 100, 1)::float AS share FROM ranked
  `, baseParams(guildId, range));
  return result.rows[0]?.share === null || result.rows[0]?.share === undefined ? null : Number(result.rows[0].share);
}

async function loadDiagnostics(guildId: string, range: AnalyticsRange, core: Record<string, number>, retention: any, previousRetention: any, channels: any[], roles: any[]) {
  const params = baseParams(guildId, range);
  const [timeRows, memberRows, lifecycleRows] = await Promise.all([
    pool.query<NumericRow>(`
      SELECT FLOOR(EXTRACT(HOUR FROM m."createdAt" AT TIME ZONE $6) / 3)::int * 3 AS "hour",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "current",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")})::int AS "previous"
      FROM "discord_message" m WHERE m."guildId" = $1 AND m."createdAt" >= ($4::date::timestamp AT TIME ZONE $6) AND m."createdAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      GROUP BY 1 ORDER BY 1
    `, params),
    pool.query<NumericRow>(`
      SELECT m."authorId", MAX(m."authorName") AS "authorName",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "current",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")})::int AS "previous"
      FROM "discord_message" m WHERE m."guildId" = $1 AND m."createdAt" >= ($4::date::timestamp AT TIME ZONE $6) AND m."createdAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      GROUP BY m."authorId" ORDER BY ABS(COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")}) - COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")})) DESC LIMIT 10
    `, params),
    pool.query<NumericRow>(`
      WITH first_join AS (SELECT "userId", MIN("occurredAt") AS "joinedAt" FROM "guild_member_event" WHERE "guildId" = $1 AND "eventType" = 'join' GROUP BY "userId")
      SELECT CASE WHEN first_join."joinedAt" >= ($2::date::timestamp AT TIME ZONE $6) THEN 'new' ELSE 'existing' END AS segment,
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")})::int AS "current",
        COUNT(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")})::int AS "previous"
      FROM "discord_message" m LEFT JOIN first_join ON first_join."userId" = m."authorId"
      WHERE m."guildId" = $1 AND m."createdAt" >= ($4::date::timestamp AT TIME ZONE $6) AND m."createdAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND ($8::text IS NULL OR m."channelId" = $8::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
      GROUP BY 1
    `, params),
  ]);
  const totalDelta = core.messages - core.previousMessages;
  const decorate = (current: number, previous: number) => {
    const change = comparison(current, previous, { minimumSample: 5 });
    return { current, previous, delta: change.absolute, percent: change.percent, contribution: contribution(change.absolute, totalDelta), significant: change.significant };
  };
  const metrics = [
    { key: "messages", ...comparison(core.messages, core.previousMessages, { minimumSample: 10 }) },
    { key: "active_members", ...comparison(core.activeUsers, core.previousActiveUsers, { minimumSample: 3 }) },
    { key: "reaction_rate", current: nullableRate(core.reactions, core.messages), previous: nullableRate(core.previousReactions, core.previousMessages), absolute: percentagePointChange(nullableRate(core.reactions, core.messages), nullableRate(core.previousReactions, core.previousMessages)), percent: null },
    { key: "voice_activity", ...comparison(core.voiceSeconds, core.previousVoiceSeconds, { minimumSample: 300 }) },
    { key: "new_members", ...comparison(core.joins, core.previousJoins, { minimumSample: 3 }) },
    { key: "leave_count", ...comparison(core.leaves, core.previousLeaves, { minimumSample: 3 }) },
    { key: "retention", current: retention.retention7.rate, previous: previousRetention.retention7.rate, absolute: percentagePointChange(retention.retention7.rate, previousRetention.retention7.rate), percent: null },
  ];
  return {
    metrics,
    channels: channels.map((item) => ({ id: item.channelId, label: `#${item.name}`, ...decorate(item.messages, item.previousMessages) })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10),
    roles: roles.map((item) => ({ id: item.roleId, label: item.name, ...decorate(item.messages, item.previousMessages) })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10),
    times: timeRows.rows.map((row) => ({ id: String(row.hour), label: `${String(row.hour).padStart(2, "0")}:00–${String((number(row.hour) + 3) % 24).padStart(2, "0")}:00`, ...decorate(number(row.current), number(row.previous)) })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    members: memberRows.rows.map((row) => ({ id: String(row.authorId), label: String(row.authorName), ...decorate(number(row.current), number(row.previous)) })),
    lifecycle: lifecycleRows.rows.map((row) => ({ id: String(row.segment), label: String(row.segment), ...decorate(number(row.current), number(row.previous)) })),
  };
}

async function loadHeatmap(guildId: string, range: AnalyticsRange, channelId: string | null) {
  if (!channelId) return [];
  const result = await pool.query<NumericRow>(`
    WITH parameter_types AS (SELECT $4::date, $5::date)
    SELECT EXTRACT(ISODOW FROM m."createdAt" AT TIME ZONE $6)::int AS "day", EXTRACT(HOUR FROM m."createdAt" AT TIME ZONE $6)::int AS "hour", COUNT(*)::int AS "value"
    FROM "discord_message" m WHERE m."guildId" = $1 AND m."channelId" = $8 AND ${boundsSql("m", "createdAt", "current")}
      AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text) AND (NOT $9::boolean OR m."authorIsBot" = false)
    GROUP BY 1, 2 ORDER BY 1, 2
  `, baseParams(guildId, { ...range, channelId }));
  return result.rows.map((row) => ({ day: number(row.day), hour: number(row.hour), value: number(row.value) }));
}

function messageSourceCounts(row: NumericRow, prefix: "current" | "previous") {
  const live = number(row[`${prefix}LiveMessages`]);
  const historyImport = number(row[`${prefix}HistoryImportMessages`]);
  const existing = number(row[`${prefix}ExistingMessages`]);
  const unknown = number(row[`${prefix}UnknownMessages`]);
  const total = live + historyImport + existing + unknown;
  return {
    available: true,
    live,
    historyImport,
    existing,
    unknown,
    total,
    historyImportShare: total > 0 ? historyImport / total : 0,
  };
}

async function loadMessageSourceQuality(guildId: string, range: AnalyticsRange) {
  const unavailable = { available: false, live: 0, historyImport: 0, existing: 0, unknown: 0, total: 0, historyImportShare: 0 };
  if (!messageImportConfig.enabled) return { current: unavailable, previous: unavailable };
  const result = await pool.query<NumericRow>(`
    SELECT
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")} AND m."source" = 'live')::int AS "currentLiveMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")} AND m."source" = 'history_import')::int AS "currentHistoryImportMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")} AND m."source" = 'existing')::int AS "currentExistingMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "current")} AND m."source" NOT IN ('live', 'history_import', 'existing'))::int AS "currentUnknownMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")} AND m."source" = 'live')::int AS "previousLiveMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")} AND m."source" = 'history_import')::int AS "previousHistoryImportMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")} AND m."source" = 'existing')::int AS "previousExistingMessages",
      count(*) FILTER (WHERE ${boundsSql("m", "createdAt", "previous")} AND m."source" NOT IN ('live', 'history_import', 'existing'))::int AS "previousUnknownMessages"
    FROM "discord_message" m
    WHERE m."guildId" = $1
      AND ($8::text IS NULL OR m."channelId" = $8)
      AND ($7::text IS NULL OR m."authorRoleIds" ? $7::text)
      AND (NOT $9::boolean OR m."authorIsBot" = false)
      AND ((${boundsSql("m", "createdAt", "current")}) OR (${boundsSql("m", "createdAt", "previous")}))
  `, baseParams(guildId, range));
  const row = result.rows[0] ?? {};
  return { current: messageSourceCounts(row, "current"), previous: messageSourceCounts(row, "previous") };
}

async function loadHealthQualityMetrics(guildId: string, range: AnalyticsRange) {
  const result = await pool.query<NumericRow>(`
    WITH scoped_voice AS (
      SELECT v.*,
        COALESCE(v."endedAt", now()) AS "observedEndAt",
        COUNT(*) OVER (
          PARTITION BY v."userId", v."channelId", v."startedAt", v."endedAt"
        ) AS "duplicateCount",
        LAG(COALESCE(v."endedAt", now())) OVER (
          PARTITION BY v."userId" ORDER BY v."startedAt", v."id"
        ) AS "previousEndAt"
      FROM "voice_session" v
      WHERE v."guildId" = $1
        AND v."startedAt" >= ($4::date::timestamp AT TIME ZONE $6)
        AND v."startedAt" < ((($3::date + 1)::timestamp) AT TIME ZONE $6)
        AND ($7::text IS NULL OR v."userRoleIds" ? $7::text)
        AND ($8::text IS NULL OR v."channelId" = $8::text)
        AND (NOT $9::boolean OR v."userIsBot" = false)
    ), classified_voice AS (
      SELECT *,
        ("startedAt" > now() + interval '5 minutes') AS "futureTimestamp",
        ("endedAt" IS NOT NULL AND "endedAt" < "startedAt") AS "negativeDuration",
        ("observedEndAt" - "startedAt" > interval '24 hours') AS "over24Hours",
        ("endedAt" IS NULL AND "startedAt" < now() - interval '24 hours') AS "unclosedOver24Hours",
        ("duplicateCount" > 1) AS "duplicateSession",
        ("previousEndAt" IS NOT NULL AND "previousEndAt" > "startedAt") AS "overlappingSession"
      FROM scoped_voice
    ), valid_voice AS (
      SELECT * FROM classified_voice
      WHERE NOT "futureTimestamp"
        AND NOT "negativeDuration"
        AND NOT "over24Hours"
        AND NOT "unclosedOver24Hours"
        AND NOT "duplicateSession"
        AND NOT "overlappingSession"
    ), reaction_tracking AS (
      SELECT MIN("occurredAt") AS "trackingSince"
      FROM "discord_reaction_event"
      WHERE "guildId" = $1
    )
    SELECT
      (SELECT MIN("startedAt") FROM "voice_session" WHERE "guildId" = $1) AS "voiceTrackingSince",
      (SELECT "trackingSince" FROM reaction_tracking) AS "reactionTrackingSince",
      COUNT(*) FILTER (WHERE ${boundsSql("valid_voice", "startedAt", "current")})::int AS "validVoiceSessions",
      COUNT(DISTINCT "userId") FILTER (WHERE ${boundsSql("valid_voice", "startedAt", "current")})::int AS "validVoiceUsers",
      COALESCE(SUM(EXTRACT(EPOCH FROM ("observedEndAt" - "startedAt"))) FILTER (WHERE ${boundsSql("valid_voice", "startedAt", "current")}), 0)::int AS "validVoiceSeconds",
      COUNT(*) FILTER (WHERE ${boundsSql("valid_voice", "startedAt", "previous")})::int AS "previousValidVoiceSessions",
      COUNT(DISTINCT "userId") FILTER (WHERE ${boundsSql("valid_voice", "startedAt", "previous")})::int AS "previousValidVoiceUsers",
      COALESCE(SUM(EXTRACT(EPOCH FROM ("observedEndAt" - "startedAt"))) FILTER (WHERE ${boundsSql("valid_voice", "startedAt", "previous")}), 0)::int AS "previousValidVoiceSeconds",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "current")} AND "over24Hours") AS "voiceOver24Hours",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "current")} AND "unclosedOver24Hours") AS "voiceUnclosedOver24Hours",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "current")} AND "futureTimestamp") AS "voiceFutureTimestamp",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "current")} AND "negativeDuration") AS "voiceNegativeDuration",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "current")} AND "duplicateSession") AS "voiceDuplicate",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "current")} AND "overlappingSession") AS "voiceOverlap",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "previous")} AND "over24Hours") AS "previousVoiceOver24Hours",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "previous")} AND "unclosedOver24Hours") AS "previousVoiceUnclosedOver24Hours",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "previous")} AND "futureTimestamp") AS "previousVoiceFutureTimestamp",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "previous")} AND "negativeDuration") AS "previousVoiceNegativeDuration",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "previous")} AND "duplicateSession") AS "previousVoiceDuplicate",
      (SELECT COUNT(*)::int FROM classified_voice WHERE ${boundsSql("classified_voice", "startedAt", "previous")} AND "overlappingSession") AS "previousVoiceOverlap",
      (SELECT COUNT(*)::int FROM "discord_reaction_event" r
        WHERE r."guildId" = $1 AND ${boundsSql("r", "occurredAt", "current")}
          AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text)
          AND ($8::text IS NULL OR r."channelId" = $8::text)
          AND (NOT $9::boolean OR r."reactorIsBot" = false)) AS "reactionEvents",
      (SELECT COUNT(*)::int FROM "discord_reaction_event" r
        WHERE r."guildId" = $1 AND ${boundsSql("r", "occurredAt", "previous")}
          AND ($7::text IS NULL OR r."reactorRoleIds" ? $7::text)
          AND ($8::text IS NULL OR r."channelId" = $8::text)
          AND (NOT $9::boolean OR r."reactorIsBot" = false)) AS "previousReactionEvents",
      CASE
        WHEN (SELECT "trackingSince" FROM reaction_tracking) IS NULL THEN 0
        WHEN (SELECT "trackingSince" FROM reaction_tracking) <= ($2::date::timestamp AT TIME ZONE $6) THEN $10::int
        ELSE LEAST($10::int, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
          LEAST(now(), ((($3::date + 1)::timestamp) AT TIME ZONE $6)) - (SELECT "trackingSince" FROM reaction_tracking)
        )) / 86400))::int)
      END AS "reactionObservationDays",
      CASE
        WHEN (SELECT "trackingSince" FROM reaction_tracking) IS NULL THEN 0
        WHEN (SELECT "trackingSince" FROM reaction_tracking) <= ($4::date::timestamp AT TIME ZONE $6) THEN $10::int
        WHEN (SELECT "trackingSince" FROM reaction_tracking) >= ((($5::date + 1)::timestamp) AT TIME ZONE $6) THEN 0
        ELSE LEAST($10::int, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
          ((($5::date + 1)::timestamp) AT TIME ZONE $6) - (SELECT "trackingSince" FROM reaction_tracking)
        )) / 86400))::int)
      END AS "previousReactionObservationDays"
    FROM valid_voice
  `, [...baseParams(guildId, range), range.days]);
  const row = result.rows[0] ?? {};
  const anomalies = (previous = false) => {
    const field = (suffix: string) => `${previous ? "previousVoice" : "voice"}${suffix}`;
    return {
      over24Hours: number(row[field("Over24Hours")]),
      unclosedOver24Hours: number(row[field("UnclosedOver24Hours")]),
      future: number(row[field("FutureTimestamp")]),
      negative: number(row[field("NegativeDuration")]),
      duplicate: number(row[field("Duplicate")]),
      overlap: number(row[field("Overlap")]),
    };
  };
  return {
    voiceTrackingSince: row.voiceTrackingSince ?? null,
    reactionTrackingSince: row.reactionTrackingSince ?? null,
    current: {
      validVoiceSessions: number(row.validVoiceSessions),
      validVoiceUsers: number(row.validVoiceUsers),
      validVoiceSeconds: number(row.validVoiceSeconds),
      voiceAnomalies: anomalies(),
      reactionEvents: number(row.reactionEvents),
      reactionObservationDays: number(row.reactionObservationDays),
    },
    previous: {
      validVoiceSessions: number(row.previousValidVoiceSessions),
      validVoiceUsers: number(row.previousValidVoiceUsers),
      validVoiceSeconds: number(row.previousValidVoiceSeconds),
      voiceAnomalies: anomalies(true),
      reactionEvents: number(row.previousReactionEvents),
      reactionObservationDays: number(row.previousReactionObservationDays),
    },
  };
}

async function computeCommunityAnalytics(guildId: string, range: AnalyticsRange) {
  const healthV2Release = resolveHealthV2ReleaseConfig();
  const [core, retention, previousRetention, cohorts, channels, topShare, previousTopShare, messageSourceQuality] = await Promise.all([
    loadCoreMetrics(guildId, range), loadRetention(guildId, range), loadRetention(guildId, range, true), loadCohorts(guildId, range), loadChannels(guildId, range), loadDistribution(guildId, range), loadDistribution(guildId, range, true), loadMessageSourceQuality(guildId, range),
  ]);
  const roles = await loadRoles(guildId, range, core);
  const observationResult = await pool.query<NumericRow>(`
    WITH tracking AS (
      SELECT LEAST(
        COALESCE((SELECT MIN("createdAt") FROM "discord_message" WHERE "guildId" = $1), now()),
        COALESCE((SELECT MIN("occurredAt") FROM "guild_member_event" WHERE "guildId" = $1), now()),
        COALESCE((SELECT MIN("startedAt") FROM "voice_session" WHERE "guildId" = $1), now()),
        COALESCE((SELECT MIN("occurredAt") FROM "discord_reaction_event" WHERE "guildId" = $1), now())
      ) AS "trackingSince"
    )
    SELECT CASE
      WHEN "trackingSince" <= ($3::date::timestamp AT TIME ZONE $5) THEN $2::int
      ELSE LEAST($2::int, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
        LEAST(now(), ((($4::date + 1)::timestamp) AT TIME ZONE $5)) - "trackingSince"
      )) / 86400))::int)
    END AS "observationDays",
    CASE
      WHEN "trackingSince" <= ($6::date::timestamp AT TIME ZONE $5) THEN $2::int
      WHEN "trackingSince" >= ((($7::date + 1)::timestamp) AT TIME ZONE $5) THEN 0
      ELSE LEAST($2::int, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
        ((($7::date + 1)::timestamp) AT TIME ZONE $5) - "trackingSince"
      )) / 86400))::int)
    END AS "previousObservationDays",
    (SELECT MIN("occurredAt") FROM "guild_member_event" WHERE "guildId" = $1) AS "memberTrackingSince",
    (SELECT MIN("startedAt") FROM "voice_session" WHERE "guildId" = $1) AS "voiceTrackingSince",
    (SELECT MIN("occurredAt") FROM "discord_reaction_event" WHERE "guildId" = $1) AS "reactionTrackingSince",
    (SELECT COUNT(*) FROM "discord_message" WHERE "guildId" = $1 AND "channelId" IS NOT NULL)::int AS "messagesWithChannelId",
    (SELECT COUNT(*) FROM "discord_message" WHERE "guildId" = $1)::int AS "storedMessages",
    (SELECT COUNT(*) FROM "discord_message" WHERE "guildId" = $1 AND jsonb_array_length("authorRoleIds") > 0)::int AS "messagesWithRoles"
    FROM tracking
  `, [guildId, range.days, range.startDate, range.endDate, range.timeZone, range.previousStartDate, range.previousEndDate]);
  const coverage = observationResult.rows[0] ?? {};
  const qualityMetrics = await loadHealthQualityMetrics(guildId, range);
  const currentQualityGate = createHealthDataQualityGate({
    observationDays: number(coverage.observationDays),
    messages: core.messages,
    activeUsers: core.activeUsers,
    uniqueAuthors: core.activeUsers,
    joins: core.joins,
    leaves: core.leaves,
    retention: {
      eligible7: retention.retention7.eligible,
      sources: retention.sourceQuality,
    },
    messageSources: messageSourceQuality.current,
    voice: {
      trackingSince: qualityMetrics.voiceTrackingSince,
      observationDays: number(coverage.observationDays),
      validSessions: qualityMetrics.current.validVoiceSessions,
      anomalies: qualityMetrics.current.voiceAnomalies,
    },
    reaction: {
      trackingSince: qualityMetrics.reactionTrackingSince,
      observationDays: qualityMetrics.current.reactionObservationDays,
      events: qualityMetrics.current.reactionEvents,
    },
  });
  const previousQualityGate = createHealthDataQualityGate({
    observationDays: number(coverage.previousObservationDays),
    messages: core.previousMessages,
    activeUsers: core.previousActiveUsers,
    uniqueAuthors: core.previousActiveUsers,
    joins: core.previousJoins,
    leaves: core.previousLeaves,
    retention: {
      eligible7: previousRetention.retention7.eligible,
      sources: previousRetention.sourceQuality,
    },
    messageSources: messageSourceQuality.previous,
    voice: {
      trackingSince: qualityMetrics.voiceTrackingSince,
      observationDays: number(coverage.previousObservationDays),
      validSessions: qualityMetrics.previous.validVoiceSessions,
      anomalies: qualityMetrics.previous.voiceAnomalies,
    },
    reaction: {
      trackingSince: qualityMetrics.reactionTrackingSince,
      observationDays: qualityMetrics.previous.reactionObservationDays,
      events: qualityMetrics.previous.reactionEvents,
    },
  });
  const healthInput = {
    memberCount: core.memberCount, activeUsers: core.activeUsers, activityUsers: core.activityUsers, messages: core.messages, reactions: core.reactions,
    reactionAvailable: currentQualityGate.sanitization.reactionUsable,
    retention7: currentQualityGate.sanitization.retentionUsable ? retention.retention7.rate : null,
    retention30: currentQualityGate.sanitization.retentionUsable ? retention.retention30.rate : null,
    topMemberShare: topShare, uniqueMessageAuthors: core.activeUsers,
    voiceUsers: currentQualityGate.sanitization.voiceUsable ? qualityMetrics.current.validVoiceUsers : null,
    voiceSeconds: currentQualityGate.sanitization.voiceUsable ? qualityMetrics.current.validVoiceSeconds : null,
    voiceSessions: currentQualityGate.sanitization.voiceUsable ? qualityMetrics.current.validVoiceSessions : 0,
    joins: core.joins, leaves: core.leaves,
    earlyLeaves: retention.departures.within7Days, observationDays: number(coverage.observationDays),
    qualityGatePassed: currentQualityGate.passes,
  };
  const previousHealthInput = {
    memberCount: core.previousMemberCount || core.memberCount, activeUsers: core.previousActiveUsers, activityUsers: core.previousActivityUsers, messages: core.previousMessages, reactions: core.previousReactions,
    reactionAvailable: previousQualityGate.sanitization.reactionUsable,
    retention7: previousQualityGate.sanitization.retentionUsable ? previousRetention.retention7.rate : null,
    retention30: previousQualityGate.sanitization.retentionUsable ? previousRetention.retention30.rate : null,
    topMemberShare: previousTopShare, uniqueMessageAuthors: core.previousActiveUsers,
    voiceUsers: previousQualityGate.sanitization.voiceUsable ? qualityMetrics.previous.validVoiceUsers : null,
    voiceSeconds: previousQualityGate.sanitization.voiceUsable ? qualityMetrics.previous.validVoiceSeconds : null,
    voiceSessions: previousQualityGate.sanitization.voiceUsable ? qualityMetrics.previous.validVoiceSessions : 0,
    joins: core.previousJoins, leaves: core.previousLeaves,
    earlyLeaves: previousRetention.departures.within7Days, observationDays: number(coverage.previousObservationDays),
    qualityGatePassed: previousQualityGate.passes,
  };
  const rawHealth = calculateHealthScore(healthInput);
  const rawPreviousHealth = calculateHealthScore(previousHealthInput);
  const health = {
    ...rawHealth,
    dataQuality: attachHealthScoresToQualityGate(currentQualityGate, rawHealth),
  };
  const previousHealth = {
    ...rawPreviousHealth,
    dataQuality: attachHealthScoresToQualityGate(previousQualityGate, rawPreviousHealth),
  };
  const topChannel = channels.find((channel) => channel.messages > 0) ?? null;
  const insights = buildInsights({
    messages: { current: core.messages, previous: core.previousMessages },
    retention: { current: retention.retention7.rate, previous: previousRetention.retention7.rate, eligible: retention.retention7.eligible },
    topChannel: topChannel ? { id: topChannel.channelId, name: topChannel.name, share: topChannel.share, change: comparison(topChannel.messages, topChannel.previousMessages, { minimumSample: 5 }) } : null,
    topMemberShare: topShare,
    voice: { current: core.voiceSeconds, previous: core.previousVoiceSeconds },
  });
  const diagnostics = await loadDiagnostics(guildId, range, core, retention, previousRetention, channels, roles);
  const heatmapChannelId = range.channelId ?? topChannel?.channelId ?? null;
  const heatmap = await loadHeatmap(guildId, range, heatmapChannelId);

  const snapshotCategories = {
    ...health.categories,
    _healthV2: {
      schemaVersion: 2,
      releaseStage: healthV2Release.stage,
      mode: healthV2Release.mode,
      official: healthV2Release.official,
      shadowScore: health.provisionalScore,
      formalCandidateScore: health.score,
      provisionalScore: health.provisionalScore,
      isProvisional: health.isProvisional,
      availabilityReason: health.availabilityReason,
      availableCategoryCount: health.availableCategoryCount,
      dataQuality: health.dataQuality,
    },
  };
  if (healthV2Release.official || healthV2Release.shadowWriteEnabled) {
    await pool.query(`
      INSERT INTO "analytics_health_snapshot" ("guildId", "date", "periodDays", "score", "confidence", "categories", "updatedAt")
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5::jsonb, now())
      ON CONFLICT ("guildId", "date", "periodDays") DO UPDATE SET "score" = EXCLUDED."score", "confidence" = EXCLUDED."confidence", "categories" = EXCLUDED."categories", "updatedAt" = now()
    `, [guildId, range.days, healthV2SnapshotScore(health, healthV2Release), health.confidence, JSON.stringify(snapshotCategories)]);
  }
  const historyResult = await pool.query<NumericRow>(`
    SELECT "date"::text AS "date", "score", "confidence", "categories" FROM "analytics_health_snapshot"
    WHERE "guildId" = $1 AND "periodDays" = $2 ORDER BY "date" DESC LIMIT 90
  `, [guildId, range.days]);

  return {
    range,
    coverage: {
      observationDays: number(coverage.observationDays), memberTrackingSince: coverage.memberTrackingSince ?? null, voiceTrackingSince: coverage.voiceTrackingSince ?? null, reactionTrackingSince: coverage.reactionTrackingSince ?? null,
      storedMessages: number(coverage.storedMessages), messagesWithChannelId: number(coverage.messagesWithChannelId), messagesWithRoles: number(coverage.messagesWithRoles),
      retentionAvailable: Boolean(coverage.memberTrackingSince),
      roleHistoryMode: "event_time_from_collection",
      messageSources: messageSourceQuality.current,
    },
    retention: {
      ...retention,
      previous: previousRetention,
      funnel: [
        { key: "joined", count: retention.joined, rate: retention.joined ? 100 : null },
        { key: "first_message", count: retention.firstMessage.within7Days, rate: nullableRate(retention.firstMessage.within7Days, retention.joined) },
        { key: "reaction", count: retention.reactions.any, rate: nullableRate(retention.reactions.any, retention.joined) },
        { key: "voice", count: retention.firstVoice.within7Days, rate: nullableRate(retention.firstVoice.within7Days, retention.joined) },
        { key: "day7", count: retention.retention7.retained, rate: retention.retention7.rate, eligible: retention.retention7.eligible },
        { key: "day30", count: retention.retention30.retained, rate: retention.retention30.rate, eligible: retention.retention30.eligible },
      ],
      cohorts,
    },
    health: {
      ...health,
      release: healthV2Release,
      previousScore: previousHealth.score,
      change: health.score === null || previousHealth.score === null ? null : health.score - previousHealth.score,
      history: historyResult.rows.reverse().map((row) => healthV2HistoryEntry(row, healthV2Release)),
    },
    diagnostics,
    insights,
    channels,
    roles,
    channelDetail: { channelId: heatmapChannelId, heatmap },
  };
}

type CommunityAnalyticsResult = Awaited<ReturnType<typeof computeCommunityAnalytics>>;
const analyticsCacheGlobal = globalThis as typeof globalThis & {
  nuviloCommunityAnalyticsCache?: Map<string, { expiresAt: number; promise: Promise<CommunityAnalyticsResult> }>;
};
const analyticsCache = analyticsCacheGlobal.nuviloCommunityAnalyticsCache ??= new Map();

export async function getCommunityAnalytics(guildId: string, range: AnalyticsRange) {
  const cacheKey = JSON.stringify([guildId, range.startDate, range.endDate, range.timeZone, range.roleId, range.channelId, range.excludeBots]);
  const cached = analyticsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = computeCommunityAnalytics(guildId, range);
  analyticsCache.set(cacheKey, { expiresAt: Date.now() + 45_000, promise });
  try {
    return await promise;
  } catch (error) {
    if (analyticsCache.get(cacheKey)?.promise === promise) analyticsCache.delete(cacheKey);
    throw error;
  }
}
