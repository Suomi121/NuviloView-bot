import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOperationsTransition,
  evaluateOperationsSnapshot,
  getOperationsMonitorConfig,
  operationsIncidentFingerprint,
} from "../lib/operations-monitor.mjs";

const now = new Date("2026-08-21T00:00:00Z");
const config = getOperationsMonitorConfig({});
const healthyRuntime = {
  state: "Healthy",
  incidents: [],
  ownerHeartbeat: {
    status: "Running",
    guildCount: 8,
    metadata: {
      discordReady: true,
      lastAnalyticsSuccessAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    },
  },
};
const healthy = () => ({
  now,
  runtime: healthyRuntime,
  db: { latencyMs: 20 },
  api: { configured: true, ok: true, status: 200, latencyMs: 100 },
  backup: { available: true, status: "complete", restoreVerified: true, updatedAt: new Date(now.getTime() - 60_000) },
  security: { openCritical: 0, recentHigh: 0 },
  analytics: { lastObservedAt: new Date(now.getTime() - 10 * 60_000), guildCount: 8 },
  config,
});

test("operations monitor reports INFO for a healthy cross-system snapshot", () => {
  const result = evaluateOperationsSnapshot(healthy());
  assert.equal(result.severity, "INFO");
  assert.deepEqual(result.incidents, []);
});

test("operations monitor detects DB, API, backup and analytics failures", () => {
  const input = healthy();
  input.db = { unavailable: true };
  input.api = { configured: true, ok: false, status: 503, latencyMs: 100 };
  input.backup = { available: true, status: "failed", restoreVerified: false, updatedAt: now, stage: "copy" };
  input.analytics = { lastObservedAt: null, guildCount: 8 };
  input.runtime = {
    ...healthyRuntime,
    ownerHeartbeat: {
      ...healthyRuntime.ownerHeartbeat,
      metadata: { discordReady: true },
    },
  };
  const result = evaluateOperationsSnapshot(input);
  assert.equal(result.severity, "CRITICAL");
  for (const code of ["database_unavailable", "api_unavailable", "backup_failed", "analytics_ingestion_stale"]) {
    assert.ok(result.incidents.some((incident) => incident.code === code), `missing ${code}`);
  }
});

test("operations monitor detects recent Discord and Security signals", () => {
  const input = healthy();
  input.runtime = {
    ...healthyRuntime,
    ownerHeartbeat: {
      ...healthyRuntime.ownerHeartbeat,
      metadata: {
        ...healthyRuntime.ownerHeartbeat.metadata,
        lastDiscordInvalidSessionAt: new Date(now.getTime() - 60_000).toISOString(),
        lastDiscordRateLimitAt: new Date(now.getTime() - 30_000).toISOString(),
      },
    },
  };
  input.security = { openCritical: 1, recentHigh: 3 };
  const result = evaluateOperationsSnapshot(input);
  assert.equal(result.severity, "CRITICAL");
  for (const code of ["discord_invalid_session", "discord_rate_limited", "security_critical_incident", "security_repeated_high"]) {
    assert.ok(result.incidents.some((incident) => incident.code === code), `missing ${code}`);
  }
});

test("unchanged incidents have a stable deduplication fingerprint", () => {
  const input = healthy();
  input.backup = { available: false };
  const first = evaluateOperationsSnapshot(input);
  const second = evaluateOperationsSnapshot(input);
  assert.equal(first.severity, "WARNING");
  assert.equal(operationsIncidentFingerprint(first), operationsIncidentFingerprint(second));
  const previous = { fingerprint: operationsIncidentFingerprint(first), severity: first.severity };
  assert.equal(classifyOperationsTransition(previous, second).changed, false);
  const recovery = classifyOperationsTransition(previous, evaluateOperationsSnapshot(healthy()));
  assert.equal(recovery.changed, true);
  assert.equal(recovery.recovered, true);
});
