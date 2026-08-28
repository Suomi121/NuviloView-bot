import { Pool } from "pg";
import { sanitizeSyncError } from "../retry.mjs";
import { assertProviderId, assertSyncProvider } from "./contract.mjs";
import { createNeonProviderAdapter } from "./neon.mjs";
import { createSupabaseProviderAdapter } from "./supabase.mjs";
import { createTursoProviderAdapter } from "./turso.mjs";

function createPool(connectionString, config, applicationName) {
  return new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: config.queryTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.queryTimeoutMs,
    application_name: applicationName,
  });
}

function createUnavailableProvider(definition, error) {
  const providerId = assertProviderId(definition.id);
  const unavailable = new Error(
    `${providerId} provider is unavailable: ${sanitizeSyncError(error, 300)}`,
  );
  unavailable.code = error?.code || "SYNC_PROVIDER_UNAVAILABLE";
  unavailable.queryAttempted = false;
  const reject = async () => {
    throw unavailable;
  };
  return assertSyncProvider(
    Object.freeze({
      id: providerId,
      required: Boolean(definition.required),
      isEnabled: () => true,
      health: reject,
      pushEvents: reject,
      pushSnapshots: reject,
      verifySchema: reject,
      getRemoteCursor: reject,
      readSnapshot: reject,
      listSnapshots: reject,
      getEventChecksums: reject,
      getSnapshotStates: reject,
      close: async () => {},
    }),
  );
}

export async function createProviderRegistry({
  config,
  clients = {},
  poolFactory = createPool,
  tursoClientFactory = null,
  logger = console,
} = {}) {
  if (!config?.providers) throw new TypeError("Multi-DB Sync config is required.");
  const providers = new Map();
  const initializationErrors = new Map();

  async function register(definition, factory) {
    if (!definition.enabled) return;
    try {
      providers.set(definition.id, assertSyncProvider(await factory()));
    } catch (error) {
      initializationErrors.set(definition.id, sanitizeSyncError(error, 500));
      logger.warn?.(`[multi-sync] ${definition.id} initialization is degraded.`);
      providers.set(definition.id, createUnavailableProvider(definition, error));
    }
  }

  await register(config.providers.supabase, async () => {
    if (!config.providers.supabase.configured) {
      throw Object.assign(new Error("Supabase credentials are not configured."), {
        code: "SYNC_PROVIDER_CREDENTIALS_MISSING",
      });
    }
    const pool = clients.supabase ?? poolFactory(
      config.providers.supabase.connectionString,
      config,
      "nuviloview-sync-supabase",
    );
    return createSupabaseProviderAdapter({
      enabled: true,
      execute: (text, parameters) => pool.query(text, parameters),
      close: () => pool.end?.(),
    });
  });

  await register(config.providers.turso, async () => {
    if (!config.providers.turso.configured) {
      throw Object.assign(new Error("Turso credentials are not configured."), {
        code: "SYNC_PROVIDER_CREDENTIALS_MISSING",
      });
    }
    let client = clients.turso;
    if (!client) {
      let factory = tursoClientFactory;
      if (!factory) {
        const tursoModule = await import("@tursodatabase/serverless/compat");
        factory = tursoModule.createClient;
      }
      client = factory({
        url: config.providers.turso.databaseUrl,
        authToken: config.providers.turso.authToken,
      });
    }
    return createTursoProviderAdapter({ enabled: true, client });
  });

  await register(config.providers.neon, async () => {
    if (!config.providers.neon.configured) {
      throw Object.assign(new Error("Neon credentials are not configured."), {
        code: "SYNC_PROVIDER_CREDENTIALS_MISSING",
      });
    }
    const pool = clients.neon ?? poolFactory(
      config.providers.neon.connectionString,
      config,
      "nuviloview-sync-neon-optional",
    );
    return createNeonProviderAdapter({
      enabled: true,
      execute: (text, parameters) => pool.query(text, parameters),
      close: () => pool.end?.(),
    });
  });

  return Object.freeze({
    get: (providerId) => providers.get(assertProviderId(providerId)) ?? null,
    has: (providerId) => providers.has(assertProviderId(providerId)),
    list: () => [...providers.values()],
    enabledProviderIds: () => [...providers.keys()],
    initializationErrors: () => Object.fromEntries(initializationErrors),
    close: async () => {
      await Promise.allSettled([...providers.values()].map((provider) => provider.close()));
    },
  });
}
