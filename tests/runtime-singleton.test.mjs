import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeCoordinator,
  createRuntimeIdentity,
  createRuntimeLeaseRepository,
  getRuntimeConfig,
  validateRuntimeConfig,
} from "../lib/runtime-singleton.mjs";

function createMemoryRepository() {
  let now = 1_700_000_000_000;
  let lease = null;
  const heartbeats = new Map();
  const snapshot = () => lease && ({
    ...lease,
    dbNow: new Date(now),
    leaseExpiresAt: new Date(lease.leaseExpiresAt),
    acquiredAt: new Date(lease.acquiredAt),
    renewedAt: new Date(lease.renewedAt),
  });
  return {
    advance(milliseconds) { now += milliseconds; },
    lease() { return lease && { ...lease }; },
    heartbeats,
    async acquire({ serviceKey, instanceId, hostId, ttlSeconds }) {
      if (lease && lease.ownerInstanceId !== instanceId && lease.leaseExpiresAt > now) return null;
      const sameOwner = lease?.ownerInstanceId === instanceId;
      const fencingToken = !lease ? 1 : sameOwner ? lease.fencingToken : lease.fencingToken + 1;
      lease = {
        serviceKey,
        ownerInstanceId: instanceId,
        hostId,
        fencingToken,
        leaseExpiresAt: now + ttlSeconds * 1_000,
        acquiredAt: sameOwner ? lease.acquiredAt : now,
        renewedAt: now,
      };
      return snapshot();
    },
    async renew({ serviceKey, instanceId, fencingToken, ttlSeconds }) {
      if (!lease || lease.serviceKey !== serviceKey || lease.ownerInstanceId !== instanceId || String(lease.fencingToken) !== String(fencingToken) || lease.leaseExpiresAt <= now) return null;
      lease.leaseExpiresAt = now + ttlSeconds * 1_000;
      lease.renewedAt = now;
      return snapshot();
    },
    async release({ serviceKey, instanceId, fencingToken }) {
      if (!lease || lease.serviceKey !== serviceKey || lease.ownerInstanceId !== instanceId || String(lease.fencingToken) !== String(fencingToken)) return false;
      lease.ownerInstanceId = null;
      lease.hostId = null;
      lease.leaseExpiresAt = now;
      lease.renewedAt = now;
      return true;
    },
    async getCurrentOwner() { return snapshot(); },
    async writeHeartbeat(heartbeat) { heartbeats.set(heartbeat.instanceId, { ...heartbeat }); },
    async cleanupHeartbeats() { return 0; },
  };
}

const baseConfig = {
  enabled: true,
  serviceKey: "nuviloview.discord-bot.test",
  ttlSeconds: 45,
  renewSeconds: 15,
  heartbeatSeconds: 15,
  proofSafetySeconds: 5,
  heartbeatRetentionDays: 30,
};
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const identity = (hostId, instanceId) => ({
  hostId,
  instanceId,
  hostname: hostId,
  platform: "Linux",
  pid: 123,
  startedAt: new Date("2026-08-16T00:00:00Z"),
  appVersion: "test",
  runtimeVersion: process.version,
  commitSha: null,
});

test("runtime configuration validates service identity and renewal windows", () => {
  const config = getRuntimeConfig({
    NUVILOVIEW_DISTRIBUTED_SINGLETON: "true",
    NUVILOVIEW_DEPLOYMENT_ENV: "staging",
  });
  const runtimeIdentity = createRuntimeIdentity(
    { NUVILOVIEW_HOST_ID: "android-tablet", TERMUX_VERSION: "0.118" },
    { instanceId: "instance-a", hostname: "tablet", pid: 10 },
  );
  assert.equal(config.serviceKey, "nuviloview.discord-bot.staging");
  assert.equal(runtimeIdentity.platform, "AndroidTermux");
  assert.deepEqual(validateRuntimeConfig(config, runtimeIdentity), []);
  assert.ok(validateRuntimeConfig({ ...config, renewSeconds: config.ttlSeconds }, runtimeIdentity).length > 0);
});

test("only one simultaneous host acquires the lease", async () => {
  const repository = createMemoryRepository();
  const hostA = new RuntimeCoordinator({ repository, config: baseConfig, identity: identity("windows-main", "a"), logger: silentLogger });
  const hostB = new RuntimeCoordinator({ repository, config: baseConfig, identity: identity("android-tablet", "b"), logger: silentLogger });
  const results = await Promise.all([hostA.acquire(), hostB.acquire()]);
  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(repository.lease().fencingToken, 1);
});

test("expired takeover increments fencing and stale owner is stopped after reconnect", async () => {
  const repository = createMemoryRepository();
  let hostALost = false;
  const hostA = new RuntimeCoordinator({
    repository,
    config: baseConfig,
    identity: identity("windows-main", "a"),
    logger: silentLogger,
    onLeaseLost: async () => { hostALost = true; },
  });
  const hostB = new RuntimeCoordinator({ repository, config: baseConfig, identity: identity("android-tablet", "b"), logger: silentLogger });
  assert.equal((await hostA.acquire()).acquired, true);
  repository.advance(46_000);
  assert.equal((await hostB.acquire()).acquired, true);
  assert.equal(repository.lease().fencingToken, 2);
  assert.equal(await hostA.renewOnce(), false);
  assert.equal(hostALost, true);
  assert.equal(await hostB.renewOnce(), true);
});

test("temporary DB failure uses grace but stops before the ownership proof deadline", async () => {
  const repository = createMemoryRepository();
  let monotonic = 0;
  let lost = false;
  repository.renew = async () => { throw new Error("database unavailable"); };
  const coordinator = new RuntimeCoordinator({
    repository,
    config: baseConfig,
    identity: identity("windows-main", "db-outage"),
    logger: silentLogger,
    monotonicNow: () => monotonic,
    onLeaseLost: async () => { lost = true; },
  });
  await coordinator.acquire();
  monotonic = 10_000;
  assert.equal(await coordinator.renewOnce(), false);
  assert.equal(lost, false);
  monotonic = 41_000;
  assert.equal(await coordinator.renewOnce(), false);
  assert.equal(lost, true);
});

test("release and renew reject the wrong instance or fencing token", async () => {
  const repository = createMemoryRepository();
  const acquired = await repository.acquire({ serviceKey: baseConfig.serviceKey, instanceId: "a", hostId: "windows", ttlSeconds: 45 });
  assert.equal(await repository.renew({ serviceKey: baseConfig.serviceKey, instanceId: "other", fencingToken: acquired.fencingToken, ttlSeconds: 45 }), null);
  assert.equal(await repository.renew({ serviceKey: baseConfig.serviceKey, instanceId: "a", fencingToken: 999, ttlSeconds: 45 }), null);
  assert.equal(await repository.release({ serviceKey: baseConfig.serviceKey, instanceId: "other", fencingToken: acquired.fencingToken }), false);
  assert.equal(await repository.release({ serviceKey: baseConfig.serviceKey, instanceId: "a", fencingToken: acquired.fencingToken }), true);
});

test("heartbeat records host, process identity, state, and fence", async () => {
  const repository = createMemoryRepository();
  const coordinator = new RuntimeCoordinator({
    repository,
    config: baseConfig,
    identity: identity("android-tablet", "instance-1"),
    heartbeatData: () => ({
      guildCount: 8,
      metadata: { discordReady: true, reconnectCount: 2 },
    }),
    logger: silentLogger,
  });
  await coordinator.acquire();
  coordinator.setStatus("Running", "Owned");
  await coordinator.recordNow();
  const heartbeat = repository.heartbeats.get("instance-1");
  assert.equal(heartbeat.hostId, "android-tablet");
  assert.equal(heartbeat.guildCount, 8);
  assert.equal(heartbeat.status, "Running");
  assert.equal(heartbeat.leaseState, "Owned");
  assert.equal(String(heartbeat.fencingToken), "1");
  assert.deepEqual(heartbeat.metadata, { discordReady: true, reconnectCount: 2 });
});

test("shutdown serializes heartbeat writes so Stopped remains the final state", async () => {
  const repository = createMemoryRepository();
  const originalWrite = repository.writeHeartbeat;
  let unblockFirstWrite;
  let firstWrite = true;
  repository.writeHeartbeat = async (heartbeat) => {
    if (firstWrite) {
      firstWrite = false;
      await new Promise((resolve) => { unblockFirstWrite = resolve; });
    }
    await originalWrite(heartbeat);
  };
  const coordinator = new RuntimeCoordinator({
    repository,
    config: baseConfig,
    identity: identity("windows-main", "serialized-instance"),
    logger: silentLogger,
  });
  await coordinator.acquire();
  coordinator.setStatus("Running", "Owned");
  const periodicWrite = coordinator.recordNow();
  await new Promise((resolve) => setImmediate(resolve));
  const stop = coordinator.stop();
  unblockFirstWrite();
  await Promise.all([periodicWrite, stop]);
  const heartbeat = repository.heartbeats.get("serialized-instance");
  assert.equal(heartbeat.status, "Stopped");
  assert.equal(heartbeat.leaseState, "Released");
  assert.ok(heartbeat.stoppedAt instanceof Date);
});

test("PostgreSQL repository uses DB time and owner plus fence predicates", async () => {
  const statements = [];
  const repository = createRuntimeLeaseRepository(async (text) => {
    statements.push(text);
    return [];
  });
  await repository.acquire({ serviceKey: "service", instanceId: "a", hostId: "host", ttlSeconds: 45 });
  await repository.renew({ serviceKey: "service", instanceId: "a", fencingToken: "1", ttlSeconds: 45 });
  await repository.release({ serviceKey: "service", instanceId: "a", fencingToken: "1" });
  await repository.writeHeartbeat({
    instanceId: "a",
    serviceKey: "service",
    hostId: "host",
    fencingToken: "1",
    platform: "test",
    hostname: "host",
    pid: 1,
    startedAt: new Date(),
    status: "Running",
    leaseState: "Owned",
    appVersion: "test",
    runtimeVersion: process.version,
    commitSha: null,
    guildCount: 1,
    metadata: { discordReady: true },
  });
  assert.match(statements[0], /ON CONFLICT \("serviceKey"\) DO UPDATE/);
  assert.match(statements[0], /CURRENT_TIMESTAMP/);
  assert.match(statements[0], /"fencingToken" \+ 1/);
  assert.match(statements[1], /"ownerInstanceId" = \$2/);
  assert.match(statements[1], /"fencingToken" = \$3::bigint/);
  assert.match(statements[2], /"ownerInstanceId" = \$2/);
  assert.match(statements[2], /"fencingToken" = \$3::bigint/);
  assert.match(statements[3], /"metadata" = EXCLUDED\."metadata"/);
});
