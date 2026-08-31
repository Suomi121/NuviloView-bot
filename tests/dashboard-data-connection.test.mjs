import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyDashboardDataConnection } from "../lib/dashboard-data-connection.mjs";

test("fresh Supabase and Turso Projections are connected", () => {
  for (const provider of ["supabase", "turso"]) {
    assert.equal(classifyDashboardDataConnection({
      available: true,
      provider,
      freshness: "fresh",
      degraded: false,
      lastKnownGood: false,
    }), "connected");
  }
});

test("only an explicitly returned Last Known Good snapshot is degraded", () => {
  assert.equal(classifyDashboardDataConnection({
    available: false,
    provider: "turso",
    freshness: "very_stale",
    degraded: true,
    lastKnownGood: true,
  }), "degraded");

  assert.equal(classifyDashboardDataConnection({
    available: true,
    provider: "turso",
    freshness: "very_stale",
    degraded: true,
    lastKnownGood: false,
  }), "stale");
});

test("a successful response without a Projection is unavailable, not a fetch failure", () => {
  assert.equal(classifyDashboardDataConnection({
    available: false,
    provider: null,
    freshness: "unavailable",
    degraded: true,
    lastKnownGood: false,
  }), "unavailable");
  assert.equal(classifyDashboardDataConnection(null), "unavailable");
});

test("Dashboard keeps request failure separate from Projection and Provider health", () => {
  const dashboard = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
  const notice = readFileSync(new URL("../components/projection-read-notice.tsx", import.meta.url), "utf8");

  assert.match(dashboard, /setLoadState\(classifyDashboardDataConnection\(/);
  assert.match(dashboard, /setLoadState\("fetch_error"\)/);
  assert.doesNotMatch(dashboard, /readMeta\?\.available === false \? "error"/);
  assert.match(dashboard, /<RuntimeProviderStatus guildId=\{guildId\}/);
  assert.match(notice, /meta\.lastKnownGood/);
  assert.match(notice, /Last Known Good/);
});

test("Dashboard labels the activity summary as weekly insights", () => {
  const dashboard = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
  const analytics = readFileSync(new URL("../components/community-analytics-dashboard.tsx", import.meta.url), "utf8");

  assert.match(dashboard, /Weekly insights/);
  assert.match(dashboard, /週間インサイト/);
  assert.doesNotMatch(dashboard, /Live activity pulse|リアルタイム活動パルス/);
  assert.doesNotMatch(analytics, /live activity signal|リアルタイム活動パルス/);
});
