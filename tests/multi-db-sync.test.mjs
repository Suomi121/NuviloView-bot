import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "pg";
import { createLocalStorage } from "../lib/storage/index.mjs";
import { createCloudReadRouter } from "../lib/sync/cloud-read-router.mjs";
import { calculateEnvelopeChecksum } from "../lib/sync/conflict-policy.mjs";
import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { MultiProviderSyncWorker } from "../lib/sync/multi-worker.mjs";
import {
  getProviderPolicyDefinitions,
  SYNC_PROVIDER_POLICIES,
} from "../lib/sync/providers/contract.mjs";
import { createPostgresProviderAdapter } from "../lib/sync/providers/postgres.mjs";
import { createProviderRegistry } from "../lib/sync/providers/registry.mjs";
import { createTursoProviderAdapter } from "../lib/sync/providers/turso.mjs";
import {
  replicaSchemaColumns,
  replicaSchemaIndexes,
} from "../lib/sync/providers/shared.mjs";
import { classifySyncError } from "../lib/sync/retry.mjs";

const baseEnv = Object.freeze({
  MULTI_DB_SYNC_ENABLED: "true",
  SYNC_WORKER_ENABLED: "true",
  SYNC_SUPABASE_ENABLED: "true",
  SUPABASE_DATABASE_URL: "postgresql://isolated.invalid/replica",
  SYNC_TURSO_ENABLED: "true",
  TURSO_DATABASE_URL: "libsql://isolated.invalid",
  TURSO_AUTH_TOKEN: "test-placeholder",
  SYNC_NEON_ENABLED: "false",
  SYNC_CIRCUIT_FAILURE_THRESHOLD: "1",
  SYNC_CIRCUIT_OPEN_MS: "1000",
  SYNC_PROVIDER_BATCH_MIN: "25",
  SYNC_PROVIDER_BATCH_MAX: "100",
});

function createStorage(env = baseEnv, options = {}) {
  return createLocalStorage({
    databasePath: ":memory:",
    providerDefinitions: getProviderPolicyDefinitions(env),
    ...options,
  });
}

function envelope(eventId, createdAt = 1_000, payload = { guildId: "100" }) {
  const item = {
    eventId,
    domain: "bot_event",
    eventType: "message_create",
    aggregateId: `message:${eventId}`,
    payload,
    schemaVersion: 1,
    priority: 0,
    createdAt,
    availableAt: createdAt,
  };
  return { ...item, checksum: calculateEnvelopeChecksum(item) };
}

function fakeProvider(id, { required, failures = 0 } = {}) {
  const state = {
    eventCalls: 0,
    snapshotCalls: 0,
    failures,
    events: new Map(),
    snapshots: new Map(),
  };
  return {
    id,
    required,
    state,
    isEnabled: () => true,
    async pushEvents(items) {
      state.eventCalls += 1;
      if (state.failures > 0) {
        state.failures -= 1;
        throw Object.assign(new Error(`${id} network unavailable`), {
          code: "ECONNREFUSED",
        });
      }
      for (const item of items) {
        const current = state.events.get(item.eventId);
        if (current && current !== item.checksum) {
          throw Object.assign(new Error("checksum conflict"), {
            code: "SYNC_CHECKSUM_MISMATCH",
          });
        }
        state.events.set(item.eventId, item.checksum);
      }
      return {
        succeededEventIds: items.map((item) => item.eventId),
        failed: [],
        queryCount: 1,
      };
    },
    async pushSnapshots(items) {
      state.snapshotCalls += 1;
      if (state.failures > 0) {
        state.failures -= 1;
        throw Object.assign(new Error(`${id} network unavailable`), {
          code: "ECONNREFUSED",
        });
      }
      for (const item of items) state.snapshots.set(`${item.snapshotType}:${item.aggregateId}`, item);
      return {
        succeededSnapshotKeys: items.map(
          (item) => `${item.snapshotType}:${item.aggregateId}`,
        ),
        failed: [],
        queryCount: 1,
      };
    },
    async health() {
      return { status: "HEALTHY" };
    },
    async verifySchema() {
      return { ok: true, missing: [] };
    },
    async getRemoteCursor() {
      return { eventCount: state.events.size, sourceCursor: null };
    },
    async readSnapshot({ snapshotType, aggregateId }) {
      return state.snapshots.get(`${snapshotType}:${aggregateId}`) ?? null;
    },
    async getEventChecksums(eventIds) {
      return new Map(
        eventIds.filter((eventId) => state.events.has(eventId)).map(
          (eventId) => [eventId, state.events.get(eventId)],
        ),
      );
    },
    async close() {},
  };
}

function tursoFetchError(code = null) {
  const transport = new Error(code ? `transport ${code}` : "transport unavailable");
  if (code) transport.code = code;
  const fetchError = new TypeError("fetch failed");
  if (code) fetchError.cause = transport;
  const error = new Error("fetch failed");
  error.name = "LibsqlError";
  error.code = "EXECUTE_ERROR";
  error.cause = fetchError;
  return error;
}

function registry(providers) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => [...byId.values()],
    get: (providerId) => byId.get(providerId) ?? null,
  };
}

function createLibsqlTestClient() {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(new URL("../docs/sql/multi-db-turso-v1.sql", import.meta.url), "utf8"),
  );
  function execute(statement) {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const args = typeof statement === "string" ? [] : statement.args ?? [];
    const prepared = database.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
      return { rows: prepared.all(...args), rowsAffected: 0 };
    }
    const result = prepared.run(...args);
    return { rows: [], rowsAffected: Number(result.changes) };
  }
  return {
    execute: async (statement) => execute(statement),
    batch: async (statements) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}

test("Multi-DB feature flags default OFF and Provider policy is stable", () => {
  const config = getMultiDbSyncConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.snapshotEnabled, false);
  assert.deepEqual(config.providerDefinitions, []);
  assert.equal(SYNC_PROVIDER_POLICIES.supabase.required, true);
  assert.equal(SYNC_PROVIDER_POLICIES.turso.required, true);
  assert.equal(SYNC_PROVIDER_POLICIES.neon.required, false);
});

test("Outbox and all Provider delivery rows commit atomically", (t) => {
  const storage = createStorage();
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:atomic"));
  assert.deepEqual(
    storage.providerDeliveries
      .listForEvent("event:atomic")
      .map((item) => [item.providerId, item.required, item.status]),
    [
      ["neon", false, "disabled"],
      ["supabase", true, "pending"],
      ["turso", true, "pending"],
    ],
  );
  assert.throws(() =>
    storage.transaction(() => {
      storage.outbox.enqueue(envelope("event:rollback"));
      throw new Error("rollback");
    }),
  );
  assert.equal(storage.outbox.getByEventId("event:rollback"), null);
  assert.deepEqual(storage.providerDeliveries.listForEvent("event:rollback"), []);
});

test("Required Provider completion ignores optional Neon", (t) => {
  const storage = createStorage();
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:complete"));
  const claimAndSync = (providerId) => {
    const workerId = `worker-${providerId}`;
    const [item] = storage.providerDeliveries.claimBatch({
      providerId,
      workerId,
      limit: 1,
      lockTimeoutMs: 1_000,
      at: 1_000,
    });
    storage.providerDeliveries.markSynced(
      providerId,
      [{ eventId: item.eventId, checksum: item.checksum }],
      { workerId, at: 1_001 },
    );
  };
  claimAndSync("supabase");
  assert.equal(storage.providerDeliveries.isCloudComplete("event:complete"), false);
  assert.equal(storage.outbox.getByEventId("event:complete").status, "pending");
  claimAndSync("turso");
  assert.equal(storage.providerDeliveries.isCloudComplete("event:complete"), true);
  assert.equal(storage.outbox.getByEventId("event:complete").status, "synced");
  assert.equal(storage.providerDeliveries.get("event:complete", "neon").status, "disabled");
});

test("Outbox retention waits for both required replicas", (t) => {
  const storage = createStorage();
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:retention", 1_000));
  const claimAndSync = (providerId, at) => {
    const workerId = `worker-${providerId}`;
    const [item] = storage.providerDeliveries.claimBatch({
      providerId,
      workerId,
      limit: 1,
      lockTimeoutMs: 1_000,
      at,
    });
    storage.providerDeliveries.markSynced(
      providerId,
      [{ eventId: item.eventId, checksum: item.checksum }],
      { workerId, at },
    );
  };
  claimAndSync("supabase", 1_100);
  assert.equal(storage.outbox.purgeSynced({ olderThan: 9_000 }), 0);
  assert.ok(storage.outbox.getByEventId("event:retention"));
  claimAndSync("turso", 1_200);
  assert.equal(storage.outbox.purgeSynced({ olderThan: 9_000 }), 1);
  assert.equal(storage.outbox.getByEventId("event:retention"), null);
});

test("Provider failures, Circuits, Retry, and recovery are independent", async (t) => {
  let now = 10_000;
  const env = { ...baseEnv, SYNC_NEON_ENABLED: "true", DATABASE_URL: "offline" };
  const storage = createStorage(env, { now: () => now });
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:independent", now));
  const supabase = fakeProvider("supabase", { required: true, failures: 1 });
  const turso = fakeProvider("turso", { required: true });
  const neon = fakeProvider("neon", { required: false, failures: 10 });
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso, neon]),
    config: getMultiDbSyncConfig(env),
    now: () => now,
    random: () => 0.5,
    snapshotWriter: async () => {},
  });
  const first = await worker.processOnce();
  assert.equal(first.providers.find((item) => item.providerId === "turso").state, "synced");
  assert.equal(storage.providerDeliveries.get("event:independent", "supabase").status, "retry");
  assert.equal(storage.providerDeliveries.get("event:independent", "neon").status, "retry");
  assert.equal(storage.outbox.getByEventId("event:independent").status, "pending");
  assert.equal(turso.state.eventCalls, 1);

  now += 500;
  await worker.processOnce();
  assert.equal(supabase.state.eventCalls, 1, "OPEN Circuit must perform zero queries");
  assert.equal(neon.state.eventCalls, 1, "optional OPEN Circuit must perform zero queries");

  now += 1_000;
  await worker.processOnce();
  assert.equal(supabase.state.eventCalls, 2);
  assert.equal(storage.providerDeliveries.isCloudComplete("event:independent"), true);
  assert.equal(storage.outbox.getByEventId("event:independent").status, "synced");
  assert.equal(neon.state.eventCalls, 2);
});

test("All Cloud failures leave SQLite and Outbox durable", async (t) => {
  const env = { ...baseEnv, SYNC_NEON_ENABLED: "true", DATABASE_URL: "offline" };
  const storage = createStorage(env);
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:offline"));
  const providers = [
    fakeProvider("supabase", { required: true, failures: 10 }),
    fakeProvider("turso", { required: true, failures: 10 }),
    fakeProvider("neon", { required: false, failures: 10 }),
  ];
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry(providers),
    config: getMultiDbSyncConfig(env),
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(storage.outbox.getByEventId("event:offline").status, "pending");
  assert.equal(storage.providerDeliveries.listForEvent("event:offline").every(
    (delivery) => delivery.status === "retry",
  ), true);
});

test("Turso failure does not stop Supabase delivery", async (t) => {
  const storage = createStorage();
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:turso-offline"));
  const supabase = fakeProvider("supabase", { required: true });
  const turso = fakeProvider("turso", { required: true, failures: 10 });
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(baseEnv),
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(
    storage.providerDeliveries.get("event:turso-offline", "supabase").status,
    "synced",
  );
  assert.equal(
    storage.providerDeliveries.get("event:turso-offline", "turso").status,
    "retry",
  );
  assert.equal(storage.outbox.getByEventId("event:turso-offline").status, "pending");
});

test("Nested libSQL and Undici transport errors are transient without weakening permanent errors", () => {
  for (const code of [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ECONNREFUSED",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]) {
    assert.deepEqual(classifySyncError(tursoFetchError(code)), {
      kind: "transient",
      retryable: true,
      affectsCircuit: true,
    });
  }

  assert.deepEqual(classifySyncError(tursoFetchError()), {
    kind: "transient",
    retryable: true,
    affectsCircuit: true,
  });
  assert.deepEqual(classifySyncError(new TypeError("fetch failed")), {
    kind: "permanent",
    retryable: false,
    affectsCircuit: false,
  });
  assert.deepEqual(classifySyncError("network unavailable"), {
    kind: "transient",
    retryable: true,
    affectsCircuit: true,
  });

  for (const error of [
    Object.assign(new Error("Unauthorized"), { status: 401 }),
    Object.assign(new Error("invalid token"), { code: "AUTH_ERROR" }),
    Object.assign(new Error("malformed SQL"), { code: "SQL_PARSE_ERROR" }),
    Object.assign(new Error("schema mismatch"), { code: "SYNC_SCHEMA_MISMATCH" }),
    Object.assign(new Error("constraint violation"), { code: "23514" }),
    Object.assign(new Error("invalid payload"), { code: "SYNC_INVALID_PAYLOAD" }),
  ]) {
    assert.deepEqual(classifySyncError(error), {
      kind: "permanent",
      retryable: false,
      affectsCircuit: false,
    });
  }

  assert.deepEqual(
    classifySyncError(Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    })),
    { kind: "transient", retryable: true, affectsCircuit: true },
  );
});

test("Nested Turso fetch failure retries, opens its Circuit, and recovers without DLQ", async (t) => {
  let now = 30_000;
  const env = {
    ...baseEnv,
    SYNC_PROVIDER_BATCH_MIN: "1",
    SYNC_PROVIDER_BATCH_MAX: "1",
    SYNC_BATCH_GROWTH_STEP: "1",
    SYNC_CIRCUIT_HALF_OPEN_BATCH: "1",
    SYNC_RETRY_BASE_MS: "100",
    SYNC_RETRY_MAX_MS: "100",
    SYNC_RETRY_JITTER_RATIO: "0",
  };
  const storage = createStorage(env, { now: () => now });
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:turso-fetch-recovery", now));

  const supabase = fakeProvider("supabase", { required: true });
  const turso = fakeProvider("turso", { required: true });
  let tursoAvailable = false;
  let observedRecoveryState = null;
  let worker;
  turso.pushEvents = async (items) => {
    turso.state.eventCalls += 1;
    if (!tursoAvailable) throw tursoFetchError("ECONNRESET");
    observedRecoveryState = worker.status.providers.turso.circuit.state;
    return {
      succeededEventIds: items.map((item) => item.eventId),
      failed: [],
      queryCount: 1,
    };
  };
  worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(env),
    now: () => now,
    random: () => 0.5,
    snapshotWriter: async () => {},
  });

  await worker.processOnce();
  assert.equal(storage.providerDeliveries.get("event:turso-fetch-recovery", "supabase").status, "synced");
  assert.equal(storage.providerDeliveries.get("event:turso-fetch-recovery", "turso").status, "retry");
  assert.equal(storage.providerDeliveries.getProviderStatus("turso").deadLetter, 0);
  assert.equal(worker.status.providers.turso.circuit.state, "OPEN");
  assert.equal(worker.status.providers.supabase.circuit.state, "CLOSED");

  now += 500;
  await worker.processOnce();
  assert.equal(turso.state.eventCalls, 1, "OPEN Circuit must issue zero Turso queries");

  now += 501;
  tursoAvailable = true;
  await worker.processOnce();
  assert.equal(observedRecoveryState, "HALF_OPEN");
  assert.equal(worker.status.providers.turso.circuit.state, "CLOSED");
  assert.equal(storage.providerDeliveries.get("event:turso-fetch-recovery", "turso").status, "synced");
  assert.equal(storage.providerDeliveries.getProviderStatus("turso").deadLetter, 0);
  assert.equal(storage.outbox.getByEventId("event:turso-fetch-recovery").status, "synced");
});

test("Missing Provider credentials create only a degraded Provider, never an implicit pool", async () => {
  let poolCalls = 0;
  const env = {
    ...baseEnv,
    SUPABASE_DATABASE_URL: "",
    SYNC_TURSO_ENABLED: "false",
    SYNC_CIRCUIT_FAILURE_THRESHOLD: "10",
  };
  const config = getMultiDbSyncConfig(env);
  const registryInstance = await createProviderRegistry({
    config,
    poolFactory: () => {
      poolCalls += 1;
      throw new Error("must not be called");
    },
    logger: { warn() {} },
  });
  try {
    assert.equal(poolCalls, 0);
    assert.deepEqual(registryInstance.enabledProviderIds(), ["supabase"]);
    await assert.rejects(() => registryInstance.get("supabase").health(), {
      code: "SYNC_PROVIDER_CREDENTIALS_MISSING",
    });
    const storage = createStorage(env);
    try {
      storage.outbox.enqueue(envelope("event:missing-credentials"));
      const worker = new MultiProviderSyncWorker({
        storage,
        registry: registryInstance,
        config,
        snapshotWriter: async () => {},
      });
      await worker.processOnce();
      const providerStatus = storage.providerDeliveries.getProviderStatus("supabase");
      assert.equal(providerStatus.circuitState, "OPEN");
      assert.equal(providerStatus.queryCount, 0);
      assert.equal(
        storage.providerDeliveries.get("event:missing-credentials", "supabase").status,
        "retry",
      );
    } finally {
      storage.close();
    }
  } finally {
    await registryInstance.close();
  }
});

test("Missing replica schema is retryable and immediately stops Provider query storms", async (t) => {
  let now = 20_000;
  const env = {
    ...baseEnv,
    SYNC_CIRCUIT_FAILURE_THRESHOLD: "10",
    SYNC_CIRCUIT_OPEN_MS: "1000",
  };
  const storage = createStorage(env, { now: () => now });
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:schema-missing", now));
  const schemaMissing = fakeProvider("supabase", { required: true });
  schemaMissing.pushEvents = async () => {
    schemaMissing.state.eventCalls += 1;
    throw Object.assign(new Error('relation "replica_event" does not exist'), {
      code: "42P01",
    });
  };
  const turso = fakeProvider("turso", { required: true });
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([schemaMissing, turso]),
    config: getMultiDbSyncConfig(env),
    now: () => now,
    random: () => 0.5,
    snapshotWriter: async () => {},
  });

  assert.deepEqual(classifySyncError({ code: "42P01" }), {
    kind: "schema_unavailable",
    retryable: true,
    affectsCircuit: true,
  });
  await worker.processOnce();
  assert.equal(
    storage.providerDeliveries.get("event:schema-missing", "supabase").status,
    "retry",
  );
  assert.equal(worker.status.providers.supabase.circuit.state, "OPEN");

  now += 500;
  await worker.processOnce();
  assert.equal(schemaMissing.state.eventCalls, 1, "OPEN Circuit must issue zero queries");
  assert.equal(storage.outbox.getByEventId("event:schema-missing").status, "pending");
});

test("Supabase/PostgreSQL adapter batches and verifies idempotent checksums", async () => {
  const calls = [];
  const execute = async (sql, parameters) => {
    calls.push(sql);
    const records = JSON.parse(parameters[0]);
    return {
      rows: records.map((record) => ({
        event_id: record.event_id,
        checksum: record.checksum,
      })),
    };
  };
  const adapter = createPostgresProviderAdapter({
    id: "supabase",
    required: true,
    enabled: true,
    execute,
  });
  const item = envelope("event:postgres");
  const result = await adapter.pushEvents([item, item, item]);
  assert.deepEqual(result.succeededEventIds, [item.eventId, item.eventId, item.eventId]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /INSERT INTO replica_event/);
});

test("PostgreSQL schema verification detects required columns and indexes", async () => {
  let omitColumn = false;
  const adapter = createPostgresProviderAdapter({
    id: "supabase",
    required: true,
    enabled: true,
    execute: async (sql) => {
      if (sql.includes("information_schema.columns")) {
        return {
          rows: Object.entries(replicaSchemaColumns).flatMap(([tableName, columns]) =>
            columns
              .filter(
                (columnName) =>
                  !(omitColumn && tableName === "analytics_snapshot" && columnName === "checksum"),
              )
              .map((columnName) => ({
                table_name: tableName,
                column_name: columnName,
              })),
          ),
        };
      }
      if (sql.includes("pg_indexes")) {
        return { rows: replicaSchemaIndexes.map((indexname) => ({ indexname })) };
      }
      throw new Error("Unexpected schema verification query");
    },
  });
  assert.equal((await adapter.verifySchema()).ok, true);
  omitColumn = true;
  const drift = await adapter.verifySchema();
  assert.equal(drift.ok, false);
  assert.ok(drift.missing.includes("column:analytics_snapshot.checksum"));
});

test(
  "Multi-DB PostgreSQL schema and Supabase adapter pass on an isolated database",
  { skip: !process.env.TEST_MULTI_DB_POSTGRES_URL },
  async (t) => {
    const client = new Client({
      connectionString: process.env.TEST_MULTI_DB_POSTGRES_URL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      application_name: "nuviloview-multi-db-test",
    });
    await client.connect();
    const schema = `multi_db_${process.pid}_${Date.now()}`;
    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    });
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      readFileSync(
        new URL("../docs/sql/multi-db-supabase-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    const adapter = createPostgresProviderAdapter({
      id: "supabase",
      required: true,
      enabled: true,
      execute: (sql, parameters) => client.query(sql, parameters),
    });
    assert.equal((await adapter.verifySchema()).ok, true);

    const item = envelope("event:isolated-postgres", 40_000, { value: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual((await adapter.pushEvents([item])).succeededEventIds, [item.eventId]);
    }
    const eventCount = await client.query(
      "SELECT COUNT(*)::integer AS count FROM replica_event WHERE event_id = $1",
      [item.eventId],
    );
    assert.equal(eventCount.rows[0].count, 1);

    await adapter.pushSnapshots([
      {
        snapshotType: "analytics",
        aggregateId: "guild:isolated-postgres",
        snapshotVersion: 2,
        payload: { messages: 2 },
        checksum: "postgres-v2",
        generatedAt: 42_000,
      },
    ]);
    await assert.rejects(
      () =>
        adapter.pushSnapshots([
          {
            snapshotType: "analytics",
            aggregateId: "guild:isolated-postgres",
            snapshotVersion: 1,
            payload: { messages: 1 },
            checksum: "postgres-v1",
            generatedAt: 41_000,
          },
        ]),
      { code: "SYNC_CHECKSUM_MISMATCH" },
    );
    const snapshot = await adapter.readSnapshot({
      snapshotType: "analytics",
      aggregateId: "guild:isolated-postgres",
    });
    assert.equal(snapshot.snapshotVersion, 2);
    assert.deepEqual(snapshot.payload, { messages: 2 });
    const snapshotStates = await adapter.getSnapshotStates([
      { snapshotType: "analytics", aggregateId: "guild:isolated-postgres" },
      { snapshotType: "analytics", aggregateId: "guild:missing" },
    ]);
    assert.deepEqual(snapshotStates.get("analytics:guild:isolated-postgres"), {
      snapshotVersion: 2,
      checksum: "postgres-v2",
    });
    assert.equal(snapshotStates.has("analytics:guild:missing"), false);
  },
);

test("Turso adapter uses one transactional batch and rejects conflicts/stale snapshots", async (t) => {
  const client = createLibsqlTestClient();
  t.after(() => client.close());
  const adapter = createTursoProviderAdapter({ enabled: true, client });
  const first = envelope("event:turso", 1_000, { value: 1 });
  for (let index = 0; index < 3; index += 1) {
    const result = await adapter.pushEvents([first]);
    assert.deepEqual(result.succeededEventIds, [first.eventId]);
  }
  const conflict = envelope("event:turso", 1_000, { value: 2 });
  await assert.rejects(() => adapter.pushEvents([conflict]), {
    code: "SYNC_CHECKSUM_MISMATCH",
  });

  await adapter.pushSnapshots([
    {
      snapshotType: "analytics",
      aggregateId: "guild:1",
      snapshotVersion: 2,
      payload: { messages: 2 },
      checksum: "checksum-v2",
      generatedAt: 2_000,
    },
  ]);
  await assert.rejects(
    () =>
      adapter.pushSnapshots([
        {
          snapshotType: "analytics",
          aggregateId: "guild:1",
          snapshotVersion: 1,
          payload: { messages: 1 },
          checksum: "checksum-v1",
          generatedAt: 1_000,
        },
      ]),
    { code: "SYNC_CHECKSUM_MISMATCH" },
  );
  const stored = await adapter.readSnapshot({
    snapshotType: "analytics",
    aggregateId: "guild:1",
  });
  assert.equal(stored.snapshotVersion, 2);
  assert.deepEqual(stored.payload, { messages: 2 });
  const snapshotStates = await adapter.getSnapshotStates([
    { snapshotType: "analytics", aggregateId: "guild:1" },
    { snapshotType: "analytics", aggregateId: "guild:missing" },
  ]);
  assert.deepEqual(snapshotStates.get("analytics:guild:1"), {
    snapshotVersion: 2,
    checksum: "checksum-v2",
  });
  assert.equal(snapshotStates.has("analytics:guild:missing"), false);
  const schema = await adapter.verifySchema();
  assert.equal(schema.ok, true);
  await client.execute("DROP INDEX analytics_snapshot_generated_idx");
  const drift = await adapter.verifySchema();
  assert.equal(drift.ok, false);
  assert.ok(drift.missing.includes("index:analytics_snapshot_generated_idx"));
});

test("Snapshots skip unchanged payloads and required replicas clear Dirty", async (t) => {
  const env = { ...baseEnv, SYNC_SNAPSHOT_ENABLED: "true" };
  const storage = createStorage(env);
  t.after(() => storage.close());
  const first = storage.snapshots.upsert({
    snapshotType: "guild_status",
    aggregateId: "guild:1",
    payload: { memberCount: 10 },
    generatedAt: 1_000,
  });
  const unchanged = storage.snapshots.upsert({
    snapshotType: "guild_status",
    aggregateId: "guild:1",
    payload: { memberCount: 10 },
    generatedAt: 2_000,
  });
  assert.equal(first.changed, true);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.snapshotVersion, 1);
  const supabase = fakeProvider("supabase", { required: true });
  const turso = fakeProvider("turso", { required: true });
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(env),
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(storage.snapshots.get("guild_status", "guild:1").dirty, false);
  const changed = storage.snapshots.upsert({
    snapshotType: "guild_status",
    aggregateId: "guild:1",
    payload: { memberCount: 11 },
    generatedAt: 3_000,
  });
  assert.equal(changed.snapshotVersion, 2);
  assert.equal(changed.dirty, true);
});

test("Snapshot Provider failure is isolated and recovers independently", async (t) => {
  let now = 30_000;
  const env = {
    ...baseEnv,
    SYNC_SNAPSHOT_ENABLED: "true",
    SYNC_SNAPSHOT_INTERVAL_MS: "10000",
  };
  const storage = createStorage(env, { now: () => now });
  t.after(() => storage.close());
  storage.snapshots.upsert({
    snapshotType: "guild_status",
    aggregateId: "guild:isolated",
    payload: { memberCount: 42 },
    generatedAt: now,
  });
  const supabase = fakeProvider("supabase", { required: true });
  const turso = fakeProvider("turso", { required: true, failures: 1 });
  const worker = new MultiProviderSyncWorker({
    storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(env),
    now: () => now,
    random: () => 0.5,
    snapshotWriter: async () => {},
  });

  await worker.processOnce();
  assert.equal(supabase.state.snapshotCalls, 1);
  assert.equal(turso.state.snapshotCalls, 1);
  assert.equal(storage.snapshots.get("guild_status", "guild:isolated").dirty, true);

  now += 500;
  await worker.processOnce();
  assert.equal(turso.state.snapshotCalls, 1, "Turso OPEN Circuit must issue zero queries");

  now += 500;
  await worker.processOnce();
  assert.equal(turso.state.snapshotCalls, 2);
  assert.equal(storage.snapshots.get("guild_status", "guild:isolated").dirty, false);
});

test("Cloud Read Router prefers fresh Supabase and falls back with freshness metadata", async () => {
  let now = 10_000;
  const calls = { supabase: 0, turso: 0, neon: 0 };
  const provider = (id, generatedAt, fail = false) => ({
    id,
    isEnabled: () => true,
    async readSnapshot() {
      calls[id] += 1;
      if (fail) throw new Error("offline");
      return {
        snapshotType: "analytics",
        aggregateId: "guild:1",
        snapshotVersion: 1,
        payload: { source: id },
        checksum: id,
        generatedAt,
        syncedAt: generatedAt,
      };
    },
  });
  let providers = registry([
    provider("supabase", 9_900),
    provider("turso", 9_950),
    provider("neon", 9_975),
  ]);
  let router = createCloudReadRouter({ registry: providers, now: () => now });
  const preferred = await router.readSnapshot({
    snapshotType: "analytics",
    aggregateId: "guild:1",
  });
  assert.equal(preferred.source, "supabase");
  assert.equal(preferred.fresh, true);
  assert.deepEqual(calls, { supabase: 1, turso: 0, neon: 0 });

  providers = registry([
    provider("supabase", 1_000),
    provider("turso", 9_950),
    provider("neon", 9_975),
  ]);
  router = createCloudReadRouter({ registry: providers, now: () => now });
  const fallback = await router.readSnapshot({
    snapshotType: "analytics",
    aggregateId: "guild:1",
    maxAgeMs: 500,
  });
  assert.equal(fallback.source, "turso");
  assert.equal(fallback.dataAgeMs, 50);
  assert.equal(fallback.cloudSyncDelayed, false);

  const cachedCalls = { supabase: 0, turso: 0 };
  const cachedRegistry = registry([
    {
      id: "supabase",
      isEnabled: () => true,
      async readSnapshot() {
        cachedCalls.supabase += 1;
        throw new Error("offline");
      },
    },
    {
      id: "turso",
      isEnabled: () => true,
      async readSnapshot() {
        cachedCalls.turso += 1;
        return {
          snapshotType: "analytics",
          aggregateId: "guild:1",
          snapshotVersion: 1,
          payload: {},
          checksum: "turso",
          generatedAt: 9_990,
          syncedAt: 9_995,
        };
      },
    },
  ]);
  router = createCloudReadRouter({
    registry: cachedRegistry,
    now: () => now,
    failureCacheMs: 10_000,
  });
  await router.readSnapshot({ snapshotType: "analytics", aggregateId: "guild:1" });
  await router.readSnapshot({ snapshotType: "analytics", aggregateId: "guild:1" });
  assert.deepEqual(cachedCalls, { supabase: 1, turso: 2 });
});

test("Backfill is bounded and only re-enables the explicit Provider", (t) => {
  const storage = createStorage();
  t.after(() => storage.close());
  for (let index = 0; index < 3; index += 1) {
    storage.outbox.enqueue(envelope(`event:backfill:${index}`, 1_000 + index));
  }
  storage.providerDeliveries.applyPolicy([
    { id: "supabase", required: true, enabled: false },
    { id: "turso", required: true, enabled: true },
    { id: "neon", required: false, enabled: false },
  ]);
  assert.equal(storage.providerDeliveries.planBackfill("supabase").disabled, 3);
  const result = storage.providerDeliveries.executeBackfill("supabase", {
    required: true,
    limit: 2,
  });
  assert.equal(result.queued, 2);
  assert.equal(storage.providerDeliveries.get("event:backfill:0", "turso").status, "pending");
  assert.equal(storage.providerDeliveries.planBackfill("supabase").disabled, 1);
});

test("Legacy global Dead Letter is never auto-delivered or bulk-backfilled", (t) => {
  const storage = createLocalStorage({
    databasePath: ":memory:",
    providerDefinitions: [],
  });
  t.after(() => storage.close());
  storage.outbox.enqueue(envelope("event:legacy-dead", 1_000));
  const [claimed] = storage.outbox.claimBatch({
    workerId: "legacy-worker",
    limit: 1,
    lockTimeoutMs: 1_000,
    at: 1_100,
  });
  storage.outbox.moveToDeadLetter(claimed.id, {
    workerId: "legacy-worker",
    error: Object.assign(new Error("invalid legacy payload"), {
      code: "SYNC_INVALID_PAYLOAD",
    }),
    at: 1_200,
  });
  storage.providerDeliveries.applyPolicy(getProviderPolicyDefinitions(baseEnv));
  assert.deepEqual(storage.providerDeliveries.listForEvent("event:legacy-dead"), []);
  assert.deepEqual(storage.providerDeliveries.planBackfill("supabase"), {
    providerId: "supabase",
    retainedEvents: 0,
    missing: 0,
    disabled: 0,
  });
});

test("CLI, Termux status, and Cloud schema contracts stay bounded and secret-safe", () => {
  const reconcile = readFileSync(
    new URL("../scripts/reconcile-provider.mjs", import.meta.url),
    "utf8",
  );
  const backfill = readFileSync(
    new URL("../scripts/backfill-provider.mjs", import.meta.url),
    "utf8",
  );
  const status = readFileSync(
    new URL("../Android/status-nuviloview.sh", import.meta.url),
    "utf8",
  );
  const supabaseSql = readFileSync(
    new URL("../docs/sql/multi-db-supabase-v1.sql", import.meta.url),
    "utf8",
  );
  const tursoSql = readFileSync(
    new URL("../docs/sql/multi-db-turso-v1.sql", import.meta.url),
    "utf8",
  );
  const snapshotRoute = readFileSync(
    new URL("../app/api/analytics/snapshot/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(reconcile, /mode: "read_only"/);
  assert.match(reconcile, /getSnapshotStates/);
  assert.match(reconcile, /snapshotMismatched/);
  assert.match(backfill, /--execute/);
  assert.match(backfill, /--confirm=/);
  assert.doesNotMatch(backfill, /DELETE FROM sync_outbox|DROP TABLE|TRUNCATE/i);
  assert.match(status, /Cloud Replicas/);
  assert.match(snapshotRoute, /isAuthorizedGuild/);
  assert.match(snapshotRoute, /MULTI_DB|webReadEnabled/);
  assert.match(snapshotRoute, /source|readSnapshot/);
  assert.doesNotMatch(snapshotRoute, /TURSO_AUTH_TOKEN|SUPABASE_DATABASE_URL/);
  for (const sql of [supabaseSql, tursoSql]) {
    assert.match(sql, /replica_event/);
    assert.match(sql, /guild_status_snapshot/);
    assert.match(sql, /analytics_snapshot/);
    assert.match(sql, /runtime_snapshot/);
    assert.match(sql, /sync_status_snapshot/);
    assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
  }
});
