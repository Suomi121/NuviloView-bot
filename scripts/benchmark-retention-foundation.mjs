import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createLocalStorage } from "../lib/storage/index.mjs";
import { analyticsProjectionKey } from "../lib/storage/repositories/analytics-projections.mjs";
import { retentionFoundationInternals } from "../lib/storage/repositories/retention-foundation.mjs";

function eventCount(args) {
  const raw = args.find((arg) => arg.startsWith("--events="))?.split("=")[1] ?? "100000";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new TypeError("--events must be between 1 and 1000000.");
  }
  return value;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const count = eventCount(process.argv.slice(2));
const directory = mkdtempSync(join(tmpdir(), "nuviloview-retention-stress-"));
const databasePath = join(directory, "stress.sqlite");
const guildId = "100000000000000001";
const channelId = "200000000000000001";
const userCount = 1_000;
const baseAt = Date.parse("2026-01-01T00:00:00.000Z");
const cutoffAt = baseAt + count + 1;
let busyErrors = 0;

try {
  let storage = createLocalStorage({ databasePath, now: () => cutoffAt + 86_400_000 });
  storage.close();
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; BEGIN IMMEDIATE");
  const insert = db.prepare(
    `INSERT INTO message_event_log (
       event_id, guild_id, channel_id, message_id, author_id, event_type,
       revision, source_sequence, event_rank, content, content_checksum,
       payload_json, occurred_at, created_at, source, import_job_id
     ) VALUES (?, ?, ?, ?, ?, 'create', ?, ?, 0, NULL, NULL, '{}', ?, ?, 'live', NULL)`,
  );
  const insertStartedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const occurredAt = baseAt + index;
    const eventId = `stress-message-${index}`;
    insert.run(
      eventId,
      guildId,
      channelId,
      `message-${index}`,
      `user-${index % userCount}`,
      `create:${occurredAt}`,
      occurredAt,
      occurredAt,
      occurredAt,
    );
  }
  db.exec("COMMIT");
  const insertMs = performance.now() - insertStartedAt;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rawBytes = statSync(databasePath).size;
  db.close();

  storage = createLocalStorage({ databasePath, now: () => cutoffAt + 86_400_000 });
  const baselineStartedAt = performance.now();
  const baseline = storage.retentionFoundation.buildCurrentBaseline(guildId, cutoffAt);
  const baselineBuildMs = performance.now() - baselineStartedAt;
  storage.close();

  const write = new DatabaseSync(databasePath);
  const projectionKey = analyticsProjectionKey({ kind: "guild_current", guildId });
  const baselineMaterial = Object.fromEntries(
    Object.entries(baseline).filter(([key]) => key !== "checksum"),
  );
  const at = cutoffAt + 86_400_000;
  write.prepare(
    `INSERT INTO analytics_retention_foundation (
       projection_key, projection_kind, guild_id, state, finalized_through_at,
       source_sequence, snapshot_version, snapshot_checksum,
       baseline_material_json, baseline_checksum, late_event_grace_until,
       reconciled_at, created_at, updated_at
     ) VALUES (?, 'guild_current', ?, 'shadow', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectionKey,
    guildId,
    cutoffAt,
    cutoffAt - 1,
    retentionFoundationInternals.sha256({ stress: true }),
    JSON.stringify(baselineMaterial),
    baseline.checksum,
    cutoffAt,
    at,
    at,
    at,
  );
  write.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rawPlusFoundationBytes = statSync(databasePath).size;
  write.close();

  storage = createLocalStorage({ databasePath, now: () => at });
  const lookupLatencies = [];
  for (let index = 0; index < 10_000; index += 1) {
    const result = storage.retentionFoundation.classifyEvent({
      eventId: `recent-${index}`,
      domain: "message",
      guildId,
      partitionKey: `${guildId}:message-${index}`,
      occurredAt: cutoffAt + index,
      sourceSequence: index,
    });
    lookupLatencies.push(result.dedupeLookupLatencyMs);
  }

  const reader = new DatabaseSync(databasePath, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) count FROM message_event_log").get();
  try {
    const late = storage.retentionFoundation.queueLateEvent({
      eventId: "stress-late-event",
      domain: "message",
      guildId,
      partitionKey: `${guildId}:late`,
      eventType: "update",
      occurredAt: cutoffAt - 1,
      sourceSequence: cutoffAt - 1,
      payload: { source: "stress" },
    });
    if (!late.queued) throw new Error("Late-event insert did not complete.");
  } catch (error) {
    if (String(error?.code ?? "").includes("BUSY")) busyErrors += 1;
    else throw error;
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  const quickCheck = storage.health.checkIntegrity({ quick: true });
  const journalMode = storage.health.getStatus().journalMode;
  storage.health.checkpoint("TRUNCATE");
  const size = storage.health.getStorageSize();
  storage.close();

  const retained = new DatabaseSync(databasePath);
  retained.exec("DELETE FROM message_event_log; VACUUM");
  const retainedQuickCheck = retained.prepare("PRAGMA quick_check").get().quick_check;
  retained.close();
  const retainedFoundationBytes = statSync(databasePath).size;

  const result = {
    events: count,
    rawInsertMs: Math.round(insertMs * 100) / 100,
    rawInsertEventsPerSecond: Math.round((count / insertMs) * 1_000),
    baselineBuildMs: Math.round(baselineBuildMs * 100) / 100,
    baselineBytes: Buffer.byteLength(JSON.stringify(baselineMaterial)),
    rawBytes,
    rawPlusFoundationBytes,
    foundationGrowthBytes: rawPlusFoundationBytes - rawBytes,
    foundationToRawRatio: Math.round(((rawPlusFoundationBytes - rawBytes) / rawBytes) * 1_000_000) / 1_000_000,
    retainedFoundationBytes,
    retainedToRawRatio: Math.round((retainedFoundationBytes / rawBytes) * 1_000_000) / 1_000_000,
    dedupeLookupP50Ms: Math.round(percentile(lookupLatencies, 0.5) * 1_000) / 1_000,
    dedupeLookupP95Ms: Math.round(percentile(lookupLatencies, 0.95) * 1_000) / 1_000,
    dedupeLookupP99Ms: Math.round(percentile(lookupLatencies, 0.99) * 1_000) / 1_000,
    busyErrors,
    journalMode,
    quickCheck: quickCheck.ok,
    retainedQuickCheck,
    databaseBytes: size.databaseBytes,
    walBytes: size.walBytes,
    sharedMemoryBytes: size.sharedMemoryBytes,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
