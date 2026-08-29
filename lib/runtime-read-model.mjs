const PROVIDER_IDS = Object.freeze(["supabase", "turso", "neon"]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function payloadOf(result) {
  const payload = result?.snapshot?.payload;
  return payload && typeof payload === "object" ? payload : {};
}

function syncProviderMap(payload) {
  const rows = Array.isArray(payload?.providers) ? payload.providers : [];
  return new Map(rows.map((row) => [String(row?.providerId ?? ""), row]));
}

function runtimeProviderMap(payload) {
  const rows = payload?.providers;
  return rows && typeof rows === "object" ? rows : {};
}

function normalizeProvider(providerId, syncRow, runtimeRow) {
  const defaultRequired = providerId !== "neon";
  const hasSyncRow = Boolean(syncRow && typeof syncRow === "object");
  const hasRuntimeRow = Boolean(runtimeRow && typeof runtimeRow === "object");
  const enabled = hasSyncRow
    ? Boolean(syncRow.enabled)
    : hasRuntimeRow;
  const required = hasSyncRow
    ? Boolean(syncRow.required)
    : defaultRequired;
  if (!enabled) {
    return Object.freeze({
      providerId,
      required,
      enabled: false,
      status: "OFF",
      circuit: "OFF",
      pending: 0,
      retry: 0,
      deadLetter: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      queryCount: 0,
    });
  }
  return Object.freeze({
    providerId,
    required,
    enabled: true,
    status: String(syncRow?.status ?? runtimeRow?.status ?? "UNKNOWN").toUpperCase(),
    circuit: String(syncRow?.circuit ?? runtimeRow?.circuit ?? "UNKNOWN").toUpperCase(),
    pending: Number(syncRow?.pending ?? runtimeRow?.pending ?? 0) || 0,
    retry: Number(syncRow?.retry ?? 0) || 0,
    deadLetter: Number(syncRow?.deadLetter ?? runtimeRow?.deadLetter ?? 0) || 0,
    lastAttemptAt: numberOrNull(syncRow?.lastAttemptAt),
    lastSuccessAt: numberOrNull(syncRow?.lastSuccessAt ?? runtimeRow?.lastSuccessAt),
    queryCount: Number(syncRow?.queryCount ?? 0) || 0,
  });
}

export function buildRuntimeReadModel({ runtimeRead, syncRead, at = Date.now() }) {
  const runtime = payloadOf(runtimeRead);
  const sync = payloadOf(syncRead);
  const syncProviders = syncProviderMap(sync);
  const runtimeProviders = runtimeProviderMap(runtime);
  const providers = PROVIDER_IDS.map((providerId) =>
    normalizeProvider(
      providerId,
      syncProviders.get(providerId),
      runtimeProviders[providerId],
    ),
  );
  const requiredProviders = providers.filter((provider) => provider.required && provider.enabled);
  const requiredHealthy = requiredProviders.length > 0
    && requiredProviders.every(
      (provider) => provider.status === "HEALTHY" && provider.circuit === "CLOSED",
    );
  const requiredLastSuccesses = requiredProviders
    .map((provider) => provider.lastSuccessAt)
    .filter((value) => value !== null);
  const lastSuccessfulSync =
    requiredProviders.length > 0
    && requiredLastSuccesses.length === requiredProviders.length
      ? Math.min(...requiredLastSuccesses)
      : null;
  const readsAvailable = Boolean(runtimeRead?.available || syncRead?.available);
  const overallStatus = readsAvailable && requiredHealthy ? "HEALTHY" : "DEGRADED";
  return Object.freeze({
    overallStatus,
    botStatus: String(runtime?.botStatus ?? "UNKNOWN").toUpperCase(),
    workerStatus: String(runtime?.workerStatus ?? "UNKNOWN").toUpperCase(),
    sqliteStatus: String(runtime?.sqliteStatus ?? "UNKNOWN").toUpperCase(),
    lastSuccessfulSync,
    pendingCount: providers.reduce((sum, provider) => sum + provider.pending, 0),
    retryCount: providers.reduce((sum, provider) => sum + provider.retry, 0),
    deadLetterCount: providers.reduce((sum, provider) => sum + provider.deadLetter, 0),
    providers,
    readMeta: Object.freeze({
      runtime: runtimeRead?.metadata ?? null,
      sync: syncRead?.metadata ?? null,
      generatedAt: at,
      degraded: !runtimeRead?.available || !syncRead?.available,
    }),
  });
}
