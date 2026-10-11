import { resolve } from "node:path";
import { createOutboxRepository } from "../sync/outbox.mjs";
import { getProviderPolicyDefinitions } from "../sync/providers/contract.mjs";
import {
  assertStorageContract,
  StorageDisabledError,
} from "./contracts.mjs";
import { createAnalyticsEventRepository } from "./repositories/analytics-events.mjs";
import { createAnalyticsProjectionRepository } from "./repositories/analytics-projections.mjs";
import { createGuildConfigRepository } from "./repositories/guild-config.mjs";
import { createHistoryImportRepository } from "./repositories/history-import.mjs";
import { createMessageRepository } from "./repositories/messages.mjs";
import { createMessageDomainRepository } from "./repositories/message-domain.mjs";
import { createModerationRepository } from "./repositories/moderation.mjs";
import { createProviderDeliveryRepository } from "./repositories/provider-delivery.mjs";
import { createRetentionFoundationRepository } from "./repositories/retention-foundation.mjs";
import { createSecurityRepository } from "./repositories/security.mjs";
import { createSyncSnapshotRepository } from "./repositories/sync-snapshots.mjs";
import { createSyncMetadataRepository } from "./repositories/sync-metadata.mjs";
import { SqliteStore } from "./sqlite-store.mjs";

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

export function getLocalStorageConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const enabled = isEnabled(env.LOCAL_STORAGE_ENABLED);
  return Object.freeze({
    enabled,
    writeEnabled: enabled && isEnabled(env.LOCAL_STORAGE_WRITE_ENABLED),
    databasePath: resolve(
      cwd,
      env.LOCAL_STORAGE_PATH?.trim() || "data/nuviloview.sqlite",
    ),
    busyTimeoutMs: 5_000,
  });
}

function disabledMethod() {
  throw new StorageDisabledError();
}

function createDisabledStorage(config) {
  const disabledRepository = Object.freeze({
    upsert: disabledMethod,
    markDeleted: disabledMethod,
    getByIdentity: disabledMethod,
    recordMessageEvent: disabledMethod,
    recordReactionEvent: disabledMethod,
    recordReactionTransition: disabledMethod,
    getReactionState: disabledMethod,
    recordVoiceEvent: disabledMethod,
    recordVoiceTransition: disabledMethod,
    reconcileVoiceSessions: disabledMethod,
    getOpenVoiceSession: disabledMethod,
    listOpenVoiceSessions: () => [],
    recordMemberEvent: disabledMethod,
    recordMemberTransition: disabledMethod,
    recordMemberBaseline: disabledMethod,
    getMemberState: disabledMethod,
    getGuildMemberCount: () => null,
    getRawEventCounts: () => ({ reactions: 0, voice: 0, members: 0 }),
    appendAudit: disabledMethod,
    getByEventId: disabledMethod,
    recordAction: disabledMethod,
    getLastKnownGuildPolicy: disabledMethod,
    setLastKnownGuildPolicy: disabledMethod,
    get: disabledMethod,
    set: disabledMethod,
    enqueue: disabledMethod,
    enqueueMany: disabledMethod,
    claimBatch: disabledMethod,
    markSynced: disabledMethod,
    markRetry: disabledMethod,
    moveToDeadLetter: disabledMethod,
    releaseExpiredLocks: disabledMethod,
    releaseWorkerLocks: disabledMethod,
    getPendingCount: disabledMethod,
    getRetryCount: disabledMethod,
    getProcessingCount: disabledMethod,
    getDeadLetterCount: disabledMethod,
    getOldestPendingAge: disabledMethod,
    getQueueSize: disabledMethod,
    getStatusCounts: disabledMethod,
    getDeadLetter: disabledMethod,
    listDeadLetters: disabledMethod,
    requeueDeadLetter: disabledMethod,
    purgeSynced: disabledMethod,
    getMessagePendingCount: () => 0,
    getMessageOldestPendingAge: () => null,
    getMessageDeadLetterCount: () => 0,
    getMessageSyncStatus: () => ({
      lastSyncedMessageAt: null,
      lastLocalMessageAt: null,
      oldestPendingAgeMs: null,
      pendingCount: 0,
    }),
    recordEvent: disabledMethod,
    recordActiveMemberObservation: disabledMethod,
    getCurrent: disabledMethod,
    getLastActivityAt: disabledMethod,
    getDerivedStats: disabledMethod,
    getComparisonSnapshot: disabledMethod,
    recordWriteFailure: disabledMethod,
    recordSyncResult: disabledMethod,
    getMetrics: () => ({
      messageLocalWritesTotal: 0,
      messageLocalWriteFailures: 0,
      messageOutboxPending: 0,
      messageSyncSuccessTotal: 0,
      messageSyncFailureTotal: 0,
      messageLastLocalWrite: null,
      messageLastSync: null,
      messageSyncLag: null,
      messageOldestPendingAge: null,
    }),
    getRoutingMode: () => null,
    markDirty: disabledMethod,
    markMessageEvent: disabledMethod,
    markActiveMemberObservation: disabledMethod,
    markReactionEvent: disabledMethod,
    markVoiceEvent: disabledMethod,
    markMemberEvent: disabledMethod,
    markExistingDataDirty: disabledMethod,
    getDirty: disabledMethod,
    listDue: () => [],
    markAggregated: disabledMethod,
    buildMaterial: disabledMethod,
    recordBuild: disabledMethod,
    recordProviderWrites: disabledMethod,
    countRawMessages: () => 0,
    countRawEvents: () => ({ messages: 0, reactions: 0, voice: 0, members: 0 }),
    ensureForEvent: disabledMethod,
    applyPolicy: disabledMethod,
    listForEvent: disabledMethod,
    getProviderStatus: () => ({
      enabled: false,
      healthStatus: "DISABLED",
      pending: 0,
      retry: 0,
      processing: 0,
      deadLetter: 0,
    }),
    getAllProviderStatus: () => [],
    getCloudCompletionSummary: () => ({ total: 0, complete: 0 }),
    planBackfill: disabledMethod,
    executeBackfill: disabledMethod,
    createWorkerId: disabledMethod,
    recordAttempt: disabledMethod,
    recordResult: disabledMethod,
    setCircuitState: disabledMethod,
    isCloudComplete: () => false,
    updateCloudCompletion: disabledMethod,
    listGuildIds: () => [],
    getGuildMaterial: disabledMethod,
    getStatusCounts: () => ({}),
    listForReconciliation: disabledMethod,
    ensureJob: disabledMethod,
    prepareJob: disabledMethod,
    ensureChannel: disabledMethod,
    setJobState: disabledMethod,
    setChannelState: disabledMethod,
    saveBatch: disabledMethod,
    getJob: disabledMethod,
    getChannel: disabledMethod,
    getChannelByProgressId: disabledMethod,
    getBatch: disabledMethod,
    deleteImportedHistory: disabledMethod,
    getImportedCount: () => 0,
    buildCurrentBaseline: disabledMethod,
    composeCurrentMaterial: disabledMethod,
    planProjection: disabledMethod,
    createShadow: disabledMethod,
    resolveMaterial: disabledMethod,
    compareShadow: disabledMethod,
    classifyEvent: disabledMethod,
    queueLateEvent: disabledMethod,
  });
  const storage = {
    enabled: false,
    writeEnabled: false,
    settings: config,
    messages: disabledRepository,
    messageDomain: disabledRepository,
    analytics: disabledRepository,
    analyticsProjections: disabledRepository,
    security: disabledRepository,
    moderation: disabledRepository,
    configRepository: disabledRepository,
    config: disabledRepository,
    syncMetadata: disabledRepository,
    outbox: disabledRepository,
    providerDeliveries: disabledRepository,
    snapshots: disabledRepository,
    historyImport: disabledRepository,
    retentionFoundation: disabledRepository,
    health: Object.freeze({
      getStatus: () => ({
        enabled: false,
        writeEnabled: false,
        open: false,
        databasePath: config.databasePath,
      }),
      checkIntegrity: disabledMethod,
      checkpoint: disabledMethod,
      getStorageSize: () => ({
        totalBytes: 0,
        databaseBytes: 0,
        walBytes: 0,
        sharedMemoryBytes: 0,
      }),
      getDatabasePath: () => config.databasePath,
    }),
    transaction: disabledMethod,
    close: () => false,
  };
  return assertStorageContract(Object.freeze(storage));
}

export function createLocalStorage({
  databasePath,
  writeEnabled = true,
  readOnly = false,
  busyTimeoutMs = 5_000,
  now = () => Date.now(),
  providerDefinitions = [],
} = {}) {
  const store = new SqliteStore({
    databasePath,
    writeEnabled,
    readOnly,
    busyTimeoutMs,
    now,
  });
  const messages = createMessageRepository(store, { now });
  const analytics = createAnalyticsEventRepository(store, messages, { now });
  const analyticsProjections = createAnalyticsProjectionRepository(store, { now });
  const security = createSecurityRepository(store, { now });
  const config = createGuildConfigRepository(store, { now });
  const syncMetadata = createSyncMetadataRepository(store, { now });
  const providerDeliveries = createProviderDeliveryRepository(store, { now });
  const outbox = createOutboxRepository(store, {
    now,
    providerDefinitions,
    providerDeliveries,
  });
  const messageDomain = createMessageDomainRepository(store, outbox, { now });
  const historyImport = createHistoryImportRepository(
    store,
    messageDomain,
    analyticsProjections,
    { now },
  );
  const snapshots = createSyncSnapshotRepository(store, {
    providerDefinitions,
    now,
  });
  const retentionFoundation = createRetentionFoundationRepository(store, {
    analyticsProjections,
    snapshots,
    now,
  });
  if (providerDefinitions.length > 0 && store.writeEnabled && !store.readOnly) {
    providerDeliveries.applyPolicy(providerDefinitions);
    snapshots.applyPolicy(providerDefinitions);
  }

  const storage = {
    enabled: true,
    writeEnabled: store.writeEnabled,
    messages,
    messageDomain,
    historyImport,
    analytics,
    analyticsProjections,
    security,
    moderation: createModerationRepository(security),
    config,
    syncMetadata,
    outbox,
    providerDeliveries,
    snapshots,
    retentionFoundation,
    health: Object.freeze({
      getStatus: () => ({
        ...store.getStatus(),
        messageDomain: messageDomain.getMetrics(),
      }),
      checkIntegrity: (options) => store.checkIntegrity(options),
      checkpoint: (mode) => store.checkpoint(mode),
      getStorageSize: () => store.getStorageSize(),
      getDatabasePath: () => store.databasePath,
    }),
    transaction: (callback) => store.transaction(callback),
    close: () => store.close(),
  };
  return assertStorageContract(Object.freeze(storage));
}

export function createStorage({
  env = process.env,
  cwd = process.cwd(),
  now = () => Date.now(),
} = {}) {
  const config = getLocalStorageConfig(env, { cwd });
  if (!config.enabled) return createDisabledStorage(config);
  return createLocalStorage({
    databasePath: config.databasePath,
    writeEnabled: config.writeEnabled,
    busyTimeoutMs: config.busyTimeoutMs,
    now,
    providerDefinitions: getProviderPolicyDefinitions(env),
  });
}

export {
  assertStorageContract,
  createStableEventId,
  StorageClosedError,
  StorageDisabledError,
  StorageReadOnlyError,
} from "./contracts.mjs";
