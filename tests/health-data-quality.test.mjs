import assert from "node:assert/strict";
import test from "node:test";
import {
  attachHealthScoresToQualityGate,
  createHealthDataQualityGate,
} from "../lib/health-data-quality.mjs";

function input(overrides = {}) {
  return {
    observationDays: 30,
    messages: 300,
    activeUsers: 30,
    uniqueAuthors: 30,
    joins: 10,
    leaves: 2,
    retention: {
      eligible7: 10,
      sources: { discordLive: 10, discordSync: 0, historicalImport: 0, unknown: 0 },
    },
    voice: {
      trackingSince: "2026-01-01T00:00:00Z",
      observationDays: 30,
      validSessions: 20,
      anomalies: { over24Hours: 0, unclosedOver24Hours: 0, future: 0, negative: 0, duplicate: 0, overlap: 0 },
    },
    reaction: {
      trackingSince: "2026-01-01T00:00:00Z",
      observationDays: 30,
      events: 100,
    },
    messageSources: {
      available: true,
      live: 240,
      historyImport: 60,
      existing: 0,
      unknown: 0,
    },
    ...overrides,
  };
}

test("discord_sync-only joins never make Retention eligible", () => {
  const gate = createHealthDataQualityGate(input({
    retention: {
      eligible7: 50,
      sources: { discordLive: 0, discordSync: 50, historicalImport: 0, unknown: 0 },
    },
  }));
  assert.equal(gate.categories.retention.qualityState, "Unavailable");
  assert.equal(gate.sanitization.retentionUsable, false);
  assert.equal(gate.passes, false);
});

test("Voice sessions over 24 hours and impossible rows lower quality and are excluded upstream", () => {
  const gate = createHealthDataQualityGate(input({
    voice: {
      trackingSince: "2026-01-01T00:00:00Z",
      observationDays: 30,
      validSessions: 4,
      anomalies: { over24Hours: 2, unclosedOver24Hours: 1, future: 1, negative: 0, duplicate: 0, overlap: 0 },
    },
  }));
  assert.equal(gate.categories.voice.qualityState, "LowConfidence");
  assert.ok(gate.blockingReasons.includes("voice_outlier_rate_high"));
});

test("Reaction collection under 14 days is Immature instead of zero", () => {
  const gate = createHealthDataQualityGate(input({
    reaction: { trackingSince: "2026-08-12T00:00:00Z", observationDays: 9, events: 0 },
  }));
  assert.equal(gate.components.reaction.qualityState, "Immature");
  assert.equal(gate.sanitization.reactionUsable, false);
});

test("missing categories remain explainable and scores attach without inventing values", () => {
  const gate = createHealthDataQualityGate(input({ joins: 0, leaves: 0, uniqueAuthors: 2 }));
  const attached = attachHealthScoresToQualityGate(gate, {
    categories: { engagement: 80, retention: 60, distribution: null, voice: 50, growth: null },
    inputs: { reactionRate: null },
  });
  assert.equal(attached.categories.distribution.score, null);
  assert.equal(attached.categories.growth.qualityState, "Unavailable");
  assert.equal(attached.components.reaction.score, null);
});

test("history import provenance is evidence-only and does not change Health scoring gates", () => {
  const liveOnly = createHealthDataQualityGate(input({
    messageSources: { available: true, live: 300, historyImport: 0, existing: 0, unknown: 0 },
  }));
  const mixed = createHealthDataQualityGate(input());
  assert.equal(mixed.evidence.messageSources.historyImport, 60);
  assert.equal(mixed.evidence.messageSources.historyImportShare, 0.2);
  assert.deepEqual(mixed.categories, liveOnly.categories);
  assert.deepEqual(mixed.blockingReasons, liveOnly.blockingReasons);
});
