import {
  createStableEventId,
  optionalString,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

function mapMessage(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    authorId: row.author_id,
    eventType: row.event_type,
    content: row.content,
    payload: parseJson(row.payload_json),
    occurredAt: Number(row.occurred_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createMessageRepository(store, { now = () => Date.now() } = {}) {
  function getByIdentity(guildId, messageId) {
    return mapMessage(
      store.get(
        `SELECT event_id, guild_id, channel_id, message_id, author_id,
                event_type, content, payload_json, occurred_at, deleted_at,
                created_at, updated_at
         FROM message_events
         WHERE guild_id = ? AND message_id = ?`,
        requireString(guildId, "guildId"),
        requireString(messageId, "messageId"),
      ),
    );
  }

  function upsert(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const channelId = requireString(input?.channelId, "channelId");
    const messageId = requireString(input?.messageId, "messageId");
    const eventType = input?.eventType ?? "create";
    if (!new Set(["create", "update"]).has(eventType)) {
      throw new TypeError("message eventType must be create or update.");
    }
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId("message", [guildId, messageId]);
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const recordedAt = now();

    store.run(
      `INSERT INTO message_events (
         event_id, guild_id, channel_id, message_id, author_id, event_type,
         content, payload_json, occurred_at, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (guild_id, message_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         author_id = COALESCE(excluded.author_id, message_events.author_id),
         event_type = excluded.event_type,
         content = excluded.content,
         payload_json = excluded.payload_json,
         occurred_at = excluded.occurred_at,
         deleted_at = NULL,
         updated_at = excluded.updated_at`,
      eventId,
      guildId,
      channelId,
      messageId,
      optionalString(input?.authorId),
      eventType,
      input?.content === null || input?.content === undefined
        ? null
        : String(input.content),
      serializeJson(input?.payload),
      occurredAt,
      recordedAt,
      recordedAt,
    );
    return getByIdentity(guildId, messageId);
  }

  function markDeleted(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const messageId = requireString(input?.messageId, "messageId");
    const existing = getByIdentity(guildId, messageId);
    const channelId = requireString(
      input?.channelId ?? existing?.channelId,
      "channelId",
    );
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : existing?.eventId ?? createStableEventId("message", [guildId, messageId]);
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const recordedAt = now();

    store.run(
      `INSERT INTO message_events (
         event_id, guild_id, channel_id, message_id, author_id, event_type,
         content, payload_json, occurred_at, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'delete', NULL, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, message_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         event_type = 'delete',
         content = NULL,
         payload_json = excluded.payload_json,
         occurred_at = excluded.occurred_at,
         deleted_at = excluded.deleted_at,
         updated_at = excluded.updated_at`,
      eventId,
      guildId,
      channelId,
      messageId,
      optionalString(input?.authorId ?? existing?.authorId),
      serializeJson(input?.payload),
      occurredAt,
      occurredAt,
      recordedAt,
      recordedAt,
    );
    return getByIdentity(guildId, messageId);
  }

  return Object.freeze({ upsert, markDeleted, getByIdentity });
}
