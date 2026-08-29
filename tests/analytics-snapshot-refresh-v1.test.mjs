import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAnalyticsRefreshContract,
  getAnalyticsRefreshIntervalMs,
  getAnalyticsRefreshMetrics,
  isAnalyticsRefreshDue,
  recordAnalyticsFetch,
  resetAnalyticsRefreshMetricsForTests,
  toAnalyticsRefreshSchedule,
} from "../lib/analytics-refresh.mjs";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test.beforeEach(() => resetAnalyticsRefreshMetricsForTests());

test("Analytics refresh contract defaults to 15 minutes and preserves snapshot identity", () => {
  assert.equal(getAnalyticsRefreshIntervalMs({}), 900_000);
  assert.equal(
    getAnalyticsRefreshIntervalMs({ ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "30" }),
    60_000,
  );
  assert.equal(
    getAnalyticsRefreshIntervalMs({ ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "90000" }),
    86_400_000,
  );
  const contract = createAnalyticsRefreshContract({
    lastUpdatedAt: 1_000,
    nextUpdateAt: 901_000,
    snapshotVersion: 7,
    checksum: "sha256:projection",
    freshness: "stale",
  }, { at: 2_000, intervalMs: 900_000 });
  assert.deepEqual(contract, {
    last_updated_at: 1_000,
    next_update_at: 901_000,
    snapshot_version: 7,
    checksum: "sha256:projection",
    freshness: "stale",
    interval_ms: 900_000,
  });
  assert.deepEqual(toAnalyticsRefreshSchedule(contract), {
    lastUpdatedAt: 1_000,
    nextUpdateAt: 901_000,
    snapshotVersion: 7,
    checksum: "sha256:projection",
    freshness: "stale",
    intervalMs: 900_000,
  });
  assert.equal(
    createAnalyticsRefreshContract(
      { nextUpdateAt: 100_000, freshness: "very_stale" },
      { at: 1_000_000, intervalMs: 900_000 },
    ).next_update_at,
    1_900_000,
  );
});

test("Countdown and visibility gates request once only when the deadline is due", () => {
  const deadline = 10_000;
  assert.equal(isAnalyticsRefreshDue({ at: 9_999, nextUpdateAt: deadline }), false);
  assert.equal(isAnalyticsRefreshDue({ at: deadline, nextUpdateAt: deadline }), true);
  assert.equal(isAnalyticsRefreshDue({
    at: deadline,
    nextUpdateAt: deadline,
    inFlight: true,
  }), false);
  assert.equal(isAnalyticsRefreshDue({
    at: deadline,
    nextUpdateAt: deadline,
    lastRequestedNextUpdateAt: deadline,
  }), false);
});

test("Client metrics distinguish initial, countdown, and visibility fetches", () => {
  recordAnalyticsFetch("initial");
  recordAnalyticsFetch("countdown");
  recordAnalyticsFetch("visibility");
  assert.deepEqual(getAnalyticsRefreshMetrics(), {
    analytics_fetches: 3,
    countdown_refetches: 1,
    visibility_refetches: 1,
  });
});

test("Countdown is DOM-only and detailed Analytics uses one request path", () => {
  const countdown = source("components/analytics-refresh-countdown.tsx");
  const dashboard = source("components/community-analytics-dashboard.tsx");
  assert.doesNotMatch(countdown, /\bfetch\s*\(/);
  assert.match(countdown, /setInterval\(\(\) => setClock\(Date\.now\(\)\), 1_000\)/);
  assert.match(countdown, /setTimeout/);
  assert.match(countdown, /requestRefresh\("countdown"\)/);
  assert.match(countdown, /requestRefresh\("visibility"\)/);
  assert.match(countdown, /lastRequestedNextUpdateAtRef/);
  assert.match(dashboard, /fetch\(\s*`\/api\/analytics\/community\?/);
  assert.doesNotMatch(dashboard, /\/api\/analytics\/snapshot/);
  assert.equal((dashboard.match(/\bfetch\s*\(/g) ?? []).length, 1);
});

test("Overview avoids duplicate Analytics reads and keeps Runtime on its own cadence", () => {
  const dashboardPage = source("app/dashboard/page.tsx");
  const runtime = source("components/runtime-provider-status.tsx");
  assert.doesNotMatch(
    dashboardPage,
    /<CommunityAnalyticsDashboard\s+view="overview"/,
  );
  assert.match(dashboardPage, /load\("countdown"\)/);
  assert.match(dashboardPage, /load\("visibility"\)/);
  assert.match(dashboardPage, /<AnalyticsRefreshCountdown/);
  assert.match(runtime, /setInterval[\s\S]*60_000/);
});

test("Analytics APIs expose the refresh contract without raw Cloud aggregation", () => {
  for (const path of [
    "app/backend/status/route.ts",
    "app/api/analytics/community/route.ts",
    "app/api/analytics/snapshot/route.ts",
  ]) {
    const route = source(path);
    assert.match(route, /createAnalyticsRefreshContract/);
    assert.match(route, /\.\.\.refresh/);
  }
  const webRouter = source("lib/web-read-router.mjs");
  const projection = source("lib/projection-analytics.ts");
  assert.match(webRouter, /rawAnalyticsQueries:\s*0/);
  assert.match(projection, /rawAnalyticsQueries:\s*0/);
  assert.doesNotMatch(projection, /FROM\s+(?:message_events|reaction_events|voice_events|member_events)/i);
});

test("Compaction telemetry exposes checksum skips and provider write breakdown", () => {
  const repository = source("lib/storage/repositories/analytics-projections.mjs");
  const worker = source("lib/sync/multi-worker.mjs");
  assert.match(repository, /snapshotsSkippedChecksum/);
  assert.match(repository, /providerWritesByProvider/);
  assert.match(worker, /analyticsProjections\.recordProviderWrites/);
});
