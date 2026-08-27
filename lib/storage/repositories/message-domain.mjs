import { createHash } from "node:crypto";
import {
  optionalString,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

const eventRanks = Object.freeze({ create: 0, update: 1, delete: 2 });
const sourceRanks = Object.freeze({ history_import: 0, existing: 1, live: 2 });

function utcDate(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function checksum(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function mapEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    authorId: row.author_id,
    eventType: row.event_type,
    revision: row.revision,
    sourceSequence: Number(row.source_sequence),
    eventRank: Number(row.event_rank),
    content: row.content,
    contentChecksum: row.content_checksum,
    payload: parseJson(row.payload_json),
    source: row.source,
    sourceRank: Number(row.source_rank),
    importJobId: row.import_job_id,
    occurredAt: Number(row.occurred_at),
    createdAt: Number(row.created_at),
  };
}

function mapCurrent(row) {
  if (!row) return null;
  const payload = parseJson(row.payload_json);
  return {
    eventId: row.event_id,
    currentEventId: row.current_event_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    authorId: row.author_id,
    eventType: row.event_type,
    revision: row.revision,
    sourceSequence: Number(row.source_sequence),
    eventRank: Number(row.event_rank),
    content: row.content,
    contentChecksum: row.content_checksum,
    payload,
    source: row.source,
    sourceRank: Number(row.source_rank),
    importJobId: row.import_job_id,
    authorName: payload.authorName ?? null,
    occurredAt: Number(row.occurred_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    deleteEventId: row.delete_event_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function sameStoredEvent(row, expected) {
  return (
    row.guild_id === expected.guildId &&
    row.channel_id === expected.channelId &&
    row.message_id === expected.messageId &&
    row.author_id === expected.authorId &&
    row.event_type === expected.eventType &&
    row.revision === expected.revision &&
    Number(row.source_sequence) === expected.sourceSequence &&
    Number(row.event_rank) === expected.eventRank &&
    row.content === expected.content &&
    row.content_checksum === expected.contentChecksum &&
    row.payload_json === expected.payloadJson &&
    Number(row.occurred_at) === expected.occurredAt &&
    row.source === expected.source &&
    Number(row.source_rank) === expected.sourceRank &&
    row.import_job_id === expected.importJobId
  );
}

function sameEventIdentity(row, expected) {
  return (
    row.guild_id === expected.guildId &&
    row.channel_id === expected.channelId &&
    row.message_id === expected.messageId &&
    row.event_type === expected.eventType
  );
}

export function createMessageDomainRepository(
  store,
  outbox,
  { now = () => Date.now() } = {},
) {
  function getEventById(eventId) {
    return mapEvent(
      store.get(
        "SELECT * FROM message_event_log WHERE event_id = ?",
        requireString(eventId, "eventId"),
      ),
    );
  }

  function getCurrent(guildId, messageId) {
    return mapCurrent(
      store.get(
        "SELECT * FROM message_events WHERE guild_id = ? AND message_id = ?",
        requireString(guildId, "guildId"),
        requireString(messageId, "messageId"),
      ),
    );
  }

  function recordEvent(input) {
    const eventId = requireString(input?.eventId, "eventId");
    const guildId = requireString(input?.guildId, "guildId");
    const channelId = requireString(input?.channelId, "channelId");
    const messageId = requireString(input?.messageId, "messageId");
    const eventType = requireString(input?.eventType, "eventType").toLowerCase();
    if (!(eventType in eventRanks)) {
      throw new TypeError("eventType must be create, update, or delete.");
    }
    const sourceSequence = Number(input?.sourceSequence);
    if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 0) {
      throw new TypeError("sourceSequence must be a non-negative safe integer.");
    }
    const revision = requireString(input?.revision, "revision");
    const eventRank = eventRanks[eventType];
    const occurredAt = toEpochMilliseconds(input?.occurredAt, "occurredAt");
    const recordedAt = now();
    const authorId = optionalString(input?.authorId);
    const content = eventType === "delete" || input?.content == null
      ? null
      : String(input.content);
    const contentChecksum = eventType === "delete"
      ? null
      : optionalString(input?.contentChecksum) ?? checksum(content);
    const payloadJson = serializeJson(input?.payload);
    const explicitSource = optionalString(input?.source);
    const payloadSource = optionalString(input?.payload?.source);
    const source = explicitSource ?? (
      payloadSource && payloadSource in sourceRanks
        ? payloadSource
        : "existing"
    );
    if (!(source in sourceRanks)) {
      throw new TypeError("message source must be existing, live, or history_import.");
    }
    const sourceRank = sourceRanks[source];
    const importJobId = source === "history_import"
      ? optionalString(input?.importJobId ?? input?.payload?.importJobId)
      : null;
    const normalized = {
      eventId,
      guildId,
      channelId,
      messageId,
      authorId,
      eventType,
      revision,
      sourceSequence,
      eventRank,
      content,
      contentChecksum,
      payloadJson,
      occurredAt,
      source,
      sourceRank,
      importJobId,
    };

    const storedBefore = store.get(
      "SELECT * FROM message_event_log WHERE event_id = ?",
      eventId,
    );
    if (storedBefore && !sameEventIdentity(storedBefore, normalized)) {
      const error = new Error(`Message event ID collision: ${eventId}.`);
      error.code = "MESSAGE_EVENT_ID_COLLISION";
      throw error;
    }

    let inserted = false;
    let promoted = false;
    let duplicate = false;
    if (!storedBefore) {
      const result = store.run(
        `INSERT INTO message_event_log (
         event_id, guild_id, channel_id, message_id, author_id, event_type,
         revision, source_sequence, event_rank, content, content_checksum,
         payload_json, occurred_at, created_at, source, source_rank,
         import_job_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        guildId,
        channelId,
        messageId,
        authorId,
        eventType,
        revision,
        sourceSequence,
        eventRank,
        content,
        contentChecksum,
        payloadJson,
        occurredAt,
        recordedAt,
        source,
        sourceRank,
        importJobId,
      );
      inserted = Number(result.changes) === 1;
    } else if (sameStoredEvent(storedBefore, normalized)) {
      duplicate = true;
    } else if (sourceRank > Number(storedBefore.source_rank ?? 1)) {
      const result = store.run(
        `UPDATE message_event_log
         SET author_id = ?, revision = ?, source_sequence = ?, event_rank = ?,
             content = ?, content_checksum = ?, payload_json = ?, occurred_at = ?,
             source = ?, source_rank = ?, import_job_id = NULL
         WHERE event_id = ? AND source_rank < ?`,
        authorId,
        revision,
        sourceSequence,
        eventRank,
        content,
        contentChecksum,
        payloadJson,
        occurredAt,
        source,
        sourceRank,
        eventId,
        sourceRank,
      );
      promoted = Number(result.changes) === 1;
    } else if (
      sourceRank < Number(storedBefore.source_rank ?? 1) ||
      source === "history_import"
    ) {
      duplicate = true;
    } else {
      const error = new Error(`Message event ID collision: ${eventId}.`);
      error.code = "MESSAGE_EVENT_ID_COLLISION";
      throw error;
    }
    const storedRow = store.get(
      "SELECT * FROM message_event_log WHERE event_id = ?",
      eventId,
    );
    if (!duplicate && !sameStoredEvent(storedRow, normalized)) {
      const error = new Error(`Message event ID collision: ${eventId}.`);
      error.code = "MESSAGE_EVENT_ID_COLLISION";
      throw error;
    }

    let applied = false;
    if (inserted || promoted) {
      const currentWrite = store.run(
        `INSERT INTO message_events (
           event_id, guild_id, channel_id, message_id, author_id, event_type,
           content, payload_json, occurred_at, deleted_at, created_at, updated_at,
           revision, source_sequence, event_rank, current_event_id,
           content_checksum, delete_event_id, source, source_rank, import_job_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, message_id) DO UPDATE SET
           channel_id = excluded.channel_id,
           author_id = COALESCE(excluded.author_id, message_events.author_id),
           event_type = excluded.event_type,
           content = excluded.content,
           payload_json = excluded.payload_json,
           occurred_at = excluded.occurred_at,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at,
           revision = excluded.revision,
           source_sequence = excluded.source_sequence,
           event_rank = excluded.event_rank,
           current_event_id = excluded.current_event_id,
           content_checksum = excluded.content_checksum,
           delete_event_id = excluded.delete_event_id,
           source = excluded.source,
           source_rank = excluded.source_rank,
           import_job_id = excluded.import_job_id
         WHERE excluded.source_rank > message_events.source_rank
            OR (excluded.source_rank = message_events.source_rank
                AND excluded.source_sequence > message_events.source_sequence)
            OR (excluded.source_sequence = message_events.source_sequence
                AND excluded.source_rank = message_events.source_rank
                AND excluded.event_rank > message_events.event_rank)
            OR (excluded.source_sequence = message_events.source_sequence
                AND excluded.source_rank = message_events.source_rank
                AND excluded.event_rank = message_events.event_rank
                AND excluded.revision > COALESCE(message_events.revision, ''))`,
        eventId,
        guildId,
        channelId,
        messageId,
        authorId,
        eventType,
        content,
        payloadJson,
        occurredAt,
        eventType === "delete" ? occurredAt : null,
        recordedAt,
        recordedAt,
        revision,
        sourceSequence,
        eventRank,
        eventId,
        contentChecksum,
        eventType === "delete" ? eventId : null,
        source,
        sourceRank,
        importJobId,
      );
      applied = Number(currentWrite.changes) === 1;

      if (inserted && eventType === "create") {
        const dateUtc = utcDate(occurredAt);
        const memberCount = Number.isSafeInteger(input?.memberCount)
          ? input.memberCount
          : null;
        store.run(
          `INSERT INTO local_message_daily_stats (
             guild_id, date_utc, message_count, member_count, updated_at
           ) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (guild_id, date_utc) DO UPDATE SET
             message_count = local_message_daily_stats.message_count + 1,
             member_count = COALESCE(excluded.member_count, local_message_daily_stats.member_count),
             updated_at = excluded.updated_at`,
          guildId,
          dateUtc,
          memberCount,
          recordedAt,
        );
        if (authorId) {
          store.run(
            `INSERT INTO local_message_active_member (
               guild_id, user_id, date_utc, first_message_at, last_message_at,
               message_count, updated_at
             ) VALUES (?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT (guild_id, user_id, date_utc) DO UPDATE SET
               first_message_at = MIN(local_message_active_member.first_message_at, excluded.first_message_at),
               last_message_at = MAX(local_message_active_member.last_message_at, excluded.last_message_at),
               message_count = local_message_active_member.message_count + 1,
               updated_at = excluded.updated_at`,
            guildId,
            authorId,
            dateUtc,
            occurredAt,
            occurredAt,
            recordedAt,
          );
        }
        store.run(
          `INSERT OR IGNORE INTO local_message_recent_activity (
             event_id, guild_id, actor_id, actor_name, channel_id, channel_name,
             occurred_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          eventId,
          guildId,
          authorId,
          requireString(input?.actorName ?? input?.payload?.authorName ?? "unknown", "actorName"),
          channelId,
          optionalString(input?.channelName ?? input?.payload?.channelName),
          occurredAt,
          recordedAt,
        );
      }

      store.run(
        `UPDATE message_domain_metrics
         SET local_writes_total = local_writes_total + 1,
             last_local_write_at = ?, updated_at = ?
         WHERE id = 1`,
        recordedAt,
        recordedAt,
      );
    }

    const event = getEventById(eventId);
    return {
      inserted,
      promoted,
      duplicate,
      applied,
      event,
      current: getCurrent(guildId, messageId),
    };
  }

  function recordActiveMemberObservation(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const userId = requireString(input?.userId, "userId");
    const dateUtc = requireString(input?.dateUtc, "dateUtc");
    const occurredAt = toEpochMilliseconds(input?.occurredAt, "occurredAt");
    const recordedAt = now();
    const result = store.run(
      `INSERT OR IGNORE INTO local_message_active_member (
         guild_id, user_id, date_utc, first_message_at, last_message_at,
         message_count, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      guildId,
      userId,
      dateUtc,
      occurredAt,
      occurredAt,
      recordedAt,
    );
    return { inserted: Number(result.changes) === 1 };
  }

  function getLastActivityAt(guildId) {
    const row = store.get(
      `SELECT MAX(occurred_at) AS last_activity_at
       FROM local_message_recent_activity WHERE guild_id = ?`,
      requireString(guildId, "guildId"),
    );
    return row?.last_activity_at == null ? null : Number(row.last_activity_at);
  }

  function getDerivedStats(guildId, dateUtc) {
    const normalizedGuildId = requireString(guildId, "guildId");
    const normalizedDate = requireString(dateUtc, "dateUtc");
    const daily = store.get(
      `SELECT message_count, member_count, updated_at
       FROM local_message_daily_stats WHERE guild_id = ? AND date_utc = ?`,
      normalizedGuildId,
      normalizedDate,
    );
    const active = store.get(
      `SELECT COUNT(*) AS count FROM local_message_active_member
       WHERE guild_id = ? AND date_utc = ?`,
      normalizedGuildId,
      normalizedDate,
    );
    return {
      messageCount: Number(daily?.message_count ?? 0),
      memberCount: daily?.member_count == null ? null : Number(daily.member_count),
      activeMemberCount: Number(active?.count ?? 0),
      updatedAt: daily?.updated_at == null ? null : Number(daily.updated_at),
    };
  }

  function getComparisonSnapshot(guildId) {
    const normalizedGuildId = requireString(guildId, "guildId");
    const events = store.get(
      `SELECT COUNT(*) AS event_count,
              SUM(CASE WHEN event_type = 'create' THEN 1 ELSE 0 END) AS create_count,
              MAX(CASE WHEN event_type = 'create' THEN occurred_at END) AS latest_create_at
       FROM message_event_log WHERE guild_id = ?`,
      normalizedGuildId,
    );
    const current = store.get(
      `SELECT SUM(CASE WHEN event_type <> 'delete' THEN 1 ELSE 0 END) AS current_count,
              SUM(CASE WHEN event_type = 'delete' THEN 1 ELSE 0 END) AS deleted_count
       FROM message_events WHERE guild_id = ?`,
      normalizedGuildId,
    );
    const recent = store.get(
      "SELECT COUNT(*) AS count FROM local_message_recent_activity WHERE guild_id = ?",
      normalizedGuildId,
    );
    const active = store.get(
      `SELECT COUNT(*) AS count FROM local_message_active_member WHERE guild_id = ?`,
      normalizedGuildId,
    );
    return {
      eventCount: Number(events?.event_count ?? 0),
      createCount: Number(events?.create_count ?? 0),
      currentMessageCount: Number(current?.current_count ?? 0),
      deletedCount: Number(current?.deleted_count ?? 0),
      recentActivityCount: Number(recent?.count ?? 0),
      activeMemberCount: Number(active?.count ?? 0),
      latestCreateAt: events?.latest_create_at == null
        ? null
        : Number(events.latest_create_at),
    };
  }

  function recordWriteFailure(at = now()) {
    store.run(
      `UPDATE message_domain_metrics
       SET local_write_failures = local_write_failures + 1,
           last_local_write_failure_at = ?, updated_at = ? WHERE id = 1`,
      at,
      at,
    );
  }

  function recordSyncResult({ successCount = 0, failureCount = 0, at = now() }) {
    if (!successCount && !failureCount) return;
    store.run(
      `UPDATE message_domain_metrics
       SET sync_success_total = sync_success_total + ?,
           sync_failure_total = sync_failure_total + ?,
           last_sync_at = CASE WHEN ? > 0 THEN ? ELSE last_sync_at END,
           last_sync_failure_at = CASE WHEN ? > 0 THEN ? ELSE last_sync_failure_at END,
           updated_at = ? WHERE id = 1`,
      successCount,
      failureCount,
      successCount,
      at,
      failureCount,
      at,
      at,
    );
  }

  function getMetrics({ at = now() } = {}) {
    const row = store.get("SELECT * FROM message_domain_metrics WHERE id = 1");
    const pending = outbox.getMessagePendingCount();
    const oldestPendingAgeMs = outbox.getMessageOldestPendingAge({ at });
    return {
      messageLocalWritesTotal: Number(row?.local_writes_total ?? 0),
      messageLocalWriteFailures: Number(row?.local_write_failures ?? 0),
      messageOutboxPending: pending,
      messageSyncSuccessTotal: Number(row?.sync_success_total ?? 0),
      messageSyncFailureTotal: Number(row?.sync_failure_total ?? 0),
      messageLastLocalWrite: row?.last_local_write_at == null
        ? null
        : Number(row.last_local_write_at),
      messageLastSync: row?.last_sync_at == null ? null : Number(row.last_sync_at),
      messageSyncLag: oldestPendingAgeMs,
      messageOldestPendingAge: oldestPendingAgeMs,
    };
  }

  function getRoutingMode() {
    return store.get(
      "SELECT state, metadata_json, updated_at FROM sync_metadata WHERE stream_name = 'message_domain_routing'",
    );
  }

  return Object.freeze({
    recordEvent,
    recordActiveMemberObservation,
    getCurrent,
    getEventById,
    getLastActivityAt,
    getDerivedStats,
    getComparisonSnapshot,
    recordWriteFailure,
    recordSyncResult,
    getMetrics,
    getRoutingMode,
  });
}
