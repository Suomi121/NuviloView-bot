import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_IMPORT_STATUSES,
  IMPORTED_DATA_CONFIRMATION,
  MESSAGE_IMPORT_STATUS,
  MESSAGE_SOURCE,
  assertImportTransition,
  calculateImportProgress,
  classifyImportError,
  getMessageImportConfig,
  importRetryDelayMs,
  isImportStalled,
} from "../lib/message-history-import.mjs";

test("v2 is feature flagged off by default with bounded configuration", () => {
  assert.deepEqual(getMessageImportConfig({}), { enabled: false, maxRetries: 5, stallSeconds: 120, batchSize: 100 });
  assert.equal(getMessageImportConfig({ MESSAGE_HISTORY_IMPORT_MAX_RETRIES: "99", MESSAGE_HISTORY_IMPORT_STALL_SECONDS: "1" }).maxRetries, 8);
  assert.equal(getMessageImportConfig({ MESSAGE_HISTORY_IMPORT_MAX_RETRIES: "99", MESSAGE_HISTORY_IMPORT_STALL_SECONDS: "1" }).stallSeconds, 60);
});

test("state machine permits safe batch-boundary controls and rejects terminal replay", () => {
  assert.doesNotThrow(() => assertImportTransition("running", "pausing"));
  assert.doesNotThrow(() => assertImportTransition("pausing", "paused"));
  assert.doesNotThrow(() => assertImportTransition("paused", "queued"));
  assert.doesNotThrow(() => assertImportTransition("running", "cancelling"));
  assert.throws(() => assertImportTransition("completed", "running"), { code: "INVALID_IMPORT_TRANSITION" });
  assert.equal(ACTIVE_IMPORT_STATUSES.has(MESSAGE_IMPORT_STATUS.paused), true);
});

test("retry delay is bounded and permission failures are not retried", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 99].map(importRetryDelayMs), [1_000, 5_000, 15_000, 30_000, 60_000, 60_000]);
  assert.equal(classifyImportError({ status: 429 }).retryable, true);
  assert.equal(classifyImportError({ code: 50013 }).retryable, false);
  assert.equal(classifyImportError({ code: "ECONNRESET" }).retryable, true);
  assert.doesNotMatch(classifyImportError(new Error("token=secret-value")).summary, /secret|token=/i);
});

test("stalled detection respects worker heartbeat and intentional backoff", () => {
  const now = Date.parse("2026-08-21T12:05:00Z");
  const stale = { status: "running", startedAt: "2026-08-21T12:00:00Z", lastProgressAt: "2026-08-21T12:00:00Z", lastWorkerHeartbeatAt: "2026-08-21T12:00:00Z" };
  assert.equal(isImportStalled(stale, now, 120), true);
  assert.equal(isImportStalled({ ...stale, lastWorkerHeartbeatAt: "2026-08-21T12:04:50Z" }, now, 120), false);
  assert.equal(isImportStalled({ ...stale, retryAfterAt: "2026-08-21T12:06:00Z" }, now, 120), false);
});

test("progress uses real channel and message measurements without fake totals", () => {
  const result = calculateImportProgress({ startedAt: "2026-08-21T12:00:00Z", fetchedMessages: 600, totalChannels: 10, completedChannels: 3, skippedChannels: 1 }, Date.parse("2026-08-21T12:01:00Z"));
  assert.equal(result.messagesPerSecond, 10);
  assert.equal(result.channelProgressPercent, 40);
  assert.equal(calculateImportProgress({ fetchedMessages: 1, totalChannels: 0 }).channelProgressPercent, null);
});

test("source labels and destructive confirmation are exact", () => {
  assert.deepEqual(MESSAGE_SOURCE, { existing: "existing", live: "live", history: "history_import" });
  assert.equal(IMPORTED_DATA_CONFIRMATION, "RESET IMPORTED DATA");
});
