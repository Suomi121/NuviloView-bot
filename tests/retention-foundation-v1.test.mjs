import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getRetentionFoundationConfig } from "../lib/retention-foundation.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";
import { analyticsProjectionKey } from "../lib/storage/repositories/analytics-projections.mjs";
import { retentionFoundationInternals } from "../lib/storage/repositories/retention-foundation.mjs";
import {
  createAnalyticsCompactionService,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";

const guildId = "100000000000000001";
const channelId = "200000000000000001";
const messageUserId = "300000000000000001";
const reactionUserId = "300000000000000002";
const voiceUserId = "300000000000000003";
const memberUserId = "300000000000000004";
const providerDefinitions = Object.freeze([
  Object.freeze({ id: "supabase", required: true, enabled: true }),
  Object.freeze({ id: "turso", required: true, enabled: true }),
]);
const env = Object.freeze({
  LOCAL_STORAGE_ENABLED: "true",
  LOCAL_STORAGE_WRITE_ENABLED: "true",
  LOCAL_FIRST_ALL_GUILDS_ENABLED: "true",
  MULTI_DB_SYNC_ENABLED: "true",
  SYNC_WORKER_ENABLED: "true",
  SYNC_SNAPSHOT_ENABLED: "true",
  ANALYTICS_COMPACTION_ENABLED: "true",
  ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "900",
  ANALYTICS_PROJECTION_V2_MODE: "active",
});

function createHarness(t) {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-retention-foundation-"));
  const databasePath = join(directory, "isolated.sqlite");
  let currentAt = Date.parse("2026-08-31T12:00:00.000Z");
  const now = () => currentAt;
  let storage = createLocalStorage({ databasePath, providerDefinitions, now });
  const service = () => createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(env),
    now,
    logger: { info() {} },
  });
  t.after(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    databasePath,
    now,
    get at() { return currentAt; },
    set at(value) { currentAt = value; },
    get storage() { return storage; },
    service,
    reopen() {
      storage.close();
      storage = createLocalStorage({ databasePath, providerDefinitions, now });
      return storage;
    },
  };
}

function recordMessage(storage, { id, occurredAt, type = "create", content = "test" }) {
  const result = storage.messageDomain.recordEvent({
    eventId: `message-${type}:${guildId}:${id}:${occurredAt}`,
    guildId,
    channelId,
    messageId: id,
    authorId: messageUserId,
    eventType: type,
    revision: `${type}:${occurredAt}`,
    sourceSequence: occurredAt,
    content: type === "delete" ? null : content,
    occurredAt,
    actorName: "Retention Test",
    channelName: "retention-test",
    payload: type === "create"
      ? { reference: id.endsWith("2") ? { messageId: "parent" } : null }
      : {},
  });
  if (result.inserted) storage.analyticsProjections.markMessageEvent(result.event);
  return result;
}

function recordReaction(storage, { occurredAt, action, suffix = "1" }) {
  const result = storage.analytics.recordReactionTransition({
    eventId: `reaction-${action}:${guildId}:${suffix}:${occurredAt}`,
    guildId,
    channelId,
    messageId: `message-${suffix}`,
    userId: reactionUserId,
    emojiKey: "unicode:👍",
    action,
    occurredAt,
    sourceSequence: occurredAt,
  });
  if (result.inserted) storage.analyticsProjections.markReactionEvent(result.event);
  return result;
}

function recordVoice(storage, { occurredAt, previousChannelId, nextChannelId, type }) {
  const result = storage.analytics.recordVoiceTransition({
    eventId: `voice-${type}:${guildId}:${occurredAt}`,
    guildId,
    userId: voiceUserId,
    previousChannelId,
    channelId: nextChannelId,
    eventType: type,
    occurredAt,
    sourceSequence: occurredAt,
  });
  for (const event of result.events ?? []) {
    storage.analyticsProjections.markVoiceEvent({
      ...event,
      affectedChannelIds: result.affectedChannelIds,
    });
  }
  return result;
}

function recordMember(storage, { occurredAt, type, memberCount }) {
  const result = storage.analytics.recordMemberTransition({
    eventId: `member-${type}:${guildId}:${occurredAt}`,
    guildId,
    userId: memberUserId,
    eventType: type,
    occurredAt,
    sourceSequence: occurredAt,
    memberCount,
    roleIds: ["role-1"],
    roleHash: "role-hash",
  });
  if (result.inserted) storage.analyticsProjections.markMemberEvent(result.event);
  return result;
}

function seedOldDomainData(h) {
  const oldAt = Date.parse("2026-08-30T10:00:00.000Z");
  recordMessage(h.storage, { id: "message-1", occurredAt: oldAt });
  recordMessage(h.storage, { id: "message-2", occurredAt: oldAt + 1_000 });
  recordMessage(h.storage, {
    id: "message-1",
    occurredAt: oldAt + 2_000,
    type: "update",
    content: "updated",
  });
  recordReaction(h.storage, { occurredAt: oldAt + 3_000, action: "add" });
  recordVoice(h.storage, {
    occurredAt: oldAt + 4_000,
    previousChannelId: null,
    nextChannelId: channelId,
    type: "join",
  });
  recordVoice(h.storage, {
    occurredAt: oldAt + 3_604_000,
    previousChannelId: channelId,
    nextChannelId: null,
    type: "leave",
  });
  recordMember(h.storage, { occurredAt: oldAt + 5_000, type: "join", memberCount: 76 });
  return oldAt;
}

function deliverAllSnapshots(storage, at) {
  for (const provider of providerDefinitions) {
    const workerId = `foundation-${provider.id}`;
    while (true) {
      const claimed = storage.snapshots.claimBatch({
        providerId: provider.id,
        workerId,
        limit: 250,
        lockTimeoutMs: 60_000,
        at,
      });
      if (claimed.length === 0) break;
      assert.equal(
        storage.snapshots.markSynced(provider.id, claimed, { workerId, at }),
        claimed.length,
      );
    }
  }
}

function compactAndDeliver(h) {
  const result = h.service().refreshDue({ at: h.at });
  deliverAllSnapshots(h.storage, h.at);
  return result;
}

function currentKey() {
  return analyticsProjectionKey({ kind: "guild_current", guildId });
}

function dailyKey(dateUtc = "2026-08-30") {
  return analyticsProjectionKey({ kind: "guild_daily", guildId, dateUtc });
}

function createFoundation(h, key, cutoffAt) {
  return h.storage.retentionFoundation.createShadow(
    { projectionKey: key },
    {
      cutoffAt,
      lateEventGraceUntil: cutoffAt,
      reconciledAt: h.at,
      at: h.at,
    },
  );
}

test("Retention Foundation defaults OFF and exposes no delete mode", () => {
  assert.deepEqual(getRetentionFoundationConfig({}), {
    mode: "off",
    enabled: false,
    deleteEnabled: false,
    lateEventGraceDays: 30,
    errors: [],
  });
  assert.equal(getRetentionFoundationConfig({ RETENTION_FOUNDATION_MODE: "shadow" }).enabled, true);
  const invalid = getRetentionFoundationConfig({ RETENTION_FOUNDATION_MODE: "active" });
  assert.equal(invalid.mode, "off");
  assert.equal(invalid.deleteEnabled, false);
  assert.deepEqual(invalid.errors, ["retention_foundation_mode_invalid"]);
});

test("additive migration creates only compact foundation metadata and late-event quarantine", (t) => {
  const h = createHarness(t);
  h.storage.close();
  const db = new DatabaseSync(h.databasePath, { readOnly: true });
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  assert.equal(tables.has("analytics_retention_foundation"), true);
  assert.equal(tables.has("retention_late_event_queue"), true);
  assert.equal(tables.has("retention_event_ledger"), false);
  assert.equal(tables.has("retention_entity_cursor"), false);
  assert.equal(db.prepare("SELECT MAX(version) version FROM migration_history").get().version, 8);
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.close();
  h.reopen();
});

test("baseline and baseline plus recent Raw exactly match full-Raw current Projection", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  compactAndDeliver(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  const created = createFoundation(h, currentKey(), cutoff);
  assert.equal(created.created, true);
  assert.deepEqual(created.plan.reasons, []);
  assert.equal(h.storage.retentionFoundation.compareShadow(currentKey()).matched, true);

  h.at += 1_000;
  recordMessage(h.storage, { id: "message-3", occurredAt: h.at });
  recordReaction(h.storage, { occurredAt: h.at + 1, action: "remove" });
  recordMember(h.storage, { occurredAt: h.at + 2, type: "leave", memberCount: 75 });
  recordMessage(h.storage, {
    id: "message-1",
    occurredAt: h.at + 3,
    type: "update",
    content: "post-boundary update",
  });
  recordMessage(h.storage, {
    id: "message-1",
    occurredAt: h.at + 4,
    type: "delete",
  });
  compactAndDeliver(h);
  assert.deepEqual(
    h.storage.retentionFoundation.resolveMaterial(currentKey()).material,
    h.storage.analyticsProjections.buildMaterial(
      h.storage.analyticsProjections.getDirty(currentKey()),
    ),
  );
  const comparison = h.storage.retentionFoundation.compareShadow(currentKey());
  assert.equal(comparison.compared, true);
  assert.equal(comparison.matched, true, JSON.stringify(comparison));
  const metrics = h.storage.retentionFoundation.getMetrics();
  assert.equal(metrics.shadowCompareCount, 2);
  assert.equal(metrics.shadowMismatchCount, 0);
});

test("isolated old-Raw removal simulation preserves current and finalized daily material", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  compactAndDeliver(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  const fullCurrent = h.storage.analyticsProjections.buildMaterial(
    h.storage.analyticsProjections.getDirty(currentKey()),
  );
  const fullDaily = h.storage.analyticsProjections.buildMaterial(
    h.storage.analyticsProjections.getDirty(dailyKey()),
  );
  assert.equal(createFoundation(h, currentKey(), cutoff).created, true);
  const afterLeave = createFoundation(h, dailyKey(), cutoff);
  assert.equal(afterLeave.created, true, JSON.stringify(afterLeave.plan.reasons));

  h.storage.close();
  const db = new DatabaseSync(h.databasePath);
  db.exec("BEGIN IMMEDIATE");
  for (const table of ["message_event_log", "reaction_events", "voice_events", "member_events"]) {
    db.prepare(`DELETE FROM ${table} WHERE occurred_at < ?`).run(cutoff);
  }
  db.exec("COMMIT");
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  db.close();
  h.reopen();

  assert.deepEqual(h.storage.retentionFoundation.resolveMaterial(currentKey()).material, fullCurrent);
  assert.deepEqual(h.storage.retentionFoundation.resolveMaterial(dailyKey()).material, fullDaily);
  assert.notDeepEqual(
    h.storage.analyticsProjections.buildMaterial(h.storage.analyticsProjections.getDirty(dailyKey())),
    fullDaily,
  );
});

test("late Message, Reaction, Voice, and Member events are quarantined once and never auto-applied", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  compactAndDeliver(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  createFoundation(h, currentKey(), cutoff);
  const before = h.storage.retentionFoundation.compareShadow(currentKey()).expectedChecksum;
  const domains = ["message", "reaction", "voice", "member"];
  for (const [index, domain] of domains.entries()) {
    const event = {
      eventId: `late-${domain}-${index}`,
      domain,
      guildId,
      partitionKey: `${guildId}:${domain}:${index}`,
      eventType: domain === "reaction" ? "add" : domain === "voice" ? "leave" : "update",
      occurredAt: cutoff - 10_000 - index,
      sourceSequence: cutoff - 10_000 - index,
      payload: { source: "isolated-test" },
    };
    assert.equal(h.storage.retentionFoundation.queueLateEvent(event).queued, true);
    const replay = h.storage.retentionFoundation.queueLateEvent(event);
    assert.equal(replay.queued, false);
    assert.equal(replay.classification.decision, "REJECT_DUPLICATE_LATE_EVENT");
  }
  assert.equal(h.storage.retentionFoundation.getMetrics().lateEventCount, 4);
  assert.equal(h.storage.retentionFoundation.compareShadow(currentKey()).expectedChecksum, before);
});

test("Voice session crossing the boundary blocks first, then preserves clipped duration after leave", (t) => {
  const h = createHarness(t);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  recordVoice(h.storage, {
    occurredAt: cutoff - 600_000,
    previousChannelId: null,
    nextChannelId: channelId,
    type: "join",
  });
  compactAndDeliver(h);
  const blocked = createFoundation(h, dailyKey(), cutoff);
  assert.equal(blocked.created, false);
  assert.equal(blocked.plan.reasons.includes("OPEN_VOICE_SESSION"), true);

  recordVoice(h.storage, {
    occurredAt: cutoff + 600_000,
    previousChannelId: channelId,
    nextChannelId: null,
    type: "leave",
  });
  h.at += 900_001;
  compactAndDeliver(h);
  const daily = h.storage.analyticsProjections.buildMaterial(
    h.storage.analyticsProjections.getDirty(dailyKey()),
  );
  assert.equal(daily.voiceSeconds, 600);
  const afterLeave = createFoundation(h, dailyKey(), cutoff);
  assert.equal(afterLeave.created, true, JSON.stringify(afterLeave.plan.reasons));
  assert.equal(h.storage.retentionFoundation.compareShadow(dailyKey()).matched, true);
});

test("recent events remain accepted while unsafe ordering never authorizes pre-boundary writes", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  compactAndDeliver(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  createFoundation(h, currentKey(), cutoff);
  const recent = h.storage.retentionFoundation.classifyEvent({
    eventId: "recent-message",
    domain: "message",
    guildId,
    partitionKey: `${guildId}:message-9`,
    occurredAt: cutoff,
    sourceSequence: 1,
  });
  assert.equal(recent.decision, "ACCEPT_RECENT");
  assert.equal(recent.dedupeLookupLatencyMs >= 0, true);
  const old = h.storage.retentionFoundation.classifyEvent({
    eventId: "old-message-unknown",
    domain: "message",
    guildId,
    partitionKey: `${guildId}:message-0`,
    occurredAt: cutoff - 1,
    sourceSequence: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(old.decision, "QUEUE_MANUAL_REPAIR");
});

test("finalization plan blocks dirty, grace, missing delivery, active import, open Voice, and Outbox", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  const beforeCompaction = h.storage.retentionFoundation.planProjection(currentKey(), {
    cutoffAt: cutoff,
    lateEventGraceUntil: h.at + 1,
    reconciledAt: h.at,
    at: h.at,
  });
  assert.equal(beforeCompaction.eligible, false);
  assert.equal(beforeCompaction.reasons.includes("DIRTY_PROJECTION"), true);
  assert.equal(beforeCompaction.reasons.includes("SNAPSHOT_MISSING"), true);
  assert.equal(beforeCompaction.reasons.includes("LATE_EVENT_GRACE_ACTIVE"), true);
  compactAndDeliver(h);
  const ready = h.storage.retentionFoundation.planProjection(currentKey(), {
    cutoffAt: cutoff,
    lateEventGraceUntil: cutoff,
    reconciledAt: h.at,
    at: h.at,
  });
  assert.deepEqual(ready.reasons, []);

  h.storage.historyImport.ensureJob({
    jobId: "retention-active-import",
    guildId,
    status: "running",
  });
  assert.equal(h.storage.retentionFoundation.planProjection(currentKey(), {
    cutoffAt: cutoff,
    lateEventGraceUntil: cutoff,
    reconciledAt: h.at,
    at: h.at,
  }).reasons.includes("HISTORY_IMPORT_ACTIVE"), true);
  h.storage.historyImport.ensureJob({
    jobId: "retention-active-import",
    guildId,
    status: "completed",
  });

  h.storage.outbox.enqueue({
    eventId: "retention-old-outbox",
    domain: "analytics",
    eventType: "retention-test",
    aggregateId: guildId,
    payload: { guildId, occurredAt: cutoff - 1 },
    schemaVersion: 1,
  });
  assert.equal(h.storage.retentionFoundation.planProjection(currentKey(), {
    cutoffAt: cutoff,
    lateEventGraceUntil: cutoff,
    reconciledAt: h.at,
    at: h.at,
  }).reasons.includes("OUTBOX_NOT_COMPLETE"), true);
  const claimed = h.storage.outbox.claimBatch({
    workerId: "retention-test-worker",
    limit: 10,
    lockTimeoutMs: 60_000,
    at: h.at,
  });
  h.storage.outbox.markSynced(claimed.map((item) => item.id), {
    workerId: "retention-test-worker",
    at: h.at,
  });

  const preBoundaryOpen = Date.parse("2026-08-30T23:00:00.000Z");
  recordVoice(h.storage, {
    occurredAt: preBoundaryOpen,
    previousChannelId: null,
    nextChannelId: channelId,
    type: "join",
  });
  compactAndDeliver(h);
  assert.equal(h.storage.retentionFoundation.planProjection(currentKey(), {
    cutoffAt: cutoff,
    lateEventGraceUntil: cutoff,
    reconciledAt: h.at,
    at: h.at,
  }).reasons.includes("OPEN_VOICE_SESSION"), true);
});

test("repeated shadow backfill is deterministic and does not enqueue Cloud Raw writes", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  compactAndDeliver(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  const outboxBefore = h.storage.outbox.getStatusCounts();
  const first = createFoundation(h, currentKey(), cutoff).foundation;
  const second = createFoundation(h, currentKey(), cutoff).foundation;
  assert.equal(first.baselineChecksum, second.baselineChecksum);
  assert.equal(h.storage.retentionFoundation.getMetrics().baselineCount, 1);
  assert.deepEqual(h.storage.outbox.getStatusCounts(), outboxBefore);
});

test("immutable historical baseline fails closed when its referenced snapshot changes", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  compactAndDeliver(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  createFoundation(h, dailyKey(), cutoff);
  const snapshot = h.storage.snapshots.get("analytics", dailyKey());
  h.storage.snapshots.upsert({
    snapshotType: "analytics",
    aggregateId: dailyKey(),
    payload: { ...snapshot.payload, messageCount: snapshot.payload.messageCount + 1 },
    generatedAt: h.at,
  });
  assert.deepEqual(h.storage.retentionFoundation.resolveMaterial(dailyKey()), {
    safe: false,
    reason: "BASELINE_SNAPSHOT_CHANGED",
    material: null,
  });
});

test("baseline checksum is stable and bounded", (t) => {
  const h = createHarness(t);
  seedOldDomainData(h);
  const cutoff = Date.parse("2026-08-31T00:00:00.000Z");
  const first = h.storage.retentionFoundation.buildCurrentBaseline(guildId, cutoff);
  const second = h.storage.retentionFoundation.buildCurrentBaseline(guildId, cutoff);
  assert.deepEqual(first, second);
  assert.equal(first.checksum, retentionFoundationInternals.sha256(
    Object.fromEntries(Object.entries(first).filter(([key]) => key !== "checksum")),
  ));
  assert.equal(JSON.stringify(first).length < 2_000, true);
});
