import { createHash } from "node:crypto";
import { getDiscordReactionEmojiKey } from "./reaction-role-utils.mjs";
import { getLocalStorageConfig } from "./storage/index.mjs";
import { getAnalyticsCompactionConfig } from "./sync/analytics-compaction.mjs";

const domains = Object.freeze(["reaction", "voice", "member"]);

function enabledFlag(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

function parseGuildIds(value) {
  return Object.freeze(
    [...new Set(
      String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )],
  );
}

function roleIds(member) {
  if (!member?.roles?.cache) return [];
  const everyoneId = member.guild?.id;
  return [...member.roles.cache.keys()]
    .filter((roleId) => roleId !== everyoneId)
    .map(String)
    .sort();
}

function roleHash(values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function getEventLocalFirstConfig(
  env = process.env,
  { cwd = process.cwd() } = {},
) {
  const enabled = enabledFlag(env.EVENT_LOCAL_FIRST_ENABLED);
  const allGuildsEnabled = enabledFlag(env.LOCAL_FIRST_ALL_GUILDS_ENABLED);
  const guildIds = parseGuildIds(env.EVENT_LOCAL_FIRST_GUILD_IDS);
  const local = getLocalStorageConfig(env, { cwd });
  const compaction = getAnalyticsCompactionConfig(env);
  const domainEnabled = Object.freeze({
    reaction: enabled && enabledFlag(env.EVENT_LOCAL_FIRST_REACTION_ENABLED, true),
    voice: enabled && enabledFlag(env.EVENT_LOCAL_FIRST_VOICE_ENABLED, true),
    member: enabled && enabledFlag(env.EVENT_LOCAL_FIRST_MEMBER_ENABLED, true),
  });
  const errors = [];
  if (enabled && guildIds.length === 0 && !allGuildsEnabled) {
    errors.push("event_local_first_guild_list_empty");
  }
  if (enabled && (!local.enabled || !local.writeEnabled)) {
    errors.push("event_local_first_requires_writable_local_storage");
  }
  if (enabled && !compaction.enabled) {
    errors.push("event_local_first_requires_analytics_compaction");
  }
  if (enabled && !Object.values(domainEnabled).some(Boolean)) {
    errors.push("event_local_first_has_no_enabled_domain");
  }
  if (enabled && allGuildsEnabled && !compaction.allGuildsEnabled) {
    errors.push("event_local_first_requires_all_guild_compaction");
  }
  for (const guildId of guildIds) {
    if (enabled && !compaction.allGuildsEnabled && !compaction.guildIds.includes(guildId)) {
      errors.push(`event_local_first_guild_not_compacted:${guildId}`);
    }
  }
  return Object.freeze({
    enabled,
    allGuildsEnabled,
    guildIds,
    domains: domainEnabled,
    local,
    compaction,
    errors: Object.freeze(errors),
    isEnabledForGuild(domain, guildId) {
      if (!domains.includes(domain)) throw new TypeError("Unknown Event Local-First domain.");
      return Boolean(
        enabled &&
        domainEnabled[domain] &&
        (allGuildsEnabled || guildIds.includes(String(guildId ?? ""))),
      );
    },
  });
}

export class UnsafeEventLocalFirstConfigurationError extends Error {
  constructor(errors) {
    super("Event Local-First configuration is not safe to start.");
    this.name = "UnsafeEventLocalFirstConfigurationError";
    this.code = "EVENT_LOCAL_FIRST_UNSAFE_CONFIGURATION";
    this.details = [...errors];
  }
}

export function createEventDomainRouter({
  env = process.env,
  cwd = process.cwd(),
  storage,
  legacy = {},
  now = () => Date.now(),
  logger = console,
} = {}) {
  const config = getEventLocalFirstConfig(env, { cwd });
  if (config.errors.length > 0) {
    throw new UnsafeEventLocalFirstConfigurationError(config.errors);
  }
  let lastSourceSequence = 0;

  function nextSourceSequence() {
    const base = Math.max(0, Math.trunc(now())) * 1_000;
    lastSourceSequence = Math.max(base, lastSourceSequence + 1);
    return lastSourceSequence;
  }

  function isLocalFirstGuild(domain, guildId) {
    return config.isEnabledForGuild(domain, guildId);
  }

  function localFailure(domain, error) {
    logger.error?.(
      `[event-storage:${domain}] local write failed (${error?.code ?? error?.name ?? "unknown"}).`,
    );
    throw error;
  }

  async function reaction(reactionValue, user, action) {
    const guild = reactionValue?.message?.guild;
    if (!guild || !isLocalFirstGuild("reaction", guild.id)) {
      return legacy.reaction?.(reactionValue, user, action) ?? null;
    }
    try {
      const occurredAt = now();
      const sourceSequence = nextSourceSequence();
      return storage.transaction(() => {
        const result = storage.analytics.recordReactionTransition({
          guildId: guild.id,
          channelId: reactionValue.message.channelId,
          messageId: reactionValue.message.id,
          userId: user.id,
          emojiKey: getDiscordReactionEmojiKey(reactionValue.emoji),
          action,
          recipientId: reactionValue.message.author?.id ?? null,
          reactorIsBot: Boolean(user.bot),
          occurredAt,
          sourceSequence,
          payload: {
            source: "discord_gateway",
            roleIds: roleIds(
              guild.members.cache.get(user.id) ?? null,
            ),
          },
        });
        if (result.inserted) {
          storage.analyticsProjections.markReactionEvent(result.event);
        }
        return result;
      });
    } catch (error) {
      return localFailure("reaction", error);
    }
  }

  async function voice(oldState, newState) {
    const guild = newState?.guild ?? oldState?.guild;
    const member = newState?.member ?? oldState?.member;
    if (!guild || !member || !isLocalFirstGuild("voice", guild.id)) {
      return legacy.voice?.(oldState, newState) ?? null;
    }
    if (member.user?.bot) return { inserted: false, ignored: "bot" };
    try {
      const occurredAt = now();
      const sourceSequence = nextSourceSequence();
      return storage.transaction(() => {
        const result = storage.analytics.recordVoiceTransition({
          guildId: guild.id,
          userId: member.id,
          previousChannelId: oldState?.channelId ?? null,
          channelId: newState?.channelId ?? null,
          occurredAt,
          sourceSequence,
          roleIds: roleIds(member),
          payload: { source: "discord_gateway" },
        });
        for (const event of result.events ?? []) {
          storage.analyticsProjections.markVoiceEvent({
            ...event,
            affectedChannelIds: result.affectedChannelIds,
          });
        }
        return result;
      });
    } catch (error) {
      return localFailure("voice", error);
    }
  }

  async function reconcileVoiceGuild(guild) {
    if (!isLocalFirstGuild("voice", guild?.id)) {
      return legacy.reconcileVoice?.(guild) ?? null;
    }
    try {
      const occurredAt = now();
      const states = [...guild.voiceStates.cache.values()]
        .filter((state) => state.channelId && state.member?.user?.bot === false)
        .map((state) => ({
          userId: state.member.id,
          channelId: state.channelId,
          roleIds: roleIds(state.member),
        }));
      return storage.transaction(() => {
        const results = storage.analytics.reconcileVoiceSessions({
          guildId: guild.id,
          states,
          occurredAt,
        });
        for (const result of results) {
          for (const event of result.events ?? []) {
            storage.analyticsProjections.markVoiceEvent({
              ...event,
              affectedChannelIds: result.affectedChannelIds,
            });
          }
        }
        return results;
      });
    } catch (error) {
      return localFailure("voice-recovery", error);
    }
  }

  function normalizeMember(member, eventType, before = null) {
    const roles = roleIds(member);
    const previousRoles = roleIds(before);
    return {
      guildId: member.guild.id,
      userId: member.id,
      eventType,
      isBot: Boolean(member.user?.bot),
      roleIds: roles,
      roleHash: roleHash(roles),
      joinedAt: member.joinedAt?.getTime?.() ?? member.joinedTimestamp ?? null,
      memberCount: member.guild.memberCount,
      payload: {
        source: "discord_gateway",
        previousRoleHash: before ? roleHash(previousRoles) : null,
      },
    };
  }

  async function member(memberValue, eventType, before = null) {
    const guildId = memberValue?.guild?.id;
    if (!guildId || !isLocalFirstGuild("member", guildId)) {
      return legacy.member?.(memberValue, eventType, before) ?? null;
    }
    try {
      const occurredAt = now();
      const sourceSequence = nextSourceSequence();
      return storage.transaction(() => {
        const result = storage.analytics.recordMemberTransition({
          ...normalizeMember(memberValue, eventType, before),
          occurredAt,
          sourceSequence,
        });
        if (result.inserted) {
          storage.analyticsProjections.markMemberEvent(result.event);
        }
        return result;
      });
    } catch (error) {
      return localFailure("member", error);
    }
  }

  async function syncMemberGuild(guild, { fetchMembers = true } = {}) {
    if (!isLocalFirstGuild("member", guild?.id)) {
      return legacy.syncMembers?.(guild, { fetchMembers }) ?? null;
    }
    if (fetchMembers) {
      try {
        await guild.members.fetch();
      } catch (error) {
        logger.warn?.(
          `[event-storage:member] full member baseline unavailable for ${guild.id}; cached members only (${error?.code ?? error?.name ?? "unknown"}).`,
        );
      }
    }
    try {
      const occurredAt = now();
      const members = [...guild.members.cache.values()].map((memberValue) => {
        const normalized = normalizeMember(memberValue, "sync");
        return {
          userId: normalized.userId,
          isBot: normalized.isBot,
          roleIds: normalized.roleIds,
          roleHash: normalized.roleHash,
          joinedAt: normalized.joinedAt,
          payload: { source: "discord_sync" },
        };
      });
      return storage.transaction(() => {
        const results = storage.analytics.recordMemberBaseline({
          guildId: guild.id,
          members,
          memberCount: guild.memberCount,
          occurredAt,
        });
        for (const result of results) {
          if (result.inserted) {
            storage.analyticsProjections.markMemberEvent(result.event);
          }
        }
        const sourceSequence = Math.max(0, Math.trunc(occurredAt)) * 1_000 + members.length;
        storage.analyticsProjections.markDirty({
          projectionKind: "guild_current",
          guildId: guild.id,
          sourceSequence,
          lastEventAt: occurredAt,
        });
        storage.analyticsProjections.markDirty({
          projectionKind: "guild_daily",
          guildId: guild.id,
          dateUtc: new Date(occurredAt).toISOString().slice(0, 10),
          sourceSequence,
          lastEventAt: occurredAt,
        });
        return results;
      });
    } catch (error) {
      return localFailure("member-baseline", error);
    }
  }

  return Object.freeze({
    enabled: config.enabled &&
      (config.allGuildsEnabled || config.guildIds.length > 0),
    config,
    storage,
    reaction,
    voice,
    member,
    reconcileVoiceGuild,
    syncMemberGuild,
    isLocalFirstGuild,
    getRoutingMode(domain, guildId) {
      return isLocalFirstGuild(domain, guildId) ? "LOCAL_FIRST" : "LEGACY_CLOUD";
    },
  });
}
