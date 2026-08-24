export const SYNC_PROVIDER_IDS = Object.freeze({
  SUPABASE: "supabase",
  TURSO: "turso",
  NEON: "neon",
});

export const SYNC_PROVIDER_ID_LIST = Object.freeze(Object.values(SYNC_PROVIDER_IDS));

const providerIdSet = new Set(SYNC_PROVIDER_ID_LIST);

export const SYNC_PROVIDER_POLICIES = Object.freeze({
  [SYNC_PROVIDER_IDS.SUPABASE]: Object.freeze({
    id: SYNC_PROVIDER_IDS.SUPABASE,
    required: true,
    role: "CLOUD_REPLICA_A",
  }),
  [SYNC_PROVIDER_IDS.TURSO]: Object.freeze({
    id: SYNC_PROVIDER_IDS.TURSO,
    required: true,
    role: "CLOUD_REPLICA_B",
  }),
  [SYNC_PROVIDER_IDS.NEON]: Object.freeze({
    id: SYNC_PROVIDER_IDS.NEON,
    required: false,
    role: "CLOUD_REPLICA_C",
  }),
});

export const SYNC_REQUIRED_PROVIDER_IDS = Object.freeze(
  SYNC_PROVIDER_ID_LIST.filter(
    (providerId) => SYNC_PROVIDER_POLICIES[providerId].required,
  ),
);

export function isEnabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

export function assertProviderId(value) {
  const providerId = String(value ?? "").trim().toLowerCase();
  if (!providerIdSet.has(providerId)) {
    throw new TypeError(`Unsupported Sync Provider: ${providerId || "empty"}.`);
  }
  return providerId;
}

export function getProviderPolicyDefinitions(env = process.env) {
  if (!isEnabledFlag(env.MULTI_DB_SYNC_ENABLED)) return Object.freeze([]);
  const neonFlag = env.SYNC_NEON_ENABLED ?? env.SYNC_NEON_REPLICA_ENABLED;
  const enabledByProvider = {
    supabase: isEnabledFlag(env.SYNC_SUPABASE_ENABLED),
    turso: isEnabledFlag(env.SYNC_TURSO_ENABLED),
    neon: isEnabledFlag(neonFlag),
  };
  return Object.freeze(
    Object.values(SYNC_PROVIDER_POLICIES).map((policy) =>
      Object.freeze({ ...policy, enabled: enabledByProvider[policy.id] }),
    ),
  );
}

export function assertSyncProvider(provider) {
  const providerId = assertProviderId(provider?.id);
  for (const method of [
    "isEnabled",
    "health",
    "pushEvents",
    "pushSnapshots",
    "verifySchema",
    "getRemoteCursor",
    "readSnapshot",
    "getEventChecksums",
    "getSnapshotStates",
    "close",
  ]) {
    if (typeof provider?.[method] !== "function") {
      throw new TypeError(`Sync Provider ${providerId} is missing ${method}().`);
    }
  }
  return provider;
}

export function getProviderPolicy(providerId) {
  return SYNC_PROVIDER_POLICIES[assertProviderId(providerId)];
}
