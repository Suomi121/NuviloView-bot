import {
  createStableEventId,
  optionalString,
  parseJson,
  requireString,
  serializeJson,
  toEpochMilliseconds,
} from "../contracts.mjs";

const reactionActions = new Set(["add", "remove"]);
const voiceEventTypes = new Set(["join", "move", "leave"]);
const memberEventTypes = new Set(["join", "leave", "update", "sync"]);

function inserted(result, eventId, extra = {}) {
  return { eventId, inserted: Number(result.changes) === 1, ...extra };
}

function assertOneOf(value, allowed, fieldName) {
  if (!allowed.has(value)) {
    throw new TypeError(`${fieldName} must be one of: ${[...allowed].join(", ")}.`);
  }
  return value;
}

function booleanInteger(value) {
  return value ? 1 : 0;
}

function safeSequence(value, fallback) {
  const numeric = Number(value ?? fallback);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TypeError("sourceSequence must be a non-negative safe integer.");
  }
  return numeric;
}

function mapVoiceSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    durationSeconds:
      row.duration_seconds == null ? null : Number(row.duration_seconds),
    recovered: Number(row.recovered) === 1,
    recoveryReason: row.recovery_reason,
    roleIds: parseJson(row.role_ids_json, []),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapReactionState(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    userId: row.user_id,
    emojiKey: row.emoji_key,
    active: Number(row.active) === 1,
    recipientId: row.recipient_id,
    reactorIsBot: Number(row.reactor_is_bot) === 1,
    lastEventId: row.last_event_id,
    sourceSequence: Number(row.source_sequence),
    updatedAt: Number(row.updated_at),
  };
}

function mapMemberState(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    isPresent: Number(row.is_present) === 1,
    isBot: Number(row.is_bot) === 1,
    joinedAt: row.joined_at == null ? null : Number(row.joined_at),
    leftAt: row.left_at == null ? null : Number(row.left_at),
    roleHash: row.role_hash,
    roleIds: parseJson(row.role_ids_json, []),
    lastEventId: row.last_event_id,
    sourceSequence: Number(row.source_sequence),
    updatedAt: Number(row.updated_at),
  };
}

export function createAnalyticsEventRepository(
  store,
  messageRepository,
  { now = () => Date.now() } = {},
) {
  function inTransaction(callback) {
    return store.transactionActive ? callback() : store.transaction(callback);
  }

  function recordMessageEvent(input) {
    return messageRepository.upsert(input);
  }

  function recordReactionEvent(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const channelId = requireString(input?.channelId, "channelId");
    const messageId = requireString(input?.messageId, "messageId");
    const userId = requireString(input?.userId, "userId");
    const emojiKey = requireString(input?.emojiKey, "emojiKey");
    const action = assertOneOf(input?.action, reactionActions, "action");
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const sourceSequence = safeSequence(input?.sourceSequence, occurredAt);
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId(`reaction-${action}`, [
          guildId,
          messageId,
          userId,
          emojiKey,
          sourceSequence,
        ]);
    const revision = optionalString(input?.revision) ?? `${action}:${sourceSequence}`;
    const result = store.run(
      `INSERT OR IGNORE INTO reaction_events (
         event_id, guild_id, channel_id, message_id, user_id, emoji_key,
         action, payload_json, occurred_at, created_at, source_sequence,
         revision, recipient_id, reactor_is_bot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      sourceSequence,
      revision,
      optionalString(input?.recipientId),
      booleanInteger(input?.reactorIsBot),
    );
    return inserted(result, eventId, {
      event: {
        eventId,
        guildId,
        channelId,
        messageId,
        userId,
        emojiKey,
        action,
        occurredAt,
        sourceSequence,
      },
    });
  }

  function getReactionState(guildId, messageId, userId, emojiKey) {
    return mapReactionState(
      store.get(
        `SELECT * FROM local_reaction_state
         WHERE guild_id = ? AND message_id = ? AND user_id = ? AND emoji_key = ?`,
        requireString(guildId, "guildId"),
        requireString(messageId, "messageId"),
        requireString(userId, "userId"),
        requireString(emojiKey, "emojiKey"),
      ),
    );
  }

  function recordReactionTransition(input) {
    return inTransaction(() => {
      const guildId = requireString(input?.guildId, "guildId");
      const channelId = requireString(input?.channelId, "channelId");
      const messageId = requireString(input?.messageId, "messageId");
      const userId = requireString(input?.userId, "userId");
      const emojiKey = requireString(input?.emojiKey, "emojiKey");
      const action = assertOneOf(input?.action, reactionActions, "action");
      const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
      const sourceSequence = safeSequence(input?.sourceSequence, occurredAt);
      const previous = getReactionState(guildId, messageId, userId, emojiKey);
      const active = action === "add";
      if (
        previous &&
        (sourceSequence < previous.sourceSequence || previous.active === active)
      ) {
        return {
          eventId: previous.lastEventId,
          inserted: false,
          duplicate: previous.active === active,
          stale: sourceSequence < previous.sourceSequence,
          previous,
          event: null,
        };
      }
      const result = recordReactionEvent({
        ...input,
        guildId,
        channelId,
        messageId,
        userId,
        emojiKey,
        action,
        occurredAt,
        sourceSequence,
      });
      if (!result.inserted) {
        return { ...result, duplicate: true, stale: false, previous };
      }
      store.run(
        `INSERT INTO local_reaction_state (
           guild_id, channel_id, message_id, user_id, emoji_key, active,
           recipient_id, reactor_is_bot, last_event_id, source_sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, message_id, user_id, emoji_key) DO UPDATE SET
           channel_id = excluded.channel_id,
           active = excluded.active,
           recipient_id = excluded.recipient_id,
           reactor_is_bot = excluded.reactor_is_bot,
           last_event_id = excluded.last_event_id,
           source_sequence = excluded.source_sequence,
           updated_at = excluded.updated_at`,
        guildId,
        channelId,
        messageId,
        userId,
        emojiKey,
        booleanInteger(active),
        optionalString(input?.recipientId),
        booleanInteger(input?.reactorIsBot),
        result.eventId,
        sourceSequence,
        now(),
      );
      return { ...result, duplicate: false, stale: false, previous };
    });
  }

  function recordVoiceEvent(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const userId = requireString(input?.userId, "userId");
    const sessionId = requireString(input?.sessionId, "sessionId");
    const eventType = assertOneOf(input?.eventType, voiceEventTypes, "eventType");
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const sourceSequence = safeSequence(input?.sourceSequence, occurredAt);
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId(`voice-${eventType}`, [
          guildId,
          userId,
          sessionId,
          sourceSequence,
        ]);
    const result = store.run(
      `INSERT OR IGNORE INTO voice_events (
         event_id, guild_id, channel_id, user_id, session_id, event_type,
         previous_channel_id, payload_json, occurred_at, created_at,
         source_sequence, started_at, ended_at, duration_seconds,
         recovered, recovery_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      sourceSequence,
      input?.startedAt == null ? null : toEpochMilliseconds(input.startedAt, "startedAt"),
      input?.endedAt == null ? null : toEpochMilliseconds(input.endedAt, "endedAt"),
      input?.durationSeconds == null
        ? null
        : Math.max(0, Math.trunc(Number(input.durationSeconds))),
      booleanInteger(input?.recovered),
      optionalString(input?.recoveryReason),
    );
    return inserted(result, eventId, {
      event: {
        eventId,
        guildId,
        channelId: optionalString(input?.channelId),
        previousChannelId: optionalString(input?.previousChannelId),
        userId,
        sessionId,
        eventType,
        occurredAt,
        sourceSequence,
        startedAt: input?.startedAt ?? null,
        endedAt: input?.endedAt ?? null,
        durationSeconds: input?.durationSeconds ?? null,
        recovered: Boolean(input?.recovered),
      },
    });
  }

  function getOpenVoiceSession(guildId, userId) {
    return mapVoiceSession(
      store.get(
        `SELECT * FROM local_voice_session
         WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL`,
        requireString(guildId, "guildId"),
        requireString(userId, "userId"),
      ),
    );
  }

  function listOpenVoiceSessions(guildId) {
    return store
      .all(
        `SELECT * FROM local_voice_session
         WHERE guild_id = ? AND ended_at IS NULL ORDER BY user_id`,
        requireString(guildId, "guildId"),
      )
      .map(mapVoiceSession);
  }

  function getLastVoiceSourceSequence(guildId, userId) {
    const row = store.get(
      `SELECT MAX(source_sequence) AS source_sequence
       FROM voice_events WHERE guild_id = ? AND user_id = ?`,
      requireString(guildId, "guildId"),
      requireString(userId, "userId"),
    );
    return row?.source_sequence == null ? null : Number(row.source_sequence);
  }

  function openVoiceSession({
    guildId,
    userId,
    channelId,
    sessionId,
    startedAt,
    recovered,
    recoveryReason,
    roleIds,
  }) {
    store.run(
      `INSERT INTO local_voice_session (
         session_id, guild_id, user_id, channel_id, started_at, ended_at,
         duration_seconds, recovered, recovery_reason, role_ids_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      sessionId,
      guildId,
      userId,
      channelId,
      startedAt,
      booleanInteger(recovered),
      optionalString(recoveryReason),
      serializeJson(roleIds ?? []),
      now(),
      now(),
    );
  }

  function closeVoiceSession(session, endedAt, { durationKnown = true } = {}) {
    const durationSeconds = durationKnown
      ? Math.max(0, Math.floor((endedAt - session.startedAt) / 1_000))
      : null;
    store.run(
      `UPDATE local_voice_session
       SET ended_at = ?, duration_seconds = ?, updated_at = ?
       WHERE session_id = ? AND ended_at IS NULL`,
      endedAt,
      durationSeconds,
      now(),
      session.sessionId,
    );
    return durationSeconds;
  }

  function recordVoiceTransition(input) {
    return inTransaction(() => {
      const guildId = requireString(input?.guildId, "guildId");
      const userId = requireString(input?.userId, "userId");
      const previousChannelId = optionalString(input?.previousChannelId);
      const channelId = optionalString(input?.channelId);
      if (previousChannelId === channelId) {
        return { inserted: false, duplicate: true, events: [] };
      }
      const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
      const sourceSequence = safeSequence(input?.sourceSequence, occurredAt);
      const current = getOpenVoiceSession(guildId, userId);
      const previousSourceSequence = getLastVoiceSourceSequence(guildId, userId);
      if (previousSourceSequence != null && sourceSequence <= previousSourceSequence) {
        return {
          inserted: false,
          duplicate: sourceSequence === previousSourceSequence,
          stale: sourceSequence < previousSourceSequence,
          events: [],
          current,
        };
      }
      const inferredType = previousChannelId
        ? channelId
          ? "move"
          : "leave"
        : "join";
      const eventType = assertOneOf(input?.eventType ?? inferredType, voiceEventTypes, "eventType");

      if (
        (eventType === "join" && current?.channelId === channelId) ||
        (eventType === "move" && current?.channelId === channelId) ||
        (eventType === "leave" && !current)
      ) {
        return { inserted: false, duplicate: true, events: [], current };
      }

      const recovered = Boolean(input?.recovered);
      const recoveryReason = optionalString(input?.recoveryReason);
      const durationKnown = input?.durationKnown !== false;
      let durationSeconds = null;
      let sessionId = current?.sessionId ?? null;
      let startedAt = current?.startedAt ?? null;
      const affectedChannelIds = new Set(
        [current?.channelId, previousChannelId, channelId].filter(Boolean),
      );

      if (current) {
        durationSeconds = closeVoiceSession(current, occurredAt, { durationKnown });
      }

      let nextSessionId = null;
      if (channelId) {
        nextSessionId = createStableEventId("voice-session", [
          guildId,
          userId,
          channelId,
          sourceSequence,
        ]);
        openVoiceSession({
          guildId,
          userId,
          channelId,
          sessionId: nextSessionId,
          startedAt: occurredAt,
          recovered,
          recoveryReason,
          roleIds: input?.roleIds,
        });
        if (!sessionId) {
          sessionId = nextSessionId;
          startedAt = occurredAt;
        }
      }

      if (!sessionId) {
        sessionId = createStableEventId("voice-observation", [
          guildId,
          userId,
          eventType,
          sourceSequence,
        ]);
      }
      const result = recordVoiceEvent({
        ...input,
        guildId,
        userId,
        channelId,
        previousChannelId: current?.channelId ?? previousChannelId,
        sessionId,
        eventType,
        occurredAt,
        sourceSequence,
        startedAt,
        endedAt: current ? occurredAt : null,
        durationSeconds,
        recovered,
        recoveryReason,
        payload: {
          ...(input?.payload ?? {}),
          nextSessionId,
          affectedChannelIds: [...affectedChannelIds],
          durationSeconds,
          recovered,
          recoveryReason,
        },
      });
      return {
        ...result,
        duplicate: !result.inserted,
        events: result.inserted ? [result.event] : [],
        affectedChannelIds: [...affectedChannelIds],
        closedSessionId: current?.sessionId ?? null,
        openedSessionId: nextSessionId,
      };
    });
  }

  function reconcileVoiceSessions({ guildId, states = [], occurredAt = now() }) {
    const normalizedGuildId = requireString(guildId, "guildId");
    const at = toEpochMilliseconds(occurredAt);
    return inTransaction(() => {
      const sequenceBase = safeSequence(at * 1_000, at);
      let sequenceOffset = 0;
      const nextRecoverySequence = () => sequenceBase + sequenceOffset++;
      const live = new Map(
        states.map((state) => [
          requireString(state.userId, "state.userId"),
          {
            channelId: requireString(state.channelId, "state.channelId"),
            roleIds: Array.isArray(state.roleIds) ? state.roleIds.map(String).sort() : [],
          },
        ]),
      );
      const results = [];
      for (const session of listOpenVoiceSessions(normalizedGuildId)) {
        const state = live.get(session.userId);
        if (state?.channelId === session.channelId) {
          live.delete(session.userId);
          continue;
        }
        results.push(recordVoiceTransition({
          guildId: normalizedGuildId,
          userId: session.userId,
          previousChannelId: session.channelId,
          channelId: state?.channelId ?? null,
          eventType: state ? "move" : "leave",
          occurredAt: at,
          sourceSequence: nextRecoverySequence(),
          roleIds: state?.roleIds ?? session.roleIds,
          recovered: true,
          recoveryReason: state ? "channel_changed_during_restart" : "absent_after_restart",
          durationKnown: false,
        }));
        live.delete(session.userId);
      }
      for (const [userId, state] of live) {
        results.push(recordVoiceTransition({
          guildId: normalizedGuildId,
          userId,
          previousChannelId: null,
          channelId: state.channelId,
          eventType: "join",
          occurredAt: at,
          sourceSequence: nextRecoverySequence(),
          roleIds: state.roleIds,
          recovered: true,
          recoveryReason: "present_after_restart_without_open_session",
          durationKnown: false,
        }));
      }
      return results;
    });
  }

  function recordMemberEvent(input) {
    const guildId = requireString(input?.guildId, "guildId");
    const userId = requireString(input?.userId, "userId");
    const eventType = assertOneOf(input?.eventType, memberEventTypes, "eventType");
    const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
    const sourceSequence = safeSequence(input?.sourceSequence, occurredAt);
    const eventId = input?.eventId
      ? requireString(input.eventId, "eventId")
      : createStableEventId(`member-${eventType}`, [
          guildId,
          userId,
          sourceSequence,
        ]);
    const result = store.run(
      `INSERT OR IGNORE INTO member_events (
         event_id, guild_id, user_id, event_type, payload_json, occurred_at,
         created_at, source_sequence, joined_at, left_at, role_hash, is_bot
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      guildId,
      userId,
      eventType,
      serializeJson(input?.payload),
      occurredAt,
      now(),
      sourceSequence,
      input?.joinedAt == null ? null : toEpochMilliseconds(input.joinedAt, "joinedAt"),
      input?.leftAt == null ? null : toEpochMilliseconds(input.leftAt, "leftAt"),
      optionalString(input?.roleHash),
      booleanInteger(input?.isBot),
    );
    return inserted(result, eventId, {
      event: {
        eventId,
        guildId,
        userId,
        eventType,
        occurredAt,
        sourceSequence,
        memberCount:
          Number.isInteger(input?.memberCount) && input.memberCount >= 0
            ? input.memberCount
            : null,
      },
    });
  }

  function getMemberState(guildId, userId) {
    return mapMemberState(
      store.get(
        `SELECT * FROM local_member_state WHERE guild_id = ? AND user_id = ?`,
        requireString(guildId, "guildId"),
        requireString(userId, "userId"),
      ),
    );
  }

  function updateGuildMemberCount(guildId, memberCount, sourceSequence) {
    if (!Number.isInteger(memberCount) || memberCount < 0) return;
    store.run(
      `INSERT INTO local_member_guild_state (
         guild_id, current_member_count, source_sequence, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         current_member_count = CASE
           WHEN excluded.source_sequence >= local_member_guild_state.source_sequence
             THEN excluded.current_member_count
           ELSE local_member_guild_state.current_member_count
         END,
         source_sequence = MAX(local_member_guild_state.source_sequence, excluded.source_sequence),
         updated_at = excluded.updated_at`,
      guildId,
      memberCount,
      sourceSequence,
      now(),
    );
  }

  function getGuildMemberCount(guildId) {
    const row = store.get(
      `SELECT current_member_count FROM local_member_guild_state WHERE guild_id = ?`,
      requireString(guildId, "guildId"),
    );
    return row?.current_member_count == null ? null : Number(row.current_member_count);
  }

  function recordMemberTransition(input) {
    return inTransaction(() => {
      const guildId = requireString(input?.guildId, "guildId");
      const userId = requireString(input?.userId, "userId");
      const eventType = assertOneOf(input?.eventType, memberEventTypes, "eventType");
      const occurredAt = toEpochMilliseconds(input?.occurredAt ?? now());
      const sourceSequence = safeSequence(input?.sourceSequence, occurredAt);
      const previous = getMemberState(guildId, userId);
      const roleHash = optionalString(input?.roleHash);
      const roleIds = Array.isArray(input?.roleIds)
        ? [...new Set(input.roleIds.map(String))].sort()
        : [];
      updateGuildMemberCount(guildId, input?.memberCount, sourceSequence);

      const desiredPresence = eventType === "leave" ? false : true;
      const sameRoles = (previous?.roleHash ?? null) === roleHash;
      if (
        previous &&
        (sourceSequence < previous.sourceSequence ||
          (eventType === "join" && previous.isPresent) ||
          (eventType === "leave" && !previous.isPresent) ||
          ((eventType === "update" || eventType === "sync") &&
            previous.isPresent === desiredPresence && sameRoles))
      ) {
        return {
          eventId: previous.lastEventId,
          inserted: false,
          duplicate: sourceSequence >= previous.sourceSequence,
          stale: sourceSequence < previous.sourceSequence,
          previous,
          event: null,
        };
      }

      const joinedAt = eventType === "join"
        ? toEpochMilliseconds(input?.joinedAt ?? occurredAt, "joinedAt")
        : previous?.joinedAt ?? (input?.joinedAt == null ? null : toEpochMilliseconds(input.joinedAt, "joinedAt"));
      const leftAt = eventType === "leave" ? occurredAt : null;
      const result = recordMemberEvent({
        ...input,
        guildId,
        userId,
        eventType,
        occurredAt,
        sourceSequence,
        joinedAt,
        leftAt,
        roleHash,
        roleIds,
        payload: {
          ...(input?.payload ?? {}),
          memberCount:
            Number.isInteger(input?.memberCount) && input.memberCount >= 0
              ? input.memberCount
              : null,
          roleIds,
          roleHash,
          isBot: Boolean(input?.isBot),
        },
      });
      if (!result.inserted) {
        return { ...result, duplicate: true, stale: false, previous };
      }
      store.run(
        `INSERT INTO local_member_state (
           guild_id, user_id, is_present, is_bot, joined_at, left_at,
           role_hash, role_ids_json, last_event_id, source_sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           is_present = excluded.is_present,
           is_bot = excluded.is_bot,
           joined_at = excluded.joined_at,
           left_at = excluded.left_at,
           role_hash = excluded.role_hash,
           role_ids_json = excluded.role_ids_json,
           last_event_id = excluded.last_event_id,
           source_sequence = excluded.source_sequence,
           updated_at = excluded.updated_at`,
        guildId,
        userId,
        booleanInteger(desiredPresence),
        booleanInteger(input?.isBot),
        joinedAt,
        leftAt,
        roleHash,
        serializeJson(roleIds),
        result.eventId,
        sourceSequence,
        now(),
      );
      return { ...result, duplicate: false, stale: false, previous };
    });
  }

  function recordMemberBaseline({ guildId, members = [], memberCount, occurredAt = now() }) {
    const normalizedGuildId = requireString(guildId, "guildId");
    const at = toEpochMilliseconds(occurredAt);
    return inTransaction(() => {
      const sequenceBase = safeSequence(at * 1_000, at);
      const results = members.map((member, index) =>
        recordMemberTransition({
          ...member,
          guildId: normalizedGuildId,
          eventType: "sync",
          occurredAt: at,
          sourceSequence: safeSequence(member?.sourceSequence, sequenceBase + index),
          memberCount,
        }),
      );
      updateGuildMemberCount(
        normalizedGuildId,
        memberCount,
        sequenceBase + members.length,
      );
      return results;
    });
  }

  function getRawEventCounts(guildId = null) {
    const condition = guildId == null ? "" : " WHERE guild_id = ?";
    const parameters = guildId == null ? [] : [requireString(guildId, "guildId")];
    return {
      reactions: Number(
        store.get(`SELECT COUNT(*) AS count FROM reaction_events${condition}`, ...parameters)?.count ?? 0,
      ),
      voice: Number(
        store.get(`SELECT COUNT(*) AS count FROM voice_events${condition}`, ...parameters)?.count ?? 0,
      ),
      members: Number(
        store.get(`SELECT COUNT(*) AS count FROM member_events${condition}`, ...parameters)?.count ?? 0,
      ),
    };
  }

  return Object.freeze({
    recordMessageEvent,
    recordReactionEvent,
    recordReactionTransition,
    getReactionState,
    recordVoiceEvent,
    recordVoiceTransition,
    reconcileVoiceSessions,
    getOpenVoiceSession,
    listOpenVoiceSessions,
    recordMemberEvent,
    recordMemberTransition,
    recordMemberBaseline,
    getMemberState,
    getGuildMemberCount,
    getRawEventCounts,
  });
}
