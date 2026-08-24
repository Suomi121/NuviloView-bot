import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLOUD_DATABASE_STATE,
  CloudDatabaseUnavailableError,
  createCloudDatabase,
} from "../lib/cloud-database.mjs";

function fakeNeon(handler) {
  return () => {
    const sql = (strings, ...values) => handler({ kind: "tag", strings, values });
    sql.query = (text, parameters) => handler({ kind: "query", text, parameters });
    return sql;
  };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("Neon not configured remains explicit and performs no query", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let factoryCalls = 0;
  const cloud = createCloudDatabase({
    connectionString: null,
    neonFactory: () => {
      factoryCalls += 1;
    },
    cwd: root,
    logger: silentLogger(),
  });

  assert.equal(await cloud.probe({ force: true }), false);
  assert.equal(cloud.getStatus().neon, CLOUD_DATABASE_STATE.NOT_CONFIGURED);
  assert.equal(cloud.getStatus().runtimeMode, "DEGRADED");
  await assert.rejects(
    cloud.sql`SELECT 1`,
    (error) => error instanceof CloudDatabaseUnavailableError &&
      error.code === "CLOUD_DATABASE_NOT_CONFIGURED",
  );
  assert.equal(factoryCalls, 0);
});

test("configured and available Neon enters NORMAL mode", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-online-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let queryCalls = 0;
  const cloud = createCloudDatabase({
    connectionString: "postgresql://example.invalid/test",
    neonFactory: fakeNeon(async () => {
      queryCalls += 1;
      return [{ connected: 1 }];
    }),
    cwd: root,
    logger: silentLogger(),
  });

  assert.equal(await cloud.probe({ force: true }), true);
  assert.equal(queryCalls, 1);
  assert.equal(cloud.isAvailable(), true);
  assert.equal(cloud.getStatus().runtimeMode, "NORMAL");
});

test("invalid Neon client initialization degrades instead of crashing startup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-client-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cloud = createCloudDatabase({
    connectionString: "not-a-valid-postgres-url",
    neonFactory: () => {
      throw new Error("invalid connection string");
    },
    cwd: root,
    logger: silentLogger(),
  });

  assert.equal(await cloud.probe({ force: true }), false);
  assert.equal(cloud.getStatus().configured, true);
  assert.equal(cloud.getStatus().neon, CLOUD_DATABASE_STATE.OFFLINE);
  await assert.rejects(cloud.sql`SELECT 1`, {
    code: "CLOUD_DATABASE_OFFLINE",
  });
});

test("one outage opens the guard and suppresses a query storm", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-offline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  let networkCalls = 0;
  const cloud = createCloudDatabase({
    connectionString: "postgresql://example.invalid/test",
    neonFactory: fakeNeon(async () => {
      networkCalls += 1;
      const error = new Error("network unavailable");
      error.code = "ENETUNREACH";
      throw error;
    }),
    env: {
      DATABASE_URL: "configured",
      NEON_DEGRADED_PROBE_BASE_SECONDS: "5",
      NEON_DEGRADED_PROBE_MAX_SECONDS: "30",
    },
    cwd: root,
    now: () => now,
    logger: silentLogger(),
  });

  assert.equal(await cloud.probe({ force: true }), false);
  assert.equal(cloud.getStatus().neon, CLOUD_DATABASE_STATE.OFFLINE);
  for (let index = 0; index < 25; index += 1) {
    await assert.rejects(cloud.sql`SELECT ${index}`, CloudDatabaseUnavailableError);
  }
  assert.equal(networkCalls, 1);
  assert.equal(cloud.getStatus().suppressedQueries, 25);
  assert.equal(cloud.canQuery(), false);
  now += 5_000;
  assert.equal(cloud.canQuery(), true);
});

test("OFFLINE automatically recovers after a bounded probe", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 10_000;
  let online = false;
  let calls = 0;
  const cloud = createCloudDatabase({
    connectionString: "postgresql://example.invalid/test",
    neonFactory: fakeNeon(async () => {
      calls += 1;
      if (!online) {
        const error = new Error("connection refused");
        error.code = "ECONNREFUSED";
        throw error;
      }
      return [{ connected: 1 }];
    }),
    env: {
      DATABASE_URL: "configured",
      NEON_DEGRADED_PROBE_BASE_SECONDS: "5",
      NEON_DEGRADED_PROBE_MAX_SECONDS: "30",
    },
    cwd: root,
    now: () => now,
    logger: silentLogger(),
  });

  assert.equal(await cloud.probe({ force: true }), false);
  online = true;
  assert.equal(await cloud.probe(), false);
  assert.equal(calls, 1);
  now += 5_000;
  assert.equal(await cloud.probe(), true);
  assert.equal(calls, 2);
  assert.equal(cloud.getStatus().neon, CLOUD_DATABASE_STATE.AVAILABLE);
  assert.equal(cloud.getStatus().consecutiveFailures, 0);
});

test("a non-transient SQL error does not misclassify healthy Neon as offline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-sql-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const cloud = createCloudDatabase({
    connectionString: "postgresql://example.invalid/test",
    neonFactory: fakeNeon(async () => {
      calls += 1;
      if (calls === 1) return [{ connected: 1 }];
      const error = new Error("duplicate key value violates unique constraint");
      error.code = "23505";
      throw error;
    }),
    cwd: root,
    logger: silentLogger(),
  });

  assert.equal(await cloud.probe({ force: true }), true);
  await assert.rejects(cloud.sql`INSERT INTO test VALUES (1)`, { code: "23505" });
  assert.equal(cloud.getStatus().neon, CLOUD_DATABASE_STATE.AVAILABLE);
});

test("feature error logging is independently rate limited", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-log-rate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100_000;
  const cloud = createCloudDatabase({
    connectionString: null,
    cwd: root,
    now: () => now,
    logger: silentLogger(),
    env: { NEON_DEGRADED_LOG_INTERVAL_SECONDS: "30" },
  });

  assert.equal(cloud.shouldLogFeature("messages"), true);
  assert.equal(cloud.shouldLogFeature("messages"), false);
  assert.equal(cloud.shouldLogFeature("reactions"), true);
  now += 30_000;
  assert.equal(cloud.shouldLogFeature("messages"), true);
});

test("runtime health file contains state but never the connection string", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nuvilo-cloud-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connectionString = "postgresql://user:private-password@example.invalid/test";
  const statusPath = path.join(root, "runtime", "cloud.json");
  const cloud = createCloudDatabase({
    connectionString,
    neonFactory: fakeNeon(async () => [{ connected: 1 }]),
    env: {
      DATABASE_URL: connectionString,
      NUVILOVIEW_RUNTIME_STATUS_PATH: statusPath,
    },
    cwd: root,
    logger: silentLogger(),
  });

  await cloud.probe({ force: true });
  cloud.updateRuntimeDetails({ messageStorage: "LEGACY_NEON" });
  const text = await readFile(statusPath, "utf8");
  const value = JSON.parse(text);
  assert.equal(value.neon, "AVAILABLE");
  assert.equal(value.messageStorage, "LEGACY_NEON");
  assert.doesNotMatch(text, /private-password|postgresql:\/\//);
});

test("Bot and Termux contracts expose explicit degraded behavior", async () => {
  const [bot, runner, preflight, status] = await Promise.all([
    readFile(new URL("../discord-bot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../Android/run-bot-forever.sh", import.meta.url), "utf8"),
    readFile(new URL("../Android/termux-preflight.sh", import.meta.url), "utf8"),
    readFile(new URL("../Android/status-nuviloview.sh", import.meta.url), "utf8"),
  ]);

  assert.match(bot, /createCloudDatabase/);
  assert.match(bot, /Discord is connected in DEGRADED mode/);
  assert.match(bot, /messagePersistence[\s\S]*UNAVAILABLE/);
  assert.doesNotMatch(bot, /DATABASE_URL and NUVILOVIEW_BOT_TOKEN must be set/);
  assert.doesNotMatch(
    runner,
    /for name in DATABASE_URL NUVILOVIEW_CLIENT_ID NUVILOVIEW_BOT_TOKEN/,
  );
  assert.match(preflight, /neon=not_configured_bot_will_start_degraded/);
  assert.match(status, /Runtime Mode:/);
  assert.match(status, /Cross-Host Leadership:/);
});
