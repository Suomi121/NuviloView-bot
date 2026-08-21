import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const analytics = await readFile(new URL("../lib/community-analytics.ts", import.meta.url), "utf8");

test("message provenance query is disabled until v2 migration rollout", () => {
  assert.match(analytics, /if \(!messageImportConfig\.enabled\) return \{ current: unavailable, previous: unavailable \}/);
  assert.match(analytics, /m\."source" = 'live'/);
  assert.match(analytics, /m\."source" = 'history_import'/);
  assert.match(analytics, /m\."source" = 'existing'/);
});

test("message provenance is attached as quality evidence without changing Health inputs", () => {
  assert.match(analytics, /messageSources: messageSourceQuality\.current/);
  assert.match(analytics, /messageSources: messageSourceQuality\.previous/);
  assert.doesNotMatch(analytics, /qualityGatePassed:\s*messageSourceQuality/);
});
