import {
  createStableEventId,
  optionalString,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

function inserted(result, eventId) {
  return { eventId, inserted: Number(result.changes) === 1 };
}

function assertOneOf(value, allowed, fieldName) {
  if (!allowed.has(value)) {
    throw new TypeError(`${fieldName} must be one of: ${[...allowed].join(", ")}.`);
  }
  return value;
}

export function createAnalyticsEventRepository(
  store,
  messageRepository,
  { now = () => Date.now() } = {},
) {
  function recordMessageEvent(input) {
    return messageRepository.upsert(input);
  }

  function recordReactionEvent(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const channelId = requireString(input?.channelId, "channelId");
    const messageId = requireString(input?.messageId, "messageId");
    const userId = requireString(input?.userId, "userId");
    const emojiKey = requireString(input?.emojiKey, "emojiKey");
    const action = assertOneOf(input?.action, new Set(["add", "remove"]), "action");
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId("reaction", [
          guildId,
          messageId,
          userId,
          emojiKey,
          action,
          occurredAt,
        ]);
    const result = store.run(
      `INSERT OR IGNORE INTO reaction_events (
         event_id, guild_id, channel_id, message_id, user_id, emoji_key,
         action, payload_json, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      guildId,
      channelId,
      messageId,
      userId,
      emojiKey,
      action,
      serializeJson(input?.payload),
      occurredAt,
      now(),
    );
    return inserted(result, eventId);
  }

  function recordVoiceEvent(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const userId = requireString(input?.userId, "userId");
    const sessionId = requireString(input?.sessionId, "sessionId");
    const eventType = assertOneOf(
      input?.eventType,
      new Set(["join", "move", "leave"]),
      "eventType",
    );
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId("voice", [
          guildId,
          userId,
          sessionId,
          eventType,
          occurredAt,
        ]);
    const result = store.run(
      `INSERT OR IGNORE INTO voice_events (
         event_id, guild_id, channel_id, user_id, session_id, event_type,
         previous_channel_id, payload_json, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      guildId,
      optionalString(input?.channelId),
      userId,
      sessionId,
      eventType,
      optionalString(input?.previousChannelId),
      serializeJson(input?.payload),
      occurredAt,
      now(),
    );
    return inserted(result, eventId);
  }

  function recordMemberEvent(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const userId = requireString(input?.userId, "userId");
    const eventType = assertOneOf(
      input?.eventType,
      new Set(["join", "leave", "update", "sync"]),
      "eventType",
    );
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId("member", [guildId, userId, eventType, occurredAt]);
    const result = store.run(
      `INSERT OR IGNORE INTO member_events (
         event_id, guild_id, user_id, event_type, payload_json,
         occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      guildId,
      userId,
      eventType,
      serializeJson(input?.payload),
      occurredAt,
      now(),
    );
    return inserted(result, eventId);
  }

  return Object.freeze({
    recordMessageEvent,
    recordReactionEvent,
    recordVoiceEvent,
    recordMemberEvent,
  });
}
