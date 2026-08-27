import {
  optionalString,
  requireString,
  toEpochMilliseconds,
} from "../contracts.mjs";
import { assertProviderId } from "../../sync/providers/contract.mjs";

export const ANALYTICS_PROJECTION_PREFIX = "v2:guild:";

function utcDate(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function dateRange(dateUtc) {
  const start = Date.parse(`${dateUtc}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new TypeError("dateUtc must be YYYY-MM-DD.");
  return [start, start + 86_400_000];
}

export function analyticsProjectionKey({
  kind,
  guildId,
  dateUtc = null,
  channelId = null,
  userId = null,
}) {
  const guild = requireString(guildId, "guildId");
  if (kind === "guild_current") return `${ANALYTICS_PROJECTION_PREFIX}${guild}:current`;
  const date = requireString(dateUtc, "dateUtc");
  if (kind === "guild_daily") {
    return `${ANALYTICS_PROJECTION_PREFIX}${guild}:daily:${date}`;
  }
  if (kind === "channel_daily") {
    return `${ANALYTICS_PROJECTION_PREFIX}${guild}:channel:${requireString(channelId, "channelId")}:daily:${date}`;
  }
  if (kind === "user_daily") {
    return `${ANALYTICS_PROJECTION_PREFIX}${guild}:user:${requireString(userId, "userId")}:daily:${date}`;
  }
  throw new TypeError(`Unsupported analytics projection kind: ${kind}.`);
}

function mapDirty(row) {
  if (!row) return null;
  return {
    projectionKey: row.projection_key,
    projectionKind: row.projection_kind,
    guildId: row.guild_id,
    dateUtc: row.date_utc,
    channelId: row.channel_id,
    userId: row.user_id,
    sourceSequence: Number(row.source_sequence),
    lastAggregatedSequence: Number(row.last_aggregated_sequence),
    dirty: Number(row.dirty) === 1,
    nextEligibleAt: Number(row.next_eligible_at),
    lastEventAt: row.last_event_at == null ? null : Number(row.last_event_at),
    lastAggregatedAt:
      row.last_aggregated_at == null ? null : Number(row.last_aggregated_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function number(value) {
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

export function createAnalyticsProjectionRepository(
  store,
  { now = () => Date.now() } = {},
) {
  function inTransaction(callback) {
    return store.transactionActive ? callback() : store.transaction(callback);
  }

  function markDirty(input, { at = now() } = {}) {
    const projectionKind = requireString(input?.projectionKind, "projectionKind");
    const guildId = requireString(input?.guildId, "guildId");
    const dateUtc = optionalString(input?.dateUtc);
    const channelId = optionalString(input?.channelId);
    const userId = optionalString(input?.userId);
    const projectionKey = analyticsProjectionKey({
      kind: projectionKind,
      guildId,
      dateUtc,
      channelId,
      userId,
    });
    const sourceSequence = Math.max(
      0,
      Math.trunc(number(input?.sourceSequence ?? input?.lastEventAt ?? at)),
    );
    const lastEventAt = input?.lastEventAt == null
      ? null
      : toEpochMilliseconds(input.lastEventAt, "lastEventAt");
    store.run(
      `INSERT INTO analytics_projection_dirty (
         projection_key, projection_kind, guild_id, date_utc, channel_id,
         user_id, source_sequence, last_aggregated_sequence, dirty,
         next_eligible_at, last_event_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
       ON CONFLICT (projection_key) DO UPDATE SET
         source_sequence = MAX(
           analytics_projection_dirty.source_sequence,
           excluded.source_sequence
         ),
         dirty = 1,
         last_event_at = CASE
           WHEN analytics_projection_dirty.last_event_at IS NULL
             THEN excluded.last_event_at
           WHEN excluded.last_event_at IS NULL
             THEN analytics_projection_dirty.last_event_at
           ELSE MAX(analytics_projection_dirty.last_event_at, excluded.last_event_at)
         END,
         updated_at = excluded.updated_at`,
      projectionKey,
      projectionKind,
      guildId,
      dateUtc,
      channelId,
      userId,
      sourceSequence,
      at,
      lastEventAt,
      at,
      at,
    );
    return getDirty(projectionKey);
  }

  function markMessageEvent(event, { countRaw = true, at = now() } = {}) {
    const guildId = requireString(event?.guildId, "guildId");
    const occurredAt = toEpochMilliseconds(event?.occurredAt, "occurredAt");
    const sourceSequence = Math.max(
      occurredAt,
      Math.trunc(number(event?.sourceSequence ?? occurredAt)),
    );
    const dateUtc = utcDate(occurredAt);
    return inTransaction(() => {
      const marked = [
        markDirty({
          projectionKind: "guild_current",
          guildId,
          sourceSequence,
          lastEventAt: occurredAt,
        }, { at }),
      ];
      if (event?.eventType === "create") {
        marked.push(
          markDirty({
            projectionKind: "guild_daily",
            guildId,
            dateUtc,
            sourceSequence,
            lastEventAt: occurredAt,
          }, { at }),
          markDirty({
            projectionKind: "channel_daily",
            guildId,
            channelId: requireString(event?.channelId, "channelId"),
            dateUtc,
            sourceSequence,
            lastEventAt: occurredAt,
          }, { at }),
        );
        if (event?.authorId) {
          marked.push(markDirty({
            projectionKind: "user_daily",
            guildId,
            userId: String(event.authorId),
            dateUtc,
            sourceSequence,
            lastEventAt: occurredAt,
          }, { at }));
        }
      }
      if (countRaw) {
        store.run(
          `UPDATE analytics_compaction_metrics
           SET raw_events_seen = raw_events_seen + 1, updated_at = ? WHERE id = 1`,
          at,
        );
      }
      return marked;
    });
  }

  function markActiveMemberObservation(input, { at = now() } = {}) {
    const guildId = requireString(input?.guildId, "guildId");
    const userId = requireString(input?.userId, "userId");
    const dateUtc = requireString(input?.dateUtc, "dateUtc");
    const occurredAt = toEpochMilliseconds(input?.occurredAt, "occurredAt");
    return inTransaction(() => [
      markDirty({
        projectionKind: "guild_current",
        guildId,
        sourceSequence: occurredAt,
        lastEventAt: occurredAt,
      }, { at }),
      markDirty({
        projectionKind: "guild_daily",
        guildId,
        dateUtc,
        sourceSequence: occurredAt,
        lastEventAt: occurredAt,
      }, { at }),
      markDirty({
        projectionKind: "user_daily",
        guildId,
        userId,
        dateUtc,
        sourceSequence: occurredAt,
        lastEventAt: occurredAt,
      }, { at }),
    ]);
  }

  function getDirty(projectionKey) {
    return mapDirty(
      store.get(
        "SELECT * FROM analytics_projection_dirty WHERE projection_key = ?",
        requireString(projectionKey, "projectionKey"),
      ),
    );
  }

  function listDue({ at = now(), limit = 250, guildIds = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("limit must be between 1 and 10000.");
    }
    const normalizedGuildIds = Array.isArray(guildIds)
      ? [...new Set(guildIds.map(String).filter(Boolean))]
      : null;
    if (normalizedGuildIds?.length === 0) return [];
    const guildClause = normalizedGuildIds
      ? `AND guild_id IN (${normalizedGuildIds.map(() => "?").join(", ")})`
      : "";
    return store
      .all(
        `SELECT * FROM analytics_projection_dirty
         WHERE dirty = 1 AND next_eligible_at <= ? ${guildClause}
         ORDER BY next_eligible_at ASC, updated_at ASC LIMIT ?`,
        at,
        ...(normalizedGuildIds ?? []),
        limit,
      )
      .map(mapDirty);
  }

  function markAggregated(
    projectionKey,
    sourceSequence,
    { at = now(), intervalMs },
  ) {
    const interval = Number(intervalMs);
    if (!Number.isSafeInteger(interval) || interval < 1) {
      throw new TypeError("intervalMs must be a positive integer.");
    }
    const result = store.run(
      `UPDATE analytics_projection_dirty
       SET last_aggregated_sequence = MAX(last_aggregated_sequence, ?),
           dirty = CASE WHEN source_sequence <= ? THEN 0 ELSE 1 END,
           next_eligible_at = ?, last_aggregated_at = ?, updated_at = ?
       WHERE projection_key = ?`,
      Number(sourceSequence),
      Number(sourceSequence),
      at + interval,
      at,
      at,
      requireString(projectionKey, "projectionKey"),
    );
    return Number(result.changes) === 1;
  }

  function scopeFor(item, alias, userColumn) {
    const conditions = [`${alias}.guild_id = ?`];
    const parameters = [item.guildId];
    if (item.dateUtc) {
      const [start, end] = dateRange(item.dateUtc);
      conditions.push(`${alias}.occurred_at >= ?`, `${alias}.occurred_at < ?`);
      parameters.push(start, end);
    }
    if (item.channelId) {
      conditions.push(`${alias}.channel_id = ?`);
      parameters.push(item.channelId);
    }
    if (item.userId) {
      conditions.push(`${alias}.${userColumn} = ?`);
      parameters.push(item.userId);
    }
    return { sql: conditions.join(" AND "), parameters };
  }

  function buildMaterial(item) {
    const messageScope = scopeFor(item, "m", "author_id");
    const reactionScope = scopeFor(item, "r", "user_id");
    const voiceScope = scopeFor(item, "v", "user_id");
    const messages = store.get(
      `SELECT COUNT(*) AS message_count,
              COUNT(DISTINCT author_id) AS active_members,
              MAX(occurred_at) AS last_message_at
       FROM message_event_log m
       WHERE m.event_type = 'create' AND ${messageScope.sql}`,
      ...messageScope.parameters,
    );
    const reactions = store.get(
      `SELECT COALESCE(SUM(CASE WHEN action = 'add' THEN 1 ELSE -1 END), 0)
                AS reaction_count,
              MAX(occurred_at) AS last_reaction_at
       FROM reaction_events r WHERE ${reactionScope.sql}`,
      ...reactionScope.parameters,
    );
    const voice = store.get(
      `SELECT COALESCE(SUM(CASE WHEN event_type = 'leave' THEN
                COALESCE(
                  CAST(json_extract(payload_json, '$.durationSeconds') AS REAL),
                  CAST(json_extract(payload_json, '$.durationMs') AS REAL) / 1000.0,
                  0
                ) ELSE 0 END), 0) AS voice_seconds,
              MAX(occurred_at) AS last_voice_at
       FROM voice_events v WHERE ${voiceScope.sql}`,
      ...voiceScope.parameters,
    );
    let lastMember = null;
    if (!item.channelId) {
      const memberConditions = ["guild_id = ?"];
      const memberParameters = [item.guildId];
      if (item.dateUtc) {
        const [start, end] = dateRange(item.dateUtc);
        memberConditions.push("occurred_at >= ?", "occurred_at < ?");
        memberParameters.push(start, end);
      }
      if (item.userId) {
        memberConditions.push("user_id = ?");
        memberParameters.push(item.userId);
      }
      lastMember = store.get(
        `SELECT MAX(occurred_at) AS last_member_at FROM member_events
         WHERE ${memberConditions.join(" AND ")}`,
        ...memberParameters,
      );
    }
    const lastMessageAt = messages?.last_message_at == null
      ? null
      : Number(messages.last_message_at);
    const lastActivityAt = Math.max(
      0,
      lastMessageAt ?? 0,
      reactions?.last_reaction_at == null ? 0 : Number(reactions.last_reaction_at),
      voice?.last_voice_at == null ? 0 : Number(voice.last_voice_at),
      lastMember?.last_member_at == null ? 0 : Number(lastMember.last_member_at),
    ) || null;
    return {
      messageCount: Number(messages?.message_count ?? 0),
      reactionCount: Math.max(0, Number(reactions?.reaction_count ?? 0)),
      voiceMinutes: Math.round((Number(voice?.voice_seconds ?? 0) / 60) * 100) / 100,
      activeMembers: Number(messages?.active_members ?? 0),
      lastMessageAt,
      lastActivityAt,
    };
  }

  function markExistingDataDirty({ guildIds = null, at = now() } = {}) {
    const normalizedGuildIds = Array.isArray(guildIds)
      ? [...new Set(guildIds.map(String).filter(Boolean))]
      : null;
    if (normalizedGuildIds?.length === 0) return { rawEvents: 0, marked: 0 };
    const guildClause = normalizedGuildIds
      ? `AND guild_id IN (${normalizedGuildIds.map(() => "?").join(", ")})`
      : "";
    const parameters = normalizedGuildIds ?? [];
    const grouped = [
      ...store.all(
        `SELECT 'guild_current' AS projection_kind, guild_id,
                NULL AS date_utc, NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM message_event_log
         WHERE event_type = 'create' ${guildClause}
         GROUP BY guild_id`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'guild_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM message_event_log
         WHERE event_type = 'create' ${guildClause}
         GROUP BY guild_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'channel_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM message_event_log
         WHERE event_type = 'create' ${guildClause}
         GROUP BY guild_id, channel_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'user_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, author_id AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM message_event_log
         WHERE event_type = 'create' AND author_id IS NOT NULL ${guildClause}
         GROUP BY guild_id, author_id, date_utc`,
        ...parameters,
      ),
    ];
    return inTransaction(() => {
      const keys = new Set();
      for (const item of grouped) {
        const marked = markDirty({
          projectionKind: item.projection_kind,
          guildId: item.guild_id,
          dateUtc: item.date_utc,
          channelId: item.channel_id,
          userId: item.user_id,
          sourceSequence: Number(item.source_sequence),
          lastEventAt: Number(item.source_sequence),
        }, { at });
        keys.add(marked.projectionKey);
      }
      const rawCounts = store.get(
        `SELECT
           (SELECT COUNT(*) FROM message_event_log ${normalizedGuildIds ? `WHERE guild_id IN (${normalizedGuildIds.map(() => "?").join(", ")})` : ""}) +
           (SELECT COUNT(*) FROM reaction_events ${normalizedGuildIds ? `WHERE guild_id IN (${normalizedGuildIds.map(() => "?").join(", ")})` : ""}) +
           (SELECT COUNT(*) FROM voice_events ${normalizedGuildIds ? `WHERE guild_id IN (${normalizedGuildIds.map(() => "?").join(", ")})` : ""}) +
           (SELECT COUNT(*) FROM member_events ${normalizedGuildIds ? `WHERE guild_id IN (${normalizedGuildIds.map(() => "?").join(", ")})` : ""})
           AS count`,
        ...(
          normalizedGuildIds
            ? [
                ...normalizedGuildIds,
                ...normalizedGuildIds,
                ...normalizedGuildIds,
                ...normalizedGuildIds,
              ]
            : []
        ),
      );
      const rawEvents = Number(rawCounts?.count ?? 0);
      store.run(
        `UPDATE analytics_compaction_metrics
         SET raw_events_seen = MAX(raw_events_seen, ?), updated_at = ? WHERE id = 1`,
        rawEvents,
        at,
      );
      return { rawEvents, marked: keys.size };
    });
  }

  function recordBuild({ changed, at = now() }) {
    store.run(
      `UPDATE analytics_compaction_metrics
       SET snapshots_built = snapshots_built + 1,
           snapshots_changed = snapshots_changed + ?,
           snapshots_skipped = snapshots_skipped + ?,
           last_built_at = ?, updated_at = ? WHERE id = 1`,
      changed ? 1 : 0,
      changed ? 0 : 1,
      at,
      at,
    );
  }

  function recordProviderWrites(providerId, count, { at = now() } = {}) {
    const normalizedProviderId = assertProviderId(providerId);
    const writes = Math.max(0, Math.trunc(number(count)));
    if (writes === 0) return 0;
    const column = `${normalizedProviderId}_writes`;
    store.run(
      `UPDATE analytics_compaction_metrics
       SET provider_writes = provider_writes + ?,
           ${column} = ${column} + ?, last_provider_write_at = ?, updated_at = ?
       WHERE id = 1`,
      writes,
      writes,
      at,
      at,
    );
    return writes;
  }

  function getMetrics() {
    const row = store.get("SELECT * FROM analytics_compaction_metrics WHERE id = 1");
    const rawEventsSeen = Number(row?.raw_events_seen ?? 0);
    const providerWrites = Number(row?.provider_writes ?? 0);
    return {
      rawEventsSeen,
      snapshotsBuilt: Number(row?.snapshots_built ?? 0),
      snapshotsChanged: Number(row?.snapshots_changed ?? 0),
      snapshotsSkipped: Number(row?.snapshots_skipped ?? 0),
      providerWrites,
      providerWritesByProvider: {
        supabase: Number(row?.supabase_writes ?? 0),
        turso: Number(row?.turso_writes ?? 0),
        neon: Number(row?.neon_writes ?? 0),
      },
      providerWriteReductionRatio:
        rawEventsSeen === 0
          ? 0
          : Math.max(0, 1 - providerWrites / rawEventsSeen),
      lastBuiltAt: row?.last_built_at == null ? null : Number(row.last_built_at),
      lastProviderWriteAt:
        row?.last_provider_write_at == null
          ? null
          : Number(row.last_provider_write_at),
    };
  }

  function countRawMessages(guildId) {
    return Number(
      store.get(
        `SELECT COUNT(*) AS count FROM message_event_log
         WHERE guild_id = ? AND event_type = 'create'`,
        requireString(guildId, "guildId"),
      )?.count ?? 0,
    );
  }

  return Object.freeze({
    markDirty,
    markMessageEvent,
    markActiveMemberObservation,
    markExistingDataDirty,
    getDirty,
    listDue,
    markAggregated,
    buildMaterial,
    recordBuild,
    recordProviderWrites,
    getMetrics,
    countRawMessages,
  });
}
