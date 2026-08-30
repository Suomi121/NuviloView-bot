import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateProjectionBotHealth } from "../lib/production-bot-monitor.mjs";
import { createSnapshotService } from "../lib/sync/snapshots.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";

const now = 1_800_000_000_000;

function read(snapshotType, aggregateId, payload, {
  generatedAt = now - 10_000,
  available = true,
  degraded = false,
  lastKnownGood = false,
} = {}) {
  return {
    available,
    snapshot: available || lastKnownGood
      ? {
          snapshotType,
          aggregateId,
          snapshotVersion: 1,
          checksum: `${snapshotType}-checksum`,
          generatedAt,
          payload,
        }
      : null,
    metadata: {
      provider: "supabase",
      freshness: available ? "fresh" : "unavailable",
      degraded,
      lastKnownGood,
    },
    attempts: ["supabase"],
  };
}

function healthyReads(overrides = {}) {
  const runtimePayload = {
    botStatus: "RUNNING",
    botHeartbeatAt: now - 5_000,
    workerStatus: "RUNNING",
    workerHeartbeatAt: now - 4_000,
    sqliteStatus: "HEALTHY",
    ...(overrides.runtimePayload ?? {}),
  };
  const syncPayload = {
    providers: [
      {
        providerId: "supabase",
        required: true,
        enabled: true,
        status: "HEALTHY",
        circuit: "CLOSED",
        pending: 0,
        retry: 0,
        deadLetter: 0,
        lastSuccessAt: now - 3_000,
      },
      {
        providerId: "turso",
        required: true,
        enabled: true,
        status: "HEALTHY",
        circuit: "CLOSED",
        pending: 0,
        retry: 0,
        deadLetter: 0,
        lastSuccessAt: now - 2_000,
      },
      {
        providerId: "neon",
        required: false,
        enabled: false,
        status: "DISABLED",
        circuit: "CLOSED",
      },
    ],
    ...(overrides.syncPayload ?? {}),
  };
  return {
    runtimeRead: read("runtime", "nuviloview-bot", runtimePayload, overrides.runtimeRead),
    syncRead: read("sync_status", "nuviloview-sync", syncPayload, overrides.syncRead),
  };
}

test("fresh Bot, Worker, SQLite, Supabase and Turso snapshots are healthy", () => {
  const result = evaluateProjectionBotHealth({ ...healthyReads(), at: now });
  assert.equal(result.available, true);
  assert.equal(result.state, "Healthy");
  assert.equal(result.reason, "runtime_healthy");
});

test("Worker refresh cannot keep a crashed Bot heartbeat alive", () => {
  const result = evaluateProjectionBotHealth({
    ...healthyReads({
      runtimePayload: {
        botHeartbeatAt: now - 181_000,
        workerHeartbeatAt: now - 1_000,
      },
    }),
    at: now,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "bot_heartbeat_stale");
});

test("stopped Bot, stale Worker, unhealthy SQLite and LKG-only data stay down", () => {
  const cases = [
    [healthyReads({ runtimePayload: { botStatus: "STOPPED" } }), "bot_not_running"],
    [healthyReads({ runtimePayload: { workerHeartbeatAt: now - 181_000 } }), "worker_heartbeat_stale"],
    [healthyReads({ runtimePayload: { sqliteStatus: "UNHEALTHY" } }), "sqlite_unhealthy"],
    [healthyReads({ runtimeRead: { available: false, lastKnownGood: true } }), "projection_unavailable"],
  ];
  for (const [input, reason] of cases) {
    const result = evaluateProjectionBotHealth({ ...input, at: now });
    assert.equal(result.available, false);
    assert.equal(result.reason, reason);
  }
});

test("a fresh Turso fallback is Warning, not a false outage", () => {
  const input = healthyReads();
  input.runtimeRead.metadata.provider = "turso";
  input.syncRead.metadata.provider = "turso";
  input.runtimeRead.attempts = ["supabase", "turso"];
  input.syncRead.attempts = ["supabase", "turso"];
  const result = evaluateProjectionBotHealth({ ...input, at: now });
  assert.equal(result.available, true);
  assert.equal(result.state, "Warning");
});

test("Bot and Worker update independent local liveness timestamps", (t) => {
  const storage = createLocalStorage({ databasePath: ":memory:" });
  t.after(() => storage.close());
  const snapshots = createSnapshotService(storage, { now: () => 10_000 });

  snapshots.writeRuntimeSnapshot({ botStatus: "RUNNING" }, 1_000);
  snapshots.writeRuntimeSnapshot({ workerStatus: "RUNNING" }, 2_000);
  let current = storage.snapshots.get("runtime", "nuviloview-bot");
  assert.equal(current.payload.botStatus, "RUNNING");
  assert.equal(current.payload.botHeartbeatAt, 1_000);
  assert.equal(current.payload.workerStatus, "RUNNING");
  assert.equal(current.payload.workerHeartbeatAt, 2_000);

  snapshots.writeRuntimeSnapshot({ workerStatus: "RUNNING" }, 3_000);
  current = storage.snapshots.get("runtime", "nuviloview-bot");
  assert.equal(current.payload.botHeartbeatAt, 1_000);
  assert.equal(current.payload.workerHeartbeatAt, 3_000);
});

test("Production monitor prefers Projection health and preserves strict token handling", () => {
  const route = readFileSync(
    new URL("../app/api/monitor/bot/route.ts", import.meta.url),
    "utf8",
  );
  const bot = readFileSync(new URL("../discord-bot.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(
    new URL("../.github/workflows/production-monitor.yml", import.meta.url),
    "utf8",
  );
  assert.ok(route.indexOf("withWebReadRouter") < route.indexOf("await import('@/lib/db')"));
  assert.match(route, /evaluateProjectionBotHealth/);
  assert.match(route, /new NextResponse\('Not Found', \{ status: 404/);
  assert.match(bot, /writeRuntimeSnapshot\(\{[\s\S]*botHeartbeatAt: Date\.now\(\)/);
  assert.match(workflow, /jq -e '\.status == "ok"'/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});
