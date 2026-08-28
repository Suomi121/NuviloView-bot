import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildRuntimeReadModel } from "../lib/runtime-read-model.mjs";
import {
  createWebReadRouter,
  isWebReadFallbackError,
  resetWebReadMetricsForTests,
} from "../lib/web-read-router.mjs";

const guildId = "1542212573389127723";
const now = 1_800_000;

function snapshot({
  provider,
  aggregateId = `v2:guild:${guildId}:current`,
  snapshotType = "analytics",
  generatedAt = now - 1_000,
  payload = {},
} = {}) {
  return {
    snapshotType,
    aggregateId,
    snapshotVersion: 3,
    payload: {
      schemaVersion: 3,
      lastUpdatedAt: generatedAt,
      nextUpdateAt: generatedAt + 900_000,
      ...payload,
    },
    checksum: `${provider ?? "provider"}:${aggregateId}`,
    generatedAt,
    syncedAt: generatedAt,
  };
}

function fakeProvider(id, options = {}) {
  const calls = { read: [], list: [] };
  return {
    id,
    calls,
    isEnabled: () => options.enabled !== false,
    async readSnapshot(input) {
      calls.read.push(input);
      if (options.readError) throw options.readError;
      if (typeof options.readSnapshot === "function") return options.readSnapshot(input);
      return options.current ?? snapshot({ provider: id, ...input });
    },
    async listSnapshots(input) {
      calls.list.push(input);
      if (options.listError) throw options.listError;
      return options.snapshots ?? [
        snapshot({
          provider: id,
          aggregateId: `v2:guild:${guildId}:daily:2026-08-28`,
          payload: { projection: "guild_daily", dateUtc: "2026-08-28", messageCount: 3 },
        }),
      ];
    },
  };
}

function registry(providers) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return { get: (id) => byId.get(id) ?? null };
}

test.beforeEach(() => resetWebReadMetricsForTests());

test("Supabase is the canonical Projection read and Turso is not queried", async () => {
  const supabase = fakeProvider("supabase");
  const turso = fakeProvider("turso");
  const router = createWebReadRouter({ registry: registry([supabase, turso]), now: () => now });
  const result = await router.readAnalyticsBundle({
    guildId,
    dateFrom: "2026-08-01",
    dateTo: "2026-08-28",
  });
  assert.equal(result.metadata.provider, "supabase");
  assert.equal(result.metadata.freshness, "fresh");
  assert.equal(supabase.calls.read.length, 1);
  assert.equal(supabase.calls.list.length, 1);
  assert.equal(turso.calls.read.length, 0);
  assert.equal(router.getMetrics().supabaseReads, 1);
  assert.equal(router.getMetrics().rawAnalyticsQueries, 0);
});

test("Supabase network failure falls back to Turso without weakening fatal errors", async () => {
  const networkError = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNRESET" },
  });
  const supabase = fakeProvider("supabase", { readError: networkError });
  const turso = fakeProvider("turso");
  const router = createWebReadRouter({ registry: registry([supabase, turso]), now: () => now });
  const result = await router.readAnalyticsBundle({ guildId });
  assert.equal(result.metadata.provider, "turso");
  assert.deepEqual(result.attempts, ["supabase", "turso"]);
  assert.equal(router.getMetrics().tursoFallbackReads, 1);
  assert.equal(router.getMetrics().readFailures, 1);

  assert.equal(isWebReadFallbackError(networkError), true);
  assert.equal(isWebReadFallbackError(Object.assign(new Error("bad schema"), { code: "42P01" })), false);
  assert.equal(isWebReadFallbackError(new TypeError("Invalid Projection contract")), false);
});

test("Turso failure does not affect a healthy Supabase read", async () => {
  const supabase = fakeProvider("supabase");
  const turso = fakeProvider("turso", { readError: new Error("offline") });
  const router = createWebReadRouter({ registry: registry([supabase, turso]), now: () => now });
  const result = await router.readAnalyticsBundle({ guildId });
  assert.equal(result.metadata.provider, "supabase");
  assert.equal(turso.calls.read.length, 0);
});

test("both providers unavailable returns an explicit degraded result", async () => {
  const error = Object.assign(new Error("offline"), { code: "ETIMEDOUT" });
  const router = createWebReadRouter({
    registry: registry([
      fakeProvider("supabase", { readError: error }),
      fakeProvider("turso", { readError: error }),
    ]),
    now: () => now,
  });
  const result = await router.readAnalyticsBundle({ guildId });
  assert.equal(result.available, false);
  assert.equal(result.metadata.freshness, "unavailable");
  assert.equal(result.metadata.degraded, true);
  assert.equal(router.getMetrics().degradedResponses, 1);
});

test("bounded Projection reads never hide a possible row-limit truncation", async () => {
  const provider = fakeProvider("supabase");
  const router = createWebReadRouter({ registry: registry([provider]), now: () => now });
  const result = await router.readAnalyticsBundle({ guildId, limit: 1 });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.degraded, true);
  assert.equal(router.getMetrics().degradedResponses, 1);
});

test("Last Known Good is retained but is clearly marked very stale", async () => {
  let unavailable = false;
  const provider = fakeProvider("supabase", {
    readSnapshot(input) {
      if (unavailable) throw Object.assign(new Error("offline"), { code: "ENETUNREACH" });
      return snapshot({ provider: "supabase", ...input });
    },
  });
  const router = createWebReadRouter({ registry: registry([provider]), now: () => now });
  const first = await router.readAnalyticsBundle({ guildId });
  unavailable = true;
  const degraded = await router.readAnalyticsBundle({ guildId });
  assert.equal(first.available, true);
  assert.equal(degraded.available, false);
  assert.equal(degraded.snapshots.length, first.snapshots.length);
  assert.equal(degraded.metadata.freshness, "very_stale");
  assert.equal(degraded.metadata.degraded, true);
});

test("Guild validation occurs before any Provider call", async () => {
  const supabase = fakeProvider("supabase");
  const router = createWebReadRouter({ registry: registry([supabase]), now: () => now });
  await assert.rejects(() => router.readAnalyticsBundle({ guildId: "other-guild" }), TypeError);
  assert.equal(supabase.calls.read.length, 0);
});

test("canonical point-read methods produce exact Projection keys and Neon stays OFF", async () => {
  const supabase = fakeProvider("supabase");
  const neon = fakeProvider("neon");
  const router = createWebReadRouter({
    registry: registry([supabase, neon]),
    now: () => now,
    neonCompatibilityEnabled: false,
  });
  await router.readGuildCurrent(guildId);
  await router.readGuildDaily(guildId, "2026-08-28");
  await router.readChannelDaily(guildId, "1507737783404462130", "2026-08-28");
  await router.readUserDaily(guildId, "1489038702377435149", "2026-08-28");
  assert.deepEqual(supabase.calls.read.map((call) => call.aggregateId), [
    `v2:guild:${guildId}:current`,
    `v2:guild:${guildId}:daily:2026-08-28`,
    `v2:guild:${guildId}:channel:1507737783404462130:daily:2026-08-28`,
    `v2:guild:${guildId}:user:1489038702377435149:daily:2026-08-28`,
  ]);
  assert.equal(neon.calls.read.length, 0);
});

test("runtime model reports Provider circuits and a real required-replica sync timestamp", () => {
  const readResult = (snapshotType, aggregateId, payload) => ({
    available: true,
    snapshot: snapshot({ provider: "supabase", snapshotType, aggregateId, payload }),
    metadata: { provider: "supabase", freshness: "fresh", degraded: false },
    attempts: ["supabase"],
  });
  const model = buildRuntimeReadModel({
    runtimeRead: readResult("runtime", "nuviloview-bot", {
      botStatus: "RUNNING",
      workerStatus: "RUNNING",
      sqliteStatus: "HEALTHY",
    }),
    syncRead: readResult("sync_status", "nuviloview-sync", {
      providers: [
        { providerId: "supabase", required: true, enabled: true, status: "HEALTHY", circuit: "CLOSED", lastSuccessAt: 1_700_000 },
        { providerId: "turso", required: true, enabled: true, status: "HEALTHY", circuit: "CLOSED", lastSuccessAt: 1_600_000 },
        { providerId: "neon", required: false, enabled: false, status: "DISABLED", circuit: "CLOSED" },
      ],
    }),
    at: now,
  });
  assert.equal(model.overallStatus, "HEALTHY");
  assert.equal(model.lastSuccessfulSync, 1_600_000);
  assert.equal(model.providers.find((provider) => provider.providerId === "supabase").circuit, "CLOSED");
  assert.equal(model.providers.find((provider) => provider.providerId === "neon").status, "OFF");
});

test("migrated Web routes contain no Raw Cloud analytics query", () => {
  const paths = [
    "../app/backend/status/route.ts",
    "../app/api/analytics/community/route.ts",
    "../app/api/analytics/snapshot/route.ts",
    "../app/api/analytics/runtime/route.ts",
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /isAuthorizedGuild/);
    assert.doesNotMatch(
      source,
      /discord_message|discord_reaction_event|voice_session|guild_member_event|message_event_log|pool\.query|new Pool/i,
    );
  }
});

test("Analytics browser refresh is projection-scheduled while runtime polling stays isolated", () => {
  const dashboard = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
  const countdown = readFileSync(new URL("../components/analytics-refresh-countdown.tsx", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../components/runtime-provider-status.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /nextRefreshAt/);
  assert.doesNotMatch(dashboard, /setInterval\(\(\) =>[\s\S]{0,200}load\("auto"\)[\s\S]{0,80}60_000/);
  assert.match(countdown, /setTimeout/);
  assert.match(countdown, /visibilitychange/);
  assert.match(runtime, /setInterval/);
  assert.match(runtime, /60_000/);
});
