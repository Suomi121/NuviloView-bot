import assert from "node:assert/strict";
import test from "node:test";

import {
  healthV2HistoryEntry,
  healthV2SnapshotScore,
  resolveHealthV2ReleaseConfig,
} from "../lib/health-v2-release.mjs";

test("Health v2 defaults to preview shadow mode, never an official release", () => {
  const release = resolveHealthV2ReleaseConfig({});
  assert.equal(release.stage, "preview");
  assert.equal(release.mode, "shadow");
  assert.equal(release.official, false);
  assert.equal(release.visible, true);
  assert.equal(release.shadowWriteEnabled, true);
});

test("preview shadow snapshots keep the official score column empty", () => {
  const release = resolveHealthV2ReleaseConfig({ HEALTH_V2_RELEASE_STAGE: "preview" });
  assert.equal(healthV2SnapshotScore({ score: 82 }, release), null);
  const history = healthV2HistoryEntry({
    date: "2026-08-08",
    score: null,
    confidence: "medium",
    categories: { _healthV2: { releaseStage: "preview", mode: "shadow", shadowScore: 82 } },
  }, release);
  assert.equal(history.score, 82);
  assert.equal(history.isShadow, true);
});

test("stable release requires an explicit stage", () => {
  const release = resolveHealthV2ReleaseConfig({ HEALTH_V2_RELEASE_STAGE: "stable" });
  assert.equal(release.official, true);
  assert.equal(release.mode, "official");
  assert.equal(healthV2SnapshotScore({ score: 82 }, release), 82);
});

test("invalid stages fall back to preview instead of becoming official", () => {
  const release = resolveHealthV2ReleaseConfig({ HEALTH_V2_RELEASE_STAGE: "production" });
  assert.equal(release.stage, "preview");
  assert.equal(release.official, false);
});
