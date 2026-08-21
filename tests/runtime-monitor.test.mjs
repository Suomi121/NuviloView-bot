import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateLegacyBotHeartbeat,
  evaluateRuntimeSnapshot,
  runtimeIncidentFingerprint,
} from "../lib/runtime-monitor.mjs";

const now = new Date("2026-08-16T00:00:00Z");
const config = {
  serviceKey: "nuviloview.discord-bot.test",
  warningSeconds: 45,
  criticalSeconds: 90,
  restartWindowMinutes: 10,
  restartThreshold: 5,
  contentionThreshold: 5,
  intervalSeconds: 30,
};
const lease = {
  ownerInstanceId: "owner",
  hostId: "android",
  fencingToken: "4",
  leaseExpiresAt: new Date(now.getTime() + 30_000),
};
function heartbeat(overrides = {}) {
  return {
    instanceId: "owner",
    hostId: "android",
    fencingToken: "4",
    startedAt: new Date(now.getTime() - 60_000),
    lastHeartbeatAt: new Date(now.getTime() - 10_000),
    status: "Running",
    leaseState: "Owned",
    ...overrides,
  };
}

test("monitor reports healthy active lease and matching heartbeat", () => {
  const result = evaluateRuntimeSnapshot({ dbNow: now, lease, heartbeats: [heartbeat()], config });
  assert.equal(result.state, "Healthy");
  assert.equal(result.heartbeatAgeSeconds, 10);
});

test("monitor distinguishes delayed and stale owner heartbeat", () => {
  const delayed = evaluateRuntimeSnapshot({ dbNow: now, lease, heartbeats: [heartbeat({ lastHeartbeatAt: new Date(now.getTime() - 60_000) })], config });
  const stale = evaluateRuntimeSnapshot({ dbNow: now, lease, heartbeats: [heartbeat({ lastHeartbeatAt: new Date(now.getTime() - 100_000) })], config });
  assert.equal(delayed.state, "Warning");
  assert.ok(delayed.incidents.some((incident) => incident.code === "heartbeat_delayed"));
  assert.equal(stale.state, "Critical");
  assert.ok(stale.incidents.some((incident) => incident.code === "heartbeat_stale"));
});

test("monitor detects lease without heartbeat and heartbeat without lease", () => {
  const withoutHeartbeat = evaluateRuntimeSnapshot({ dbNow: now, lease, heartbeats: [], config });
  const withoutLease = evaluateRuntimeSnapshot({ dbNow: now, lease: null, heartbeats: [heartbeat()], config });
  assert.ok(withoutHeartbeat.incidents.some((incident) => incident.code === "lease_without_heartbeat"));
  assert.ok(withoutLease.incidents.some((incident) => incident.code === "heartbeat_without_lease"));
});

test("monitor detects a fresh non-owner and duplicate host process", () => {
  const result = evaluateRuntimeSnapshot({
    dbNow: now,
    lease,
    heartbeats: [
      heartbeat(),
      heartbeat({ instanceId: "other", fencingToken: "3" }),
    ],
    config,
  });
  assert.equal(result.state, "Critical");
  assert.ok(result.incidents.some((incident) => incident.code === "duplicate_active_instances"));
  assert.ok(result.incidents.some((incident) => incident.code === "duplicate_host_instance"));
});

test("monitor detects restart storm, repeated contention, and owner flapping", () => {
  const recent = Array.from({ length: 5 }, (_, index) => heartbeat({
    instanceId: `run-${index}`,
    hostId: `host-${index % 2}`,
    fencingToken: String(index + 1),
    status: "Stopped",
    leaseState: "Released",
    startedAt: new Date(now.getTime() - index * 30_000),
    lastHeartbeatAt: new Date(now.getTime() - index * 30_000),
  }));
  const contentions = Array.from({ length: 5 }, (_, index) => heartbeat({
    instanceId: `contended-${index}`,
    hostId: "windows",
    fencingToken: null,
    status: "LeaseContended",
    leaseState: "Contended",
    startedAt: new Date(now.getTime() - index * 20_000),
  }));
  const result = evaluateRuntimeSnapshot({ dbNow: now, lease, heartbeats: [heartbeat(), ...recent, ...contentions], config });
  for (const code of ["restart_storm", "lease_contention_repeated", "owner_flapping"]) {
    assert.ok(result.incidents.some((incident) => incident.code === code), `missing ${code}`);
  }
});

test("monitor returns Unknown for DB outage and fingerprints deduplicate unchanged incidents", () => {
  const first = evaluateRuntimeSnapshot({ config, dbUnavailable: true });
  const second = evaluateRuntimeSnapshot({ config, dbUnavailable: true });
  assert.equal(first.state, "Unknown");
  assert.equal(runtimeIncidentFingerprint(first), runtimeIncidentFingerprint(second));
});

test("observation mode can monitor the legacy heartbeat before singleton rollout", () => {
  const healthy = evaluateLegacyBotHeartbeat({
    dbNow: now,
    heartbeat: {
      lastSeenAt: new Date(now.getTime() - 30_000),
      startedAt: new Date(now.getTime() - 60_000),
      stoppedAt: null,
      guildCount: 8,
    },
    maximumAgeSeconds: 180,
  });
  const stale = evaluateLegacyBotHeartbeat({
    dbNow: now,
    heartbeat: { lastSeenAt: new Date(now.getTime() - 181_000), stoppedAt: null, guildCount: 8 },
    maximumAgeSeconds: 180,
  });
  assert.equal(healthy.state, "Healthy");
  assert.equal(stale.state, "Critical");
  assert.ok(stale.incidents.some((incident) => incident.code === "legacy_heartbeat_stale"));
});
