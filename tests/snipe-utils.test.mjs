import test from "node:test";
import assert from "node:assert/strict";
import {
  SNIPE_RETENTION_MS,
  SNIPE_RETENTION_DAYS,
  SNIPE_CLEANUP_TIMER_MAX_MS,
  SNIPE_HISTORY_LIMIT,
  SNIPE_RESULT_SESSION_MS,
  canDeleteSnipeResult,
  createSnipeDeleteCustomId,
  createSnipePageCustomId,
  escapeSnipeText,
  getSnipeCleanupDelay,
  limitSnipeHistory,
  parseSnipeDeleteCustomId,
  parseSnipePageCustomId,
} from "../lib/snipe-utils.mjs";

test("Snipe text cannot trigger mentions or break code blocks", () => {
  const escaped = escapeSnipeText("@everyone **alert** ```danger```", 360);
  assert.equal(escaped.includes("@everyone"), false);
  assert.equal(escaped.includes("```"), false);
  assert.match(escaped, /＠everyone/);
});

test("Snipe history is retained for 90 days while result controls expire sooner", () => {
  assert.equal(SNIPE_RETENTION_DAYS, 90);
  assert.equal(SNIPE_RETENTION_MS, 90 * 24 * 60 * 60 * 1_000);
  assert.equal(SNIPE_RESULT_SESSION_MS, 15 * 60 * 1_000);
  assert.equal(SNIPE_HISTORY_LIMIT, 999_999);
});

test("Snipe cleanup safely divides a 90-day wait into Node-compatible timers", () => {
  const now = Date.UTC(2026, 7, 16);
  assert.equal(
    getSnipeCleanupDelay(now + SNIPE_RETENTION_MS, now),
    SNIPE_CLEANUP_TIMER_MAX_MS,
  );
  assert.equal(getSnipeCleanupDelay(now - 1_000, now), 1);
});

test("Snipe history discards oldest records beyond the configured maximum", () => {
  const newestFirst = [
    { messageId: "newest" },
    { messageId: "middle" },
    { messageId: "oldest" },
  ];
  assert.deepEqual(
    limitSnipeHistory(newestFirst, 2).map((record) => record.messageId),
    ["newest", "middle"],
  );
  assert.throws(() => limitSnipeHistory(newestFirst, 0), RangeError);
});

test("Snipe delete component is bound to its command executor", () => {
  const executorId = "932566725898158080";
  const customId = createSnipeDeleteCustomId(executorId);
  assert.equal(customId, `nvsnipe:delete:${executorId}`);
  assert.deepEqual(parseSnipeDeleteCustomId(customId), { executorId });
  assert.equal(parseSnipeDeleteCustomId("nvsnipe:delete:not-an-id"), null);
});

test("Snipe page controls accept only previous and next directions", () => {
  assert.equal(createSnipePageCustomId("previous"), "nvsnipe:page:previous");
  assert.equal(createSnipePageCustomId("next"), "nvsnipe:page:next");
  assert.deepEqual(parseSnipePageCustomId("nvsnipe:page:previous"), {
    direction: "previous",
  });
  assert.deepEqual(parseSnipePageCustomId("nvsnipe:page:next"), {
    direction: "next",
  });
  assert.equal(parseSnipePageCustomId("nvsnipe:page:unknown"), null);
  assert.throws(() => createSnipePageCustomId("unknown"));
});

test("only the executor, Guild owner, or Administrator can delete a Snipe result", () => {
  const base = {
    userId: "100000000000000001",
    executorId: "100000000000000002",
    guildOwnerId: "100000000000000003",
    isAdministrator: false,
  };
  assert.equal(
    canDeleteSnipeResult({ ...base, userId: base.executorId }),
    true,
  );
  assert.equal(
    canDeleteSnipeResult({ ...base, userId: base.guildOwnerId }),
    true,
  );
  assert.equal(
    canDeleteSnipeResult({ ...base, isAdministrator: true }),
    true,
  );
  assert.equal(
    canDeleteSnipeResult({ ...base, canManageMessages: true }),
    false,
  );
  assert.equal(canDeleteSnipeResult(base), false);
});
