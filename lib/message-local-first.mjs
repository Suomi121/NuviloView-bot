import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createLocalStorage,
  createStableEventId,
  createStorage,
  getLocalStorageConfig,
} from "./storage/index.mjs";
import { optionalString } from "./storage/contracts.mjs";
import {
  getMessageCanaryConfig,
  getMessageGuildRoutingMode,
} from "./message-canary.mjs";
import { getAnalyticsCompactionConfig } from "./sync/analytics-compaction.mjs";

function contentChecksum(content) {
  return createHash("sha256").update(String(content ?? "")).digest("hex");
}

function safeTimestamp(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

export class UnsafeMessageRoutingChangeError extends Error {
  constructor(pendingCount) {
    super(
      `Cannot return Message routing to Legacy Neon while ${pendingCount} local Message event(s) are unsynced.`,
    );
    this.name = "UnsafeMessageRoutingChangeError";
    this.code = "LOCAL_MESSAGE_ROLLBACK_PENDING";
    this.pendingCount = pendingCount;
  }
}

export function getMessageLocalFirstConfig(
  env = process.env,
  { cwd = process.cwd() } = {},
) {
  const local = getLocalStorageConfig(env, { cwd });
  const canary = getMessageCanaryConfig(env);
  return Object.freeze({
    enabled: canary.globalEnabled,
    allGuildsEnabled: canary.allGuildsEnabled,
    canaryGuildIds: canary.guildIds,
    forceLegacyWithPending: ["1", "true", "yes", "on"].includes(
      String(env.LOCAL_MESSAGE_STORAGE_FORCE_LEGACY_WITH_PENDING ?? "")
        .trim()
        .toLowerCase(),
    ),
    databasePath: local.databasePath,
  });
}

export function normalizeDiscordMessageEvent(
  message,
  eventType,
  { now = () => Date.now(), roleIdsForMessage = null } = {},
) {
  const guildId = String(message?.guild?.id ?? message?.guildId ?? "").trim();
  const channelId = String(message?.channel?.id ?? message?.channelId ?? "").trim();
  const messageId = String(message?.id ?? "").trim();
  if (!guildId || !channelId || !messageId) {
    throw new TypeError("A guild, channel, and message ID are required.");
  }
  if (!["create", "update", "delete"].includes(eventType)) {
    throw new TypeError("eventType must be create, update, or delete.");
  }
  const observedAt = now();
  const createdAt = safeTimestamp(
    message?.createdTimestamp ?? message?.createdAt?.getTime?.(),
    observedAt,
  );
  const editedAt = safeTimestamp(
    message?.editedTimestamp ?? message?.editedAt?.getTime?.(),
    observedAt,
  );
  const occurredAt = eventType === "create"
    ? createdAt
    : eventType === "update"
      ? editedAt
      : observedAt;
  const content = eventType === "delete" ? null : String(message?.content ?? "");
  const checksum = eventType === "delete" ? null : contentChecksum(content);
  const sourceSequence = occurredAt;
  const revision = eventType === "delete"
    ? `delete:${sourceSequence}`
    : `${eventType}:${sourceSequence}:${checksum}`;
  const eventId = eventType === "update"
    ? createStableEventId("message-update", [guildId, messageId, revision])
    : createStableEventId(`message-${eventType}`, [guildId, messageId]);
  const authorId = message?.author?.id == null ? null : String(message.author.id);
  const authorName =
    message?.member?.displayName ??
    message?.author?.globalName ??
    message?.author?.username ??
    null;
  const channelName = "name" in (message?.channel ?? {})
    ? message.channel.name
    : null;
  const roleIds = typeof roleIdsForMessage === "function"
    ? [...(roleIdsForMessage(message) ?? [])].map(String).sort()
    : message?.member?.roles?.cache
      ? [...message.member.roles.cache.keys()].map(String).sort()
      : [];
  const reference = message?.reference
    ? {
        messageId: optionalString(message.reference.messageId),
        channelId: optionalString(message.reference.channelId),
        guildId: optionalString(message.reference.guildId),
        type: message.reference.type == null
          ? null
          : String(message.reference.type),
      }
    : null;

  return {
    eventId,
    guildId,
    channelId,
    messageId,
    authorId,
    eventType,
    revision,
    sourceSequence,
    content,
    contentChecksum: checksum,
    occurredAt,
    actorName: authorName ?? "unknown",
    channelName,
    memberCount: Number.isSafeInteger(message?.guild?.memberCount)
      ? message.guild.memberCount
      : null,
    payload: {
      guildId,
      channelId,
      channelName,
      messageId,
      authorId,
      authorName,
      authorIsBot: Boolean(message?.author?.bot),
      authorRoleIds: roleIds,
      content,
      contentChecksum: checksum,
      eventType,
      revision,
      sourceSequence,
      occurredAt,
      reference,
      source: "live",
    },
  };
}

function messageEnvelope(event) {
  return {
    eventId: event.eventId,
    domain: "bot_event",
    eventType: `message_${event.eventType}`,
    aggregateId: `message:${event.guildId}:${event.messageId}`,
    payload: {
      ...event.payload,
      eventId: event.eventId,
    },
    schemaVersion: 1,
    createdAt: event.occurredAt,
  };
}

function openGuardStorage(config, providedStorage) {
  if (providedStorage?.enabled) {
    return { storage: providedStorage, close: false };
  }
  if (!existsSync(config.databasePath)) return { storage: null, close: false };
  return {
    storage: createLocalStorage({
      databasePath: config.databasePath,
      readOnly: true,
      writeEnabled: false,
    }),
    close: true,
  };
}

export function verifyMessageRoutingSafety({
  config,
  storage,
  logger = console,
}) {
  const activeGuildIds = config.enabled ? config.canaryGuildIds : [];
  const localRoutingEnabled = config.enabled &&
    (config.allGuildsEnabled || activeGuildIds.length > 0);
  if (localRoutingEnabled) {
    if (!storage?.enabled || !storage?.writeEnabled) {
      const error = new Error(
        "LOCAL_MESSAGE_STORAGE_ENABLED requires LOCAL_STORAGE_ENABLED and LOCAL_STORAGE_WRITE_ENABLED.",
      );
      error.code = "LOCAL_MESSAGE_STORAGE_NOT_WRITABLE";
      throw error;
    }
  }

  const guard = openGuardStorage(config, storage);
  if (!guard.storage) {
    return {
      mode: "legacy_neon",
      pendingCount: 0,
      canaryGuildIds: activeGuildIds,
    };
  }
  try {
    const routing = guard.storage.syncMetadata.get("message_domain_routing");
    const previousGuildIds = Array.isArray(routing?.metadata?.canaryGuildIds)
      ? routing.metadata.canaryGuildIds.map(String)
      : [];
    const removedGuildIds = previousGuildIds.filter(
      (guildId) => !activeGuildIds.includes(guildId),
    );
    const previousAllGuilds = routing?.metadata?.allGuildsEnabled === true ||
      routing?.state === "local_first_all" ||
      (routing?.state === "local_first" && previousGuildIds.length === 0);
    const legacyGlobalState = previousAllGuilds && !config.allGuildsEnabled;
    const pendingCount = legacyGlobalState
      ? guard.storage.outbox.getMessagePendingCount()
      : removedGuildIds.reduce(
          (total, guildId) =>
            total + guard.storage.outbox.getMessagePendingCount({ guildId }),
          0,
        );
    if (
      pendingCount > 0 &&
      !config.forceLegacyWithPending
    ) {
      logger.error?.(
        `[message-routing] rollback blocked: ${pendingCount} unsynced Message event(s).`,
      );
      throw new UnsafeMessageRoutingChangeError(pendingCount);
    }
    if (
      pendingCount > 0 &&
      config.forceLegacyWithPending
    ) {
      logger.warn?.(
        `[message-routing] forced Legacy routing with ${pendingCount} unsynced Message event(s); manual reconciliation is required.`,
      );
    }
    if (guard.storage.writeEnabled && pendingCount === 0) {
      const canarySetChanged =
        Boolean(routing?.metadata?.allGuildsEnabled) !== Boolean(config.allGuildsEnabled) ||
        previousGuildIds.length !== activeGuildIds.length ||
        previousGuildIds.some((guildId, index) => guildId !== activeGuildIds[index]);
      guard.storage.syncMetadata.set({
        streamName: "message_domain_routing",
        state: config.allGuildsEnabled
          ? "local_first_all"
          : activeGuildIds.length > 0
            ? "canary"
            : "legacy_neon",
        metadata: {
          schemaVersion: 3,
          canaryGuildIds: activeGuildIds,
          allGuildsEnabled: Boolean(config.allGuildsEnabled),
        },
      });
      for (const guildId of activeGuildIds) {
        guard.storage.syncMetadata.set({
          streamName: `message_domain_routing:${guildId}`,
          state: "local_first",
          metadata: { schemaVersion: 2, guildId },
        });
      }
      for (const guildId of removedGuildIds) {
        guard.storage.syncMetadata.set({
          streamName: `message_domain_routing:${guildId}`,
          state: "legacy_neon",
          metadata: { schemaVersion: 2, guildId },
        });
      }
      if (localRoutingEnabled && canarySetChanged) {
        const metrics = guard.storage.messageDomain.getMetrics();
        guard.storage.syncMetadata.set({
          streamName: "message_canary_baseline",
          state: "active",
          metadata: {
            schemaVersion: 1,
            canaryGuildIds: activeGuildIds,
            allGuildsEnabled: Boolean(config.allGuildsEnabled),
            messageLocalWriteFailures: metrics.messageLocalWriteFailures,
            messageSyncFailureTotal: metrics.messageSyncFailureTotal,
            deadLetterCount: guard.storage.outbox.getMessageDeadLetterCount(),
          },
        });
      }
    }
    return {
      mode: config.allGuildsEnabled
        ? "all_guilds"
        : activeGuildIds.length > 0
          ? "canary"
          : "legacy_neon",
      pendingCount,
      canaryGuildIds: activeGuildIds,
    };
  } finally {
    if (guard.close) guard.storage.close();
  }
}

export function createMessageDomainRouter({
  env = process.env,
  cwd = process.cwd(),
  storage = createStorage({ env, cwd }),
  legacy,
  now = () => Date.now(),
  logger = console,
  roleIdsForMessage = null,
} = {}) {
  const config = getMessageLocalFirstConfig(env, { cwd });
  const compaction = getAnalyticsCompactionConfig(env);
  const compactionOutsideCanary = compaction.guildIds.filter(
    (guildId) => !config.canaryGuildIds.includes(guildId),
  );
  if (
    compaction.enabled &&
    (compaction.errors.length > 0 ||
      (!config.allGuildsEnabled && compactionOutsideCanary.length > 0) ||
      (config.allGuildsEnabled && !compaction.allGuildsEnabled))
  ) {
    const error = new Error(
      "Analytics Compaction requires a writable Message Local-First Canary and an enabled Snapshot Worker.",
    );
    error.code = "ANALYTICS_COMPACTION_UNSAFE_CONFIGURATION";
    error.details = [
      ...compaction.errors,
      ...(config.allGuildsEnabled && !compaction.allGuildsEnabled
        ? ["analytics_compaction_all_guilds_required"]
        : []),
      ...compactionOutsideCanary.map(
        (guildId) => `analytics_compaction_guild_not_message_canary:${guildId}`,
      ),
    ];
    throw error;
  }
  const routing = verifyMessageRoutingSafety({ config, storage, logger });

  function isLocalFirstGuild(guildId) {
    return getMessageGuildRoutingMode(
      {
        globalEnabled: config.enabled,
        allGuildsEnabled: config.allGuildsEnabled,
        guildIds: config.canaryGuildIds,
      },
      guildId,
    ) === "LOCAL_FIRST";
  }

  function persistOne(message, eventType) {
    const normalized = normalizeDiscordMessageEvent(message, eventType, {
      now,
      roleIdsForMessage,
    });
    return storage.transaction(() => {
      const previous = storage.messageDomain.getCurrent(
        normalized.guildId,
        normalized.messageId,
      );
      const existingEvent = storage.messageDomain.getEventById(normalized.eventId);
      const eventInput = existingEvent?.source === "history_import"
        ? normalized
        : existingEvent ?? normalized;
      const result = storage.messageDomain.recordEvent(eventInput);
      if (result.inserted && compaction.isEnabledForGuild(normalized.guildId)) {
        storage.analyticsProjections.markMessageEvent(result.event);
      }
      // Compacted Guilds keep raw message content exclusively in SQLite. The
      // projection snapshot becomes the Cloud delivery unit instead.
      if (!compaction.isEnabledForGuild(normalized.guildId)) {
        storage.outbox.enqueue(messageEnvelope(result.event));
      }
      return { ...result, previous };
    });
  }

  function localFailure(error) {
    try {
      storage.messageDomain.recordWriteFailure(now());
    } catch {
      // The original storage failure is more useful than a secondary metric error.
    }
    logger.error?.(
      `[message-storage] local write failed (${error?.code ?? error?.name ?? "unknown"}).`,
    );
    throw error;
  }

  async function create(message) {
    if (!isLocalFirstGuild(message?.guild?.id ?? message?.guildId)) {
      return legacy.create(message);
    }
    try {
      return persistOne(message, "create");
    } catch (error) {
      return localFailure(error);
    }
  }

  async function update(message) {
    if (!isLocalFirstGuild(message?.guild?.id ?? message?.guildId)) {
      return legacy.update(message);
    }
    try {
      return persistOne(message, "update");
    } catch (error) {
      return localFailure(error);
    }
  }

  async function remove(message) {
    if (!isLocalFirstGuild(message?.guild?.id ?? message?.guildId)) {
      return legacy.remove(message);
    }
    try {
      return persistOne(message, "delete");
    } catch (error) {
      return localFailure(error);
    }
  }

  async function removeMany(messages) {
    const modes = new Set(
      messages.map((message) =>
        isLocalFirstGuild(message?.guild?.id ?? message?.guildId),
      ),
    );
    if (modes.size > 1) {
      const results = [];
      for (const message of messages) results.push(await remove(message));
      return results;
    }
    if (!modes.has(true)) {
      const results = [];
      for (const message of messages) results.push(await legacy.remove(message));
      return results;
    }
    try {
      return storage.transaction(() =>
        messages.map((message) => {
          const normalized = normalizeDiscordMessageEvent(message, "delete", {
            now,
            roleIdsForMessage,
          });
          const previous = storage.messageDomain.getCurrent(
            normalized.guildId,
            normalized.messageId,
          );
          const existingEvent = storage.messageDomain.getEventById(normalized.eventId);
          const eventInput = existingEvent?.source === "history_import"
            ? normalized
            : existingEvent ?? normalized;
          const result = storage.messageDomain.recordEvent(eventInput);
          if (result.inserted && compaction.isEnabledForGuild(normalized.guildId)) {
            storage.analyticsProjections.markMessageEvent(result.event);
          }
          if (!compaction.isEnabledForGuild(normalized.guildId)) {
            storage.outbox.enqueue(messageEnvelope(result.event));
          }
          return { ...result, previous };
        }),
      );
    } catch (error) {
      return localFailure(error);
    }
  }

  async function recordActiveMemberObservation({ guildId, userId, occurredAt }) {
    if (!isLocalFirstGuild(guildId)) {
      return legacy.recordActiveMember({ guildId, userId });
    }
    const dateUtc = new Date(occurredAt).toISOString().slice(0, 10);
    const eventId = createStableEventId("message-active-member", [
      guildId,
      userId,
      dateUtc,
    ]);
    try {
      return storage.transaction(() => {
        const result = storage.messageDomain.recordActiveMemberObservation({
          guildId,
          userId,
          dateUtc,
          occurredAt,
        });
        if (result.inserted && compaction.isEnabledForGuild(guildId)) {
          storage.analyticsProjections.markActiveMemberObservation({
            guildId,
            userId,
            dateUtc,
            occurredAt,
          });
        }
        if (!compaction.isEnabledForGuild(guildId)) {
          storage.outbox.enqueue({
            eventId,
            domain: "bot_event",
            eventType: "message_active_member",
            aggregateId: `active-member:${guildId}:${userId}:${dateUtc}`,
            payload: { guildId, userId, dateUtc, occurredAt },
            schemaVersion: 1,
            createdAt: new Date(`${dateUtc}T00:00:00.000Z`).getTime(),
          });
        }
        return result;
      });
    } catch (error) {
      return localFailure(error);
    }
  }

  function getLastActivityAt(guildId) {
    return isLocalFirstGuild(guildId)
      ? storage.messageDomain.getLastActivityAt(guildId)
      : null;
  }

  return Object.freeze({
    enabled: config.enabled &&
      (config.allGuildsEnabled || config.canaryGuildIds.length > 0),
    globalEnabled: config.enabled,
    config,
    compaction,
    routing,
    storage,
    create,
    update,
    remove,
    removeMany,
    recordActiveMemberObservation,
    isLocalFirstGuild,
    getRoutingMode: (guildId) =>
      isLocalFirstGuild(guildId) ? "LOCAL_FIRST" : "LEGACY",
    getLastActivityAt,
    close: () => storage.close(),
  });
}
