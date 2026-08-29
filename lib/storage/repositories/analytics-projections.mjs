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

function utcDatesBetween(startValue, endValue) {
  const start = toEpochMilliseconds(startValue, "startValue");
  const end = Math.max(start, toEpochMilliseconds(endValue, "endValue"));
  const dates = [];
  const cursor = Date.parse(`${utcDate(start)}T00:00:00.000Z`);
  const last = Date.parse(`${utcDate(end)}T00:00:00.000Z`);
  for (let value = cursor; value <= last; value += 86_400_000) {
    dates.push(utcDate(value));
  }
  return dates;
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

  function countRawEvent(at) {
    store.run(
      `UPDATE analytics_compaction_metrics
       SET raw_events_seen = raw_events_seen + 1, updated_at = ? WHERE id = 1`,
      at,
    );
  }

  function markReactionEvent(event, { countRaw = true, at = now() } = {}) {
    const guildId = requireString(event?.guildId, "guildId");
    const channelId = requireString(event?.channelId, "channelId");
    const userId = requireString(event?.userId, "userId");
    const occurredAt = toEpochMilliseconds(event?.occurredAt, "occurredAt");
    const sourceSequence = Math.max(
      occurredAt,
      Math.trunc(number(event?.sourceSequence ?? occurredAt)),
    );
    const dateUtc = utcDate(occurredAt);
    return inTransaction(() => {
      const marked = [
        markDirty({ projectionKind: "guild_current", guildId, sourceSequence, lastEventAt: occurredAt }, { at }),
        markDirty({ projectionKind: "guild_daily", guildId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
        markDirty({ projectionKind: "channel_daily", guildId, channelId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
        markDirty({ projectionKind: "user_daily", guildId, userId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
      ];
      if (countRaw) countRawEvent(at);
      return marked;
    });
  }

  function markVoiceEvent(event, { countRaw = true, at = now() } = {}) {
    const guildId = requireString(event?.guildId, "guildId");
    const userId = requireString(event?.userId, "userId");
    const occurredAt = toEpochMilliseconds(event?.occurredAt, "occurredAt");
    const sourceSequence = Math.max(
      occurredAt,
      Math.trunc(number(event?.sourceSequence ?? occurredAt)),
    );
    const dateUtcValues = utcDatesBetween(
      event?.startedAt ?? occurredAt,
      event?.endedAt ?? occurredAt,
    );
    const channels = [...new Set(
      [
        ...(Array.isArray(event?.affectedChannelIds) ? event.affectedChannelIds : []),
        event?.channelId,
        event?.previousChannelId,
      ].map((value) => optionalString(value)).filter(Boolean),
    )];
    const previousChannelId = optionalString(event?.previousChannelId);
    const occurredDateUtc = utcDate(occurredAt);
    return inTransaction(() => {
      const marked = [
        markDirty({ projectionKind: "guild_current", guildId, sourceSequence, lastEventAt: occurredAt }, { at }),
        ...dateUtcValues.flatMap((dateUtc) => [
          markDirty({ projectionKind: "guild_daily", guildId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
          markDirty({ projectionKind: "user_daily", guildId, userId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
        ]),
        ...channels.flatMap((channelId) => {
          const affectedDates = channelId === previousChannelId
            ? dateUtcValues
            : [occurredDateUtc];
          return affectedDates.map((dateUtc) => markDirty({
            projectionKind: "channel_daily",
            guildId,
            channelId,
            dateUtc,
            sourceSequence,
            lastEventAt: occurredAt,
          }, { at }));
        }),
      ];
      if (countRaw) countRawEvent(at);
      return marked;
    });
  }

  function markMemberEvent(event, { countRaw = true, at = now() } = {}) {
    const guildId = requireString(event?.guildId, "guildId");
    const userId = requireString(event?.userId, "userId");
    const occurredAt = toEpochMilliseconds(event?.occurredAt, "occurredAt");
    const sourceSequence = Math.max(
      occurredAt,
      Math.trunc(number(event?.sourceSequence ?? occurredAt)),
    );
    const dateUtc = utcDate(occurredAt);
    return inTransaction(() => {
      const marked = [
        markDirty({ projectionKind: "guild_current", guildId, sourceSequence, lastEventAt: occurredAt }, { at }),
        markDirty({ projectionKind: "guild_daily", guildId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
        markDirty({ projectionKind: "user_daily", guildId, userId, dateUtc, sourceSequence, lastEventAt: occurredAt }, { at }),
      ];
      if (countRaw) countRawEvent(at);
      return marked;
    });
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
    const messages = store.get(
      `SELECT COUNT(*) AS message_count, MAX(occurred_at) AS last_message_at
       FROM message_event_log m
       WHERE m.event_type = 'create' AND ${messageScope.sql}`,
      ...messageScope.parameters,
    );
    const messageUsers = store.all(
      `SELECT DISTINCT author_id AS user_id FROM message_event_log m
       WHERE m.event_type = 'create' AND author_id IS NOT NULL
         AND ${messageScope.sql}`,
      ...messageScope.parameters,
    );

    const isCurrentProjection = item.projectionKind === "guild_current";
    const reactionSummary = isCurrentProjection
      ? store.get(
          `SELECT COUNT(*) AS reaction_count,
                  COUNT(DISTINCT user_id) AS unique_reactors,
                  COUNT(DISTINCT message_id) AS reacted_messages
           FROM local_reaction_state
           WHERE guild_id = ? AND active = 1`,
          item.guildId,
        )
      : store.get(
          `SELECT
             SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) AS reaction_count,
             COUNT(DISTINCT CASE WHEN action = 'add' THEN user_id END)
               AS unique_reactors,
             COUNT(DISTINCT CASE WHEN action = 'add' THEN message_id END)
               AS reacted_messages
           FROM reaction_events r WHERE ${reactionScope.sql}`,
          ...reactionScope.parameters,
        );
    const reactionOperations = store.get(
      `SELECT
         SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) AS reaction_adds,
         SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) AS reaction_removes,
         MAX(occurred_at) AS last_reaction_at
       FROM reaction_events r WHERE ${reactionScope.sql}`,
      ...reactionScope.parameters,
    );
    const topReactions = (isCurrentProjection
      ? store.all(
          `SELECT emoji_key, COUNT(*) AS count
           FROM local_reaction_state
           WHERE guild_id = ? AND active = 1
           GROUP BY emoji_key
           ORDER BY count DESC, emoji_key ASC LIMIT 10`,
          item.guildId,
        )
      : store.all(
          `SELECT emoji_key, COUNT(*) AS count
           FROM reaction_events r WHERE ${reactionScope.sql}
             AND action = 'add'
           GROUP BY emoji_key
           ORDER BY count DESC, emoji_key ASC LIMIT 10`,
          ...reactionScope.parameters,
        )).map((row) => ({ emoji: row.emoji_key, count: Number(row.count) }));
    const reactionUsers = isCurrentProjection
      ? store.all(
          `SELECT DISTINCT user_id FROM local_reaction_state
           WHERE guild_id = ? AND active = 1`,
          item.guildId,
        )
      : store.all(
          `SELECT DISTINCT user_id FROM reaction_events r
           WHERE ${reactionScope.sql}`,
          ...reactionScope.parameters,
        );

    const voiceConditions = ["s.guild_id = ?", "s.ended_at IS NOT NULL"];
    const voiceParameters = [item.guildId];
    let windowStart = null;
    let windowEnd = null;
    if (item.dateUtc) {
      [windowStart, windowEnd] = dateRange(item.dateUtc);
      voiceConditions.push("s.started_at < ?", "s.ended_at > ?");
      voiceParameters.push(windowEnd, windowStart);
    }
    if (item.channelId) {
      voiceConditions.push("s.channel_id = ?");
      voiceParameters.push(item.channelId);
    }
    if (item.userId) {
      voiceConditions.push("s.user_id = ?");
      voiceParameters.push(item.userId);
    }
    const voiceRows = store.all(
      `SELECT session_id, user_id, channel_id, started_at, ended_at,
              duration_seconds, recovered
       FROM local_voice_session s WHERE ${voiceConditions.join(" AND ")}
       ORDER BY started_at, ended_at, session_id`,
      ...voiceParameters,
    );
    let voiceSeconds = 0;
    let voiceSessions = 0;
    let recoveredUnknownSessions = 0;
    let peakConcurrent = 0;
    let concurrent = 0;
    const voiceUsers = new Set();
    const voicePoints = [];
    const channelSeconds = new Map();
    for (const row of voiceRows) {
      if (row.duration_seconds == null) {
        recoveredUnknownSessions += 1;
        continue;
      }
      const startedAt = Math.max(Number(row.started_at), windowStart ?? 0);
      const endedAt = Math.min(Number(row.ended_at), windowEnd ?? Number(row.ended_at));
      const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
      voiceSeconds += seconds;
      voiceSessions += 1;
      voiceUsers.add(String(row.user_id));
      channelSeconds.set(
        String(row.channel_id),
        (channelSeconds.get(String(row.channel_id)) ?? 0) + seconds,
      );
      if (endedAt > startedAt) {
        voicePoints.push([startedAt, 1], [endedAt, -1]);
      }
    }
    voicePoints.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    for (const [, delta] of voicePoints) {
      concurrent += delta;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
    }
    const openVoiceConditions = ["guild_id = ?", "ended_at IS NULL"];
    const openVoiceParameters = [item.guildId];
    if (item.channelId) {
      openVoiceConditions.push("channel_id = ?");
      openVoiceParameters.push(item.channelId);
    }
    if (item.userId) {
      openVoiceConditions.push("user_id = ?");
      openVoiceParameters.push(item.userId);
    }
    const openVoiceSessions = Number(
      store.get(
        `SELECT COUNT(*) AS count FROM local_voice_session
         WHERE ${openVoiceConditions.join(" AND ")}`,
        ...openVoiceParameters,
      )?.count ?? 0,
    );
    const voiceEventScope = scopeFor(item, "v", "user_id");
    const lastVoice = store.get(
      `SELECT MAX(occurred_at) AS last_voice_at FROM voice_events v
       WHERE ${voiceEventScope.sql}`,
      ...voiceEventScope.parameters,
    );

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
    const memberSummary = item.channelId
      ? null
      : store.get(
          `SELECT
             SUM(CASE WHEN event_type = 'join' THEN 1 ELSE 0 END) AS joins,
             SUM(CASE WHEN event_type = 'leave' THEN 1 ELSE 0 END) AS leaves,
             MAX(occurred_at) AS last_member_at
           FROM member_events WHERE ${memberConditions.join(" AND ")}`,
          ...memberParameters,
        );
    let currentMemberCount = null;
    if (!item.channelId && item.projectionKind === "guild_current") {
      const current = store.get(
        `SELECT current_member_count FROM local_member_guild_state
         WHERE guild_id = ?`,
        item.guildId,
      );
      currentMemberCount = current?.current_member_count == null
        ? null
        : Number(current.current_member_count);
    } else if (item.projectionKind === "guild_daily" && item.dateUtc) {
      const [, end] = dateRange(item.dateUtc);
      const latest = store.get(
        `SELECT json_extract(payload_json, '$.memberCount') AS member_count
         FROM member_events
         WHERE guild_id = ? AND occurred_at < ?
           AND json_extract(payload_json, '$.memberCount') IS NOT NULL
         ORDER BY occurred_at DESC, source_sequence DESC LIMIT 1`,
        item.guildId,
        end,
      );
      currentMemberCount = latest?.member_count == null
        ? null
        : Number(latest.member_count);
    }

    const activeUserIds = new Set([
      ...messageUsers.map((row) => String(row.user_id)),
      ...reactionUsers.map((row) => String(row.user_id)),
      ...voiceUsers,
    ]);
    const lastMessageAt = messages?.last_message_at == null
      ? null
      : Number(messages.last_message_at);
    const lastActivityAt = Math.max(
      0,
      lastMessageAt ?? 0,
      reactionOperations?.last_reaction_at == null
        ? 0
        : Number(reactionOperations.last_reaction_at),
      lastVoice?.last_voice_at == null ? 0 : Number(lastVoice.last_voice_at),
      memberSummary?.last_member_at == null ? 0 : Number(memberSummary.last_member_at),
    ) || null;
    const joins = Number(memberSummary?.joins ?? 0);
    const leaves = Number(memberSummary?.leaves ?? 0);
    return {
      messageCount: Number(messages?.message_count ?? 0),
      reactionCount: Number(reactionSummary?.reaction_count ?? 0),
      uniqueReactors: Number(reactionSummary?.unique_reactors ?? 0),
      reactedMessages: Number(reactionSummary?.reacted_messages ?? 0),
      reactionAdds: Number(reactionOperations?.reaction_adds ?? 0),
      reactionRemoves: Number(reactionOperations?.reaction_removes ?? 0),
      topReactions,
      voiceSeconds,
      voiceMinutes: Math.round((voiceSeconds / 60) * 100) / 100,
      voiceSessions,
      openVoiceSessions,
      uniqueVoiceMembers: voiceUsers.size,
      peakConcurrent,
      recoveredUnknownSessions,
      channelVoiceMinutes: [...channelSeconds.entries()]
        .map(([channelId, seconds]) => ({
          channelId,
          minutes: Math.round((seconds / 60) * 100) / 100,
        }))
        .sort((left, right) => right.minutes - left.minutes || left.channelId.localeCompare(right.channelId))
        .slice(0, 20),
      joins,
      leaves,
      memberDelta: joins - leaves,
      currentMemberCount,
      newMembers: joins,
      activeMembers: activeUserIds.size,
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
      ...store.all(
        `SELECT 'guild_current' AS projection_kind, guild_id,
                NULL AS date_utc, NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM reaction_events WHERE true ${guildClause}
         GROUP BY guild_id`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'guild_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM reaction_events WHERE true ${guildClause}
         GROUP BY guild_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'channel_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM reaction_events WHERE true ${guildClause}
         GROUP BY guild_id, channel_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'user_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, user_id,
                MAX(occurred_at) AS source_sequence
         FROM reaction_events WHERE true ${guildClause}
         GROUP BY guild_id, user_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'guild_current' AS projection_kind, guild_id,
                NULL AS date_utc, NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM voice_events WHERE true ${guildClause}
         GROUP BY guild_id`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'guild_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM voice_events WHERE true ${guildClause}
         GROUP BY guild_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'channel_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM voice_events
         WHERE channel_id IS NOT NULL ${guildClause}
         GROUP BY guild_id, channel_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'channel_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                previous_channel_id AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM voice_events
         WHERE previous_channel_id IS NOT NULL ${guildClause}
         GROUP BY guild_id, previous_channel_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'user_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, user_id,
                MAX(occurred_at) AS source_sequence
         FROM voice_events WHERE true ${guildClause}
         GROUP BY guild_id, user_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'guild_current' AS projection_kind, guild_id,
                NULL AS date_utc, NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM member_events WHERE true ${guildClause}
         GROUP BY guild_id`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'guild_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, NULL AS user_id,
                MAX(occurred_at) AS source_sequence
         FROM member_events WHERE true ${guildClause}
         GROUP BY guild_id, date_utc`,
        ...parameters,
      ),
      ...store.all(
        `SELECT 'user_daily' AS projection_kind, guild_id,
                date(occurred_at / 1000, 'unixepoch') AS date_utc,
                NULL AS channel_id, user_id,
                MAX(occurred_at) AS source_sequence
         FROM member_events WHERE true ${guildClause}
         GROUP BY guild_id, user_id, date_utc`,
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
    const snapshotsSkippedChecksum = Number(row?.snapshots_skipped ?? 0);
    return {
      rawEventsSeen,
      snapshotsBuilt: Number(row?.snapshots_built ?? 0),
      snapshotsChanged: Number(row?.snapshots_changed ?? 0),
      snapshotsSkippedChecksum,
      // Compatibility alias for existing Control Center/read-model consumers.
      snapshotsSkipped: snapshotsSkippedChecksum,
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

  function countRawEvents(guildId) {
    const normalizedGuildId = requireString(guildId, "guildId");
    return {
      messages: countRawMessages(normalizedGuildId),
      reactions: Number(
        store.get(
          "SELECT COUNT(*) AS count FROM reaction_events WHERE guild_id = ?",
          normalizedGuildId,
        )?.count ?? 0,
      ),
      voice: Number(
        store.get(
          "SELECT COUNT(*) AS count FROM voice_events WHERE guild_id = ?",
          normalizedGuildId,
        )?.count ?? 0,
      ),
      members: Number(
        store.get(
          "SELECT COUNT(*) AS count FROM member_events WHERE guild_id = ?",
          normalizedGuildId,
        )?.count ?? 0,
      ),
    };
  }

  return Object.freeze({
    markDirty,
    markMessageEvent,
    markActiveMemberObservation,
    markReactionEvent,
    markVoiceEvent,
    markMemberEvent,
    markExistingDataDirty,
    getDirty,
    listDue,
    markAggregated,
    buildMaterial,
    recordBuild,
    recordProviderWrites,
    getMetrics,
    countRawMessages,
    countRawEvents,
  });
}
