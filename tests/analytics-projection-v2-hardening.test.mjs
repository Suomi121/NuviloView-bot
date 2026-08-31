import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backfillAnalyticsProjectionV2 } from "../scripts/backfill-analytics-projection-v2.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";
import {
  createAnalyticsCompactionService,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";
import { analyticsProjectionKey } from "../lib/storage/repositories/analytics-projections.mjs";

const guildA = "100000000000000001";
const guildB = "100000000000000002";
const channelId = "200000000000000001";
const userId = "300000000000000001";

const baseEnv = Object.freeze({
  LOCAL_STORAGE_ENABLED: "true",
  LOCAL_STORAGE_WRITE_ENABLED: "true",
  LOCAL_FIRST_ALL_GUILDS_ENABLED: "true",
  ANALYTICS_COMPACTION_ENABLED: "true",
  ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "900",
  ANALYTICS_PROJECTION_BATCH_SIZE: "250",
  ANALYTICS_PROJECTION_MAX_RUNTIME_MS: "5000",
  MULTI_DB_SYNC_ENABLED: "true",
  SYNC_WORKER_ENABLED: "true",
  SYNC_SNAPSHOT_ENABLED: "true",
});

function recordMessage(storage, {
  guildId = guildA,
  messageId,
  eventType,
  occurredAt,
  referenceMessageId = null,
  mark = true,
}) {
  const result = storage.messageDomain.recordEvent({
    eventId: `message-${eventType}:${guildId}:${messageId}:${occurredAt}`,
    guildId,
    channelId,
    messageId,
    authorId: userId,
    eventType,
    revision: `${eventType}:${occurredAt}`,
    sourceSequence: occurredAt,
    content: eventType === "delete" ? null : `${eventType} content`,
    occurredAt,
    payload: {
      guildId,
      channelId,
      messageId,
      authorId: userId,
      eventType,
      occurredAt,
      reference: referenceMessageId
        ? { messageId: referenceMessageId, channelId, guildId, type: 0 }
        : null,
    },
  });
  if (mark && result.inserted) storage.analyticsProjections.markMessageEvent(result.event);
  return result;
}

test("Projection v2 contract uses a fixed boundary and includes message lifecycle metrics", () => {
  const at = Date.parse("2026-08-31T13:16:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  recordMessage(storage, {
    messageId: "400000000000000001",
    eventType: "create",
    occurredAt: at,
    referenceMessageId: "400000000000000000",
  });
  recordMessage(storage, {
    messageId: "400000000000000001",
    eventType: "update",
    occurredAt: at + 1,
  });
  recordMessage(storage, {
    messageId: "400000000000000001",
    eventType: "delete",
    occurredAt: at + 2,
  });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig({
      ...baseEnv,
      ANALYTICS_PROJECTION_V2_MODE: "active",
    }),
    now: () => at + 3,
    logger: { info() {} },
  });
  assert.equal(service.refreshDue({ at: at + 3 }).changed, 4);
  const daily = storage.snapshots.get("analytics", analyticsProjectionKey({
    kind: "guild_daily",
    guildId: guildA,
    dateUtc: "2026-08-31",
  }));
  assert.equal(daily.payload.schemaVersion, 4);
  assert.equal(daily.payload.projectionVersion, 2);
  assert.equal(daily.payload.bucketKind, "daily");
  assert.equal(daily.payload.bucketStart, Date.parse("2026-08-31T00:00:00.000Z"));
  assert.equal(daily.payload.bucketEnd, Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(daily.payload.nextUpdateAt, Date.parse("2026-08-31T13:30:00.000Z"));
  assert.deepEqual(daily.payload.messageActivity, {
    creates: 1,
    edits: 1,
    deletes: 1,
    replies: 1,
  });
  assert.equal(daily.payload.rawContentIncluded, false);
  assert.equal(JSON.stringify(daily.payload).includes("create content"), false);
  const firstVersion = daily.snapshotVersion;
  storage.analyticsProjections.markDirty({
    projectionKind: "guild_daily",
    guildId: guildA,
    dateUtc: "2026-08-31",
    sourceSequence: at + 2,
    lastEventAt: at + 2,
  }, { at: at + 900_001 });
  assert.equal(service.refreshDue({ at: at + 900_001 }).skipped, 1);
  assert.equal(storage.snapshots.get("analytics", daily.aggregateId).snapshotVersion, firstVersion);
  storage.close();
});

test("Shadow mode compares the v2 contract without changing the Cloud-facing payload", () => {
  const at = Date.parse("2026-08-31T14:01:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  recordMessage(storage, { messageId: "400000000000000010", eventType: "create", occurredAt: at });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig({
      ...baseEnv,
      ANALYTICS_PROJECTION_V2_MODE: "shadow",
    }),
    now: () => at,
    logger: { info() {} },
  });
  const result = service.refreshDue({ at });
  assert.equal(result.shadowCompared, 4);
  assert.equal(result.shadowMismatched, 0);
  const current = storage.snapshots.get("analytics", `v2:guild:${guildA}:current`);
  assert.equal(current.payload.schemaVersion, 3);
  assert.equal(current.payload.projectionVersion, undefined);
  assert.equal(service.getMetrics().shadowMismatched, 0);
  storage.close();
});

test("Canary mode emits v2 only for the selected Guild", () => {
  const at = Date.parse("2026-08-31T14:16:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  recordMessage(storage, { guildId: guildA, messageId: "400000000000000020", eventType: "create", occurredAt: at });
  recordMessage(storage, { guildId: guildB, messageId: "400000000000000021", eventType: "create", occurredAt: at });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig({
      ...baseEnv,
      ANALYTICS_PROJECTION_V2_MODE: "canary",
      ANALYTICS_PROJECTION_V2_CANARY_GUILDS: guildA,
    }),
    now: () => at,
    logger: { info() {} },
  });
  service.refreshDue({ at });
  assert.equal(storage.snapshots.get("analytics", `v2:guild:${guildA}:current`).payload.schemaVersion, 4);
  assert.equal(storage.snapshots.get("analytics", `v2:guild:${guildB}:current`).payload.schemaVersion, 3);
  storage.close();
});

test("A late or replayed Event re-dirties only its affected UTC bucket", () => {
  const currentAt = Date.parse("2026-08-31T16:01:00.000Z");
  const lateAt = Date.parse("2026-08-29T23:59:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => currentAt });
  recordMessage(storage, {
    messageId: "400000000000000025",
    eventType: "create",
    occurredAt: currentAt,
  });
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig({
      ...baseEnv,
      ANALYTICS_PROJECTION_V2_MODE: "active",
    }),
    now: () => currentAt,
    logger: { info() {} },
  });
  service.refreshDue({ at: currentAt });
  const firstLate = recordMessage(storage, {
    messageId: "400000000000000026",
    eventType: "create",
    occurredAt: lateAt,
  });
  const duplicateLate = recordMessage(storage, {
    messageId: "400000000000000026",
    eventType: "create",
    occurredAt: lateAt,
  });
  assert.equal(firstLate.inserted, true);
  assert.equal(duplicateLate.inserted, false);
  const due = storage.analyticsProjections.listDue({ at: currentAt + 900_000 });
  assert.equal(due.some((item) => item.dateUtc === "2026-08-29"), true);
  assert.equal(due.some((item) => item.dateUtc === "2026-08-31"), false);
  service.refreshDue({ at: currentAt + 900_000 });
  const lateDaily = storage.snapshots.get("analytics", analyticsProjectionKey({
    kind: "guild_daily",
    guildId: guildA,
    dateUtc: "2026-08-29",
  }));
  assert.equal(lateDaily.payload.messageCount, 1);
  storage.close();
});

test("Compaction yields at its runtime budget and leaves unprocessed buckets dirty", () => {
  const at = Date.parse("2026-08-31T15:01:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  recordMessage(storage, { messageId: "400000000000000030", eventType: "create", occurredAt: at });
  let monotonic = 0;
  const service = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig({
      ...baseEnv,
      ANALYTICS_PROJECTION_MAX_RUNTIME_MS: "50",
      ANALYTICS_PROJECTION_V2_MODE: "active",
    }),
    now: () => at,
    monotonicNow: () => {
      const value = monotonic;
      monotonic += 30;
      return value;
    },
    logger: { info() {} },
  });
  const result = service.refreshDue({ at });
  assert.equal(result.timeBudgetExceeded, true);
  assert.equal(result.built, 2);
  assert.equal(storage.analyticsProjections.getMetrics().bucketsDirty, 2);
  storage.close();
});

test("Projection generation failure preserves Raw Events and dirty checkpoints", () => {
  const at = Date.parse("2026-08-31T15:16:00.000Z");
  const storage = createLocalStorage({ databasePath: ":memory:", now: () => at });
  recordMessage(storage, {
    messageId: "400000000000000035",
    eventType: "create",
    occurredAt: at,
  });
  const failingStorage = {
    ...storage,
    analyticsProjections: {
      ...storage.analyticsProjections,
      buildMaterial() {
        throw new Error("isolated projection failure");
      },
    },
  };
  const config = getAnalyticsCompactionConfig({
    ...baseEnv,
    ANALYTICS_PROJECTION_V2_MODE: "active",
  });
  const failing = createAnalyticsCompactionService(failingStorage, {
    config,
    now: () => at,
    logger: { info() {} },
  });
  assert.throws(() => failing.refreshDue({ at }), /isolated projection failure/);
  assert.equal(storage.analyticsProjections.countRawMessages(guildA), 1);
  assert.equal(storage.analyticsProjections.getMetrics().bucketsDirty, 4);
  const recovered = createAnalyticsCompactionService(storage, {
    config,
    now: () => at,
    logger: { info() {} },
  });
  assert.equal(recovered.refreshDue({ at }).changed, 4);
  storage.close();
});

test("Projection backfill defaults to dry-run and requires explicit confirmation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-projection-v2-backfill-"));
  const databasePath = join(directory, "local.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const at = Date.parse("2026-08-30T01:00:00.000Z");
  let storage = createLocalStorage({ databasePath, now: () => at });
  recordMessage(storage, {
    messageId: "400000000000000040",
    eventType: "create",
    occurredAt: at,
    mark: false,
  });
  storage.close();
  const env = {
    LOCAL_STORAGE_ENABLED: "true",
    LOCAL_STORAGE_WRITE_ENABLED: "true",
    LOCAL_STORAGE_PATH: databasePath,
  };
  const baseArgs = [
    `--guild=${guildA}`,
    "--from=2026-08-30",
    "--to=2026-08-30",
    "--max-buckets=10",
  ];
  const plan = await backfillAnalyticsProjectionV2({ argv: baseArgs, env });
  assert.equal(plan.mode, "dry_run");
  assert.equal(plan.candidateBuckets, 4);
  assert.equal(plan.marked, 0);
  await assert.rejects(
    backfillAnalyticsProjectionV2({ argv: [...baseArgs, "--execute"], env }),
    /PROJECTION_V2_BACKFILL/,
  );
  const executed = await backfillAnalyticsProjectionV2({
    argv: [...baseArgs, "--execute", "--confirm=PROJECTION_V2_BACKFILL", "--rate-ms=0"],
    env,
  });
  assert.equal(executed.marked, 4);
  storage = createLocalStorage({ databasePath, now: () => at });
  assert.equal(storage.analyticsProjections.listDue({ at: Date.now() }).length, 4);
  storage.close();
});
