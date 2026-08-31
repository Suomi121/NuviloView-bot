import { getNextAnalyticsRefreshBoundary } from "../analytics-refresh.mjs";

const DEFAULT_INTERVAL_SECONDS = 900;
const MINIMUM_INTERVAL_SECONDS = 60;
const PROJECTION_V2_MODES = new Set(["legacy", "shadow", "canary", "active"]);
const PROJECTION_V2_METRICS_STREAM = "analytics_projection_v2_metrics";

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

function integer(value, fallback, { min, max }) {
  const normalized = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    return fallback;
  }
  return normalized;
}

function projectionMode(value) {
  const normalized = String(value ?? "legacy").trim().toLowerCase();
  return PROJECTION_V2_MODES.has(normalized) ? normalized : "legacy";
}

export function getAnalyticsCompactionConfig(env = process.env) {
  const rawInterval = Number(
    env.ANALYTICS_SNAPSHOT_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS,
  );
  const intervalSeconds = Number.isSafeInteger(rawInterval)
    ? Math.min(86_400, Math.max(MINIMUM_INTERVAL_SECONDS, rawInterval))
    : DEFAULT_INTERVAL_SECONDS;
  const configuredGuildIds = guildIds(env.ANALYTICS_COMPACTION_GUILD_IDS);
  const v2CanaryGuildIds = guildIds(env.ANALYTICS_PROJECTION_V2_CANARY_GUILDS);
  const v2Mode = projectionMode(env.ANALYTICS_PROJECTION_V2_MODE);
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
  if (enabled && v2Mode === "canary" && v2CanaryGuildIds.length === 0) {
    errors.push("analytics_projection_v2_canary_guild_list_empty");
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
    maxRuntimeMs: integer(env.ANALYTICS_PROJECTION_MAX_RUNTIME_MS, 5_000, {
      min: 50,
      max: 60_000,
    }),
    v2Mode,
    v2CanaryGuildIds,
    usesV2Contract: (guildId) =>
      v2Mode === "active"
      || (v2Mode === "canary" && v2CanaryGuildIds.includes(String(guildId ?? ""))),
    prerequisites,
    errors: Object.freeze(errors),
    isEnabledForGuild: (guildId) =>
      enabled &&
      (allGuildsEnabled || configuredGuildIds.includes(String(guildId ?? ""))),
  });
}

function projectionBucket(item) {
  if (!item.dateUtc) {
    return { bucketKind: "current", bucketStart: null, bucketEnd: null };
  }
  const bucketStart = Date.parse(`${item.dateUtc}T00:00:00.000Z`);
  return {
    bucketKind: "daily",
    bucketStart,
    bucketEnd: bucketStart + 86_400_000,
  };
}

function projectionPayload(
  item,
  material,
  { generatedAt, intervalMs, contractV2 = false },
) {
  const payload = {
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
    nextUpdateAt: getNextAnalyticsRefreshBoundary(generatedAt, intervalMs),
    rawContentIncluded: false,
  };
  if (!contractV2) return payload;
  return {
    ...payload,
    schemaVersion: 4,
    projectionVersion: 2,
    ...projectionBucket(item),
    sourceCheckpoint: item.sourceSequence,
    sourceUpdatedAt: item.lastEventAt ?? material.lastActivityAt ?? null,
    generatedAt,
    messageActivity: {
      creates: material.messageCreates,
      edits: material.messageEdits,
      deletes: material.messageDeletes,
      replies: material.messageReplies,
    },
  };
}

function semanticPayload(payload) {
  const {
    lastRuntimeSeenAt: _lastRuntimeSeenAt,
    lastUpdatedAt: _lastUpdatedAt,
    nextUpdateAt: _nextUpdateAt,
    generatedAt: _generatedAt,
    sourceCheckpoint: _sourceCheckpoint,
    sourceUpdatedAt: _sourceUpdatedAt,
    ...semantic
  } = payload;
  return semantic;
}

function sharedProjectionMatches(legacy, candidate) {
  return Object.entries(legacy).every(
    ([key, value]) => key === "schemaVersion"
      || JSON.stringify(candidate[key]) === JSON.stringify(value),
  );
}

export function createAnalyticsCompactionService(
  storage,
  {
    config = getAnalyticsCompactionConfig(),
    now = () => Date.now(),
    monotonicNow = () => Date.now(),
    logger = console,
  } = {},
) {
  if (!storage?.analyticsProjections || !storage?.snapshots || !storage?.syncMetadata) {
    throw new TypeError("Analytics projection-capable local storage is required.");
  }
  let bootstrapped = false;

  function operationalMetrics() {
    return storage.syncMetadata.get(PROJECTION_V2_METRICS_STREAM)?.metadata ?? {};
  }

  function recordOperationalMetrics(input, at) {
    const current = operationalMetrics();
    const metadata = {
      schemaVersion: 1,
      mode: config.v2Mode,
      runs: Number(current.runs ?? 0) + 1,
      bucketsProcessed:
        Number(current.bucketsProcessed ?? 0) + Number(input.built ?? 0),
      bucketsRegenerated:
        Number(current.bucketsRegenerated ?? 0) + Number(input.changed ?? 0),
      checksumUnchanged:
        Number(current.checksumUnchanged ?? 0) + Number(input.skipped ?? 0),
      shadowCompared:
        Number(current.shadowCompared ?? 0) + Number(input.shadowCompared ?? 0),
      shadowMismatched:
        Number(current.shadowMismatched ?? 0) + Number(input.shadowMismatched ?? 0),
      lastDurationMs: Number(input.durationMs ?? 0),
      maxDurationMs: Math.max(
        Number(current.maxDurationMs ?? 0),
        Number(input.durationMs ?? 0),
      ),
      timeBudgetExceededRuns:
        Number(current.timeBudgetExceededRuns ?? 0)
        + Number(Boolean(input.timeBudgetExceeded)),
      queueDepth: storage.analyticsProjections.getMetrics().bucketsDirty,
      lastRunAt: at,
    };
    storage.syncMetadata.set({
      streamName: PROJECTION_V2_METRICS_STREAM,
      state: input.timeBudgetExceeded ? "yielded" : "complete",
      cursor: String(storage.analyticsProjections.getMetrics().sourceCheckpoint ?? ""),
      lastAttemptAt: at,
      lastSuccessAt: at,
      metadata,
    });
    return metadata;
  }

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
    const startedAt = monotonicNow();
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
    let built = 0;
    let shadowCompared = 0;
    let shadowMismatched = 0;
    let timeBudgetExceeded = false;
    for (const item of due) {
      if (built > 0 && monotonicNow() - startedAt >= config.maxRuntimeMs) {
        timeBudgetExceeded = true;
        break;
      }
      const material = storage.analyticsProjections.buildMaterial(item);
      const legacyPayload = projectionPayload(item, material, {
        generatedAt: at,
        intervalMs: config.intervalMs,
      });
      const candidatePayload = projectionPayload(item, material, {
        generatedAt: at,
        intervalMs: config.intervalMs,
        contractV2: true,
      });
      if (config.v2Mode === "shadow") {
        shadowCompared += 1;
        if (!sharedProjectionMatches(legacyPayload, candidatePayload)) {
          shadowMismatched += 1;
        }
      }
      const payload = config.usesV2Contract(item.guildId)
        ? candidatePayload
        : legacyPayload;
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
        {
          at,
          intervalMs: config.intervalMs,
          nextEligibleAt: getNextAnalyticsRefreshBoundary(at, config.intervalMs),
        },
      );
      built += 1;
      if (result.changed) changed += 1;
      else skipped += 1;
    }
    const durationMs = Math.max(0, monotonicNow() - startedAt);
    const runMetrics = built > 0 || timeBudgetExceeded
      ? recordOperationalMetrics({
          built,
          changed,
          skipped,
          shadowCompared,
          shadowMismatched,
          durationMs,
          timeBudgetExceeded,
        }, at)
      : operationalMetrics();
    if (built > 0) {
      logger.info?.(
        `[analytics-compaction] mode=${config.v2Mode} built=${built} changed=${changed} skipped=${skipped} durationMs=${durationMs}`,
      );
    }
    return {
      enabled: true,
      mode: config.v2Mode,
      guildCount: config.allGuildsEnabled ? null : config.guildIds.length,
      built,
      changed,
      skipped,
      shadowCompared,
      shadowMismatched,
      durationMs,
      timeBudgetExceeded,
      metrics: runMetrics,
    };
  }

  return Object.freeze({
    config,
    bootstrap,
    refreshDue,
    getMetrics: () => ({
      ...storage.analyticsProjections.getMetrics(),
      ...operationalMetrics(),
      mode: config.v2Mode,
    }),
    isEnabledForGuild: config.isEnabledForGuild,
  });
}

export function analyticsCurrentProjectionKey(guildId) {
  return `v2:guild:${String(guildId)}:current`;
}
