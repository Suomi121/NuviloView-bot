const DEFAULT_INTERVAL_SECONDS = 900;
const MINIMUM_INTERVAL_SECONDS = 60;

function enabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function guildIds(value) {
  return Object.freeze(
    [...new Set(
      String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )],
  );
}

export function getAnalyticsCompactionConfig(env = process.env) {
  const rawInterval = Number(
    env.ANALYTICS_SNAPSHOT_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS,
  );
  const intervalSeconds = Number.isSafeInteger(rawInterval)
    ? Math.min(86_400, Math.max(MINIMUM_INTERVAL_SECONDS, rawInterval))
    : DEFAULT_INTERVAL_SECONDS;
  const configuredGuildIds = guildIds(env.ANALYTICS_COMPACTION_GUILD_IDS);
  const enabled = enabledFlag(env.ANALYTICS_COMPACTION_ENABLED);
  const allGuildsEnabled = enabledFlag(env.LOCAL_FIRST_ALL_GUILDS_ENABLED);
  const prerequisites = Object.freeze({
    multiDb: enabledFlag(env.MULTI_DB_SYNC_ENABLED),
    worker: enabledFlag(env.SYNC_WORKER_ENABLED),
    snapshots: enabledFlag(env.SYNC_SNAPSHOT_ENABLED),
    localStorage: enabledFlag(env.LOCAL_STORAGE_ENABLED),
    localWrites: enabledFlag(env.LOCAL_STORAGE_WRITE_ENABLED),
  });
  const errors = [];
  if (enabled && configuredGuildIds.length === 0 && !allGuildsEnabled) {
    errors.push("analytics_compaction_guild_list_empty");
  }
  for (const [name, ready] of Object.entries(prerequisites)) {
    if (enabled && !ready) errors.push(`analytics_compaction_requires_${name}`);
  }
  return Object.freeze({
    enabled,
    allGuildsEnabled,
    guildIds: configuredGuildIds,
    intervalSeconds,
    intervalMs: intervalSeconds * 1_000,
    batchSize: Math.trunc(Math.min(
      1_000,
      Math.max(1, Number(env.ANALYTICS_PROJECTION_BATCH_SIZE) || 250),
    )),
    prerequisites,
    errors: Object.freeze(errors),
    isEnabledForGuild: (guildId) =>
      enabled &&
      (allGuildsEnabled || configuredGuildIds.includes(String(guildId ?? ""))),
  });
}

function projectionPayload(item, material, { generatedAt, intervalMs }) {
  return {
    schemaVersion: 3,
    projection: item.projectionKind,
    guildId: item.guildId,
    dateUtc: item.dateUtc,
    channelId: item.channelId,
    userId: item.userId,
    messageCount: material.messageCount,
    reactionCount: material.reactionCount,
    uniqueReactors: material.uniqueReactors,
    reactedMessages: material.reactedMessages,
    topReactions: material.topReactions,
    voiceMinutes: material.voiceMinutes,
    voiceSeconds: material.voiceSeconds,
    voiceSessions: material.voiceSessions,
    openVoiceSessions: material.openVoiceSessions,
    uniqueVoiceMembers: material.uniqueVoiceMembers,
    peakConcurrent: material.peakConcurrent,
    channelVoiceMinutes: material.channelVoiceMinutes,
    joins: material.joins,
    leaves: material.leaves,
    memberDelta: material.memberDelta,
    currentMemberCount: material.currentMemberCount,
    newMembers: material.newMembers,
    activeMembers: material.activeMembers,
    reactions: {
      count: material.reactionCount,
      adds: material.reactionAdds,
      removes: material.reactionRemoves,
      uniqueReactors: material.uniqueReactors,
      reactedMessages: material.reactedMessages,
      top: material.topReactions,
    },
    voice: {
      seconds: material.voiceSeconds,
      minutes: material.voiceMinutes,
      sessions: material.voiceSessions,
      openSessions: material.openVoiceSessions,
      uniqueMembers: material.uniqueVoiceMembers,
      peakConcurrent: material.peakConcurrent,
      channelMinutes: material.channelVoiceMinutes,
      recoveredUnknownSessions: material.recoveredUnknownSessions,
    },
    members: {
      joins: material.joins,
      leaves: material.leaves,
      delta: material.memberDelta,
      currentCount: material.currentMemberCount,
      newMembers: material.newMembers,
    },
    lastMessageAt: material.lastMessageAt,
    lastActivityAt: material.lastActivityAt,
    lastRuntimeSeenAt: generatedAt,
    lastUpdatedAt: generatedAt,
    nextUpdateAt: generatedAt + intervalMs,
    rawContentIncluded: false,
  };
}

function semanticPayload(payload) {
  const {
    lastRuntimeSeenAt: _lastRuntimeSeenAt,
    lastUpdatedAt: _lastUpdatedAt,
    nextUpdateAt: _nextUpdateAt,
    ...semantic
  } = payload;
  return semantic;
}

export function createAnalyticsCompactionService(
  storage,
  {
    config = getAnalyticsCompactionConfig(),
    now = () => Date.now(),
    logger = console,
  } = {},
) {
  if (!storage?.analyticsProjections || !storage?.snapshots) {
    throw new TypeError("Analytics projection-capable local storage is required.");
  }
  let bootstrapped = false;

  function bootstrapStreamName(guildId) {
    return `analytics_compaction_bootstrap_v3:${guildId}`;
  }

  function bootstrap() {
    if (!config.enabled || bootstrapped) {
      return { rawEvents: 0, marked: 0, skipped: true };
    }
    bootstrapped = true;
    const allGuildsStream = "analytics_compaction_bootstrap_v3:all_guilds";
    const pendingGuildIds = config.allGuildsEnabled
      ? null
      : config.guildIds.filter(
          (guildId) =>
            storage.syncMetadata.get(bootstrapStreamName(guildId))?.state !== "complete",
        );
    if (config.allGuildsEnabled) {
      if (storage.syncMetadata.get(allGuildsStream)?.state === "complete") {
        return { rawEvents: 0, marked: 0, skipped: true };
      }
    } else if (pendingGuildIds.length === 0) {
      return { rawEvents: 0, marked: 0, skipped: true };
    }
    const at = now();
    const result = storage.analyticsProjections.markExistingDataDirty({
      guildIds: pendingGuildIds,
      at,
    });
    for (const streamName of config.allGuildsEnabled
      ? [allGuildsStream]
      : pendingGuildIds.map(bootstrapStreamName)) {
      storage.syncMetadata.set({
        streamName,
        state: "complete",
        lastAttemptAt: at,
        lastSuccessAt: at,
        metadata: { schemaVersion: 3 },
      });
    }
    return { ...result, skipped: false };
  }

  function refreshDue({ at = now(), limit = config.batchSize } = {}) {
    if (
      !config.enabled ||
      (!config.allGuildsEnabled && config.guildIds.length === 0)
    ) {
      return {
        enabled: config.enabled,
        guildCount: config.allGuildsEnabled ? null : config.guildIds.length,
        built: 0,
        changed: 0,
        skipped: 0,
      };
    }
    bootstrap();
    const due = storage.analyticsProjections.listDue({
      at,
      limit,
      guildIds: config.allGuildsEnabled ? null : config.guildIds,
    });
    let changed = 0;
    let skipped = 0;
    for (const item of due) {
      const material = storage.analyticsProjections.buildMaterial(item);
      const payload = projectionPayload(item, material, {
        generatedAt: at,
        intervalMs: config.intervalMs,
      });
      const result = storage.snapshots.upsert({
        snapshotType: "analytics",
        aggregateId: item.projectionKey,
        generatedAt: at,
        payload,
        checksumPayload: semanticPayload(payload),
      });
      storage.analyticsProjections.recordBuild({ changed: result.changed, at });
      storage.analyticsProjections.markAggregated(
        item.projectionKey,
        item.sourceSequence,
        { at, intervalMs: config.intervalMs },
      );
      if (result.changed) changed += 1;
      else skipped += 1;
    }
    if (due.length > 0) {
      logger.info?.(
        `[analytics-compaction] built=${due.length} changed=${changed} skipped=${skipped}`,
      );
    }
    return {
      enabled: true,
      guildCount: config.allGuildsEnabled ? null : config.guildIds.length,
      built: due.length,
      changed,
      skipped,
    };
  }

  return Object.freeze({
    config,
    bootstrap,
    refreshDue,
    isEnabledForGuild: config.isEnabledForGuild,
  });
}

export function analyticsCurrentProjectionKey(guildId) {
  return `v2:guild:${String(guildId)}:current`;
}
