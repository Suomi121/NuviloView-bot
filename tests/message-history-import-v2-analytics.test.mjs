import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const analytics = await readFile(new URL("../lib/projection-analytics.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/analytics/community/route.ts", import.meta.url), "utf8");

test("history analytics uses the normal compacted Projection read path", () => {
  assert.match(route, /readAnalyticsBundle/);
  assert.match(route, /buildProjectionCommunityAnalytics/);
  assert.doesNotMatch(route, /discord_message|message_event_log|history_import|pool\.query/i);
});

test("Projection analytics does not invent unavailable per-source provenance", () => {
  assert.match(analytics, /messageSources: \{ available: false/);
  assert.match(analytics, /rawAnalyticsQueries: 0/);
  assert.doesNotMatch(analytics, /discord_message|message_event_log|pool\.query/i);
});
