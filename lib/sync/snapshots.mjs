function sanitizeRuntimeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  return String(value).slice(0, 200);
}

function runtimeTimestamp(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function createSnapshotService(
  storage,
  { now = () => Date.now() } = {},
) {
  if (!storage?.snapshots || !storage?.providerDeliveries) {
    throw new TypeError("Snapshot-capable local storage is required.");
  }

  function writeGuildSnapshots(guildId, generatedAt = now()) {
    const material = storage.snapshots.getGuildMaterial(guildId, {
      at: generatedAt,
    });
    const guildStatus = storage.snapshots.upsert({
      snapshotType: "guild_status",
      aggregateId: guildId,
      generatedAt,
      payload: {
        schemaVersion: 1,
        guildId,
        memberCount: material.memberCount,
        messageCountToday: material.messageCountToday,
        activeMemberCount: material.activeMemberCount,
        currentMessageCount: material.currentMessageCount,
        channelCount: null,
        roleCount: null,
        lastEventAt: material.lastEventAt,
        sourceUpdatedAt: material.sourceUpdatedAt,
      },
    });
    const analytics = storage.snapshots.upsert({
      snapshotType: "analytics",
      aggregateId: guildId,
      generatedAt,
      payload: {
        schemaVersion: 1,
        guildId,
        dateUtc: material.dateUtc,
        messages: material.messageCountToday,
        activeMembers: material.activeMemberCount,
        recentActivity: material.recentActivityCount,
        healthScoreInputs: {
          messages: material.messageCountToday,
          activeMembers: material.activeMemberCount,
          memberCount: material.memberCount,
        },
        observation: "local_message_domain_only",
        lastEventAt: material.lastEventAt,
      },
    });
    return { guildStatus, analytics };
  }

  function writeRuntimeSnapshot(runtime = {}, generatedAt = now()) {
    const currentPayload =
      storage.snapshots.get("runtime", "nuviloview-bot")?.payload ?? {};
    // Bot and Sync Worker are separate processes. Each process updates only its
    // own liveness timestamp while preserving the other process' last value.
    // This prevents a healthy Worker from keeping a crashed Bot artificially
    // alive in the external monitor.
    const botHeartbeatAt = runtimeTimestamp(
      runtime.botHeartbeatAt
        ?? (hasOwn(runtime, "botStatus") ? generatedAt : currentPayload.botHeartbeatAt),
    );
    const workerHeartbeatAt = runtimeTimestamp(
      runtime.workerHeartbeatAt
        ?? (hasOwn(runtime, "workerStatus")
          ? generatedAt
          : currentPayload.workerHeartbeatAt),
    );
    const providers = storage.providerDeliveries.getAllProviderStatus();
    const cloud = storage.providerDeliveries.getCloudCompletionSummary();
    const storageStatus = storage.health.getStatus();
    return storage.snapshots.upsert({
      snapshotType: "runtime",
      aggregateId: "nuviloview-bot",
      generatedAt,
      payload: {
        schemaVersion: 1,
        runtimeMode: sanitizeRuntimeValue(
          runtime.runtimeMode ?? currentPayload.runtimeMode ?? "LOCAL_FIRST",
        ),
        botStatus: sanitizeRuntimeValue(
          runtime.botStatus ?? currentPayload.botStatus ?? "UNKNOWN",
        ),
        botHeartbeatAt,
        workerStatus: sanitizeRuntimeValue(
          runtime.workerStatus ?? currentPayload.workerStatus ?? "UNKNOWN",
        ),
        workerHeartbeatAt,
        sqliteStatus: storageStatus.integrity?.ok ? "HEALTHY" : "UNHEALTHY",
        providers: Object.fromEntries(
          providers.map((provider) => [
            provider.providerId,
            {
              status: provider.healthStatus,
              circuit: provider.circuitState,
              pending: provider.pending + provider.retry + provider.processing,
              deadLetter: provider.deadLetter,
              lastSuccessAt: provider.lastSuccessAt,
            },
          ]),
        ),
        pendingCount: providers.reduce(
          (sum, provider) => sum + provider.pending + provider.retry,
          0,
        ),
        deadLetterCount: providers.reduce(
          (sum, provider) => sum + provider.deadLetter,
          0,
        ),
        cloudComplete: cloud,
      },
    });
  }

  function writeSyncStatusSnapshot(generatedAt = now()) {
    const providers = storage.providerDeliveries.getAllProviderStatus();
    return storage.snapshots.upsert({
      snapshotType: "sync_status",
      aggregateId: "nuviloview-sync",
      generatedAt,
      payload: {
        schemaVersion: 1,
        providers: providers.map((provider) => ({
          providerId: provider.providerId,
          required: provider.required,
          enabled: provider.enabled,
          status: provider.healthStatus,
          circuit: provider.circuitState,
          pending: provider.pending,
          retry: provider.retry,
          deadLetter: provider.deadLetter,
          lastAttemptAt: provider.lastAttemptAt,
          lastSuccessAt: provider.lastSuccessAt,
          syncedTotal: provider.syncedTotal,
          failedTotal: provider.failedTotal,
          queryCount: provider.queryCount,
        })),
        cloudComplete: storage.providerDeliveries.getCloudCompletionSummary(),
      },
    });
  }

  function refreshAll(runtime = {}) {
    const generatedAt = now();
    const guilds = storage.snapshots.listGuildIds();
    const results = guilds.map((guildId) =>
      writeGuildSnapshots(guildId, generatedAt),
    );
    const runtimeSnapshot = writeRuntimeSnapshot(runtime, generatedAt);
    const syncStatusSnapshot = writeSyncStatusSnapshot(generatedAt);
    return {
      generatedAt,
      guildCount: guilds.length,
      changedCount:
        results.reduce(
          (count, result) =>
            count + Number(result.guildStatus.changed) + Number(result.analytics.changed),
          0,
        ) +
        Number(runtimeSnapshot.changed) +
        Number(syncStatusSnapshot.changed),
    };
  }

  return Object.freeze({
    writeGuildSnapshots,
    writeRuntimeSnapshot,
    writeSyncStatusSnapshot,
    refreshAll,
  });
}
