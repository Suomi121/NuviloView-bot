import { SYNC_PROVIDER_ID_LIST } from "./providers/contract.mjs";

const defaultPriority = SYNC_PROVIDER_ID_LIST;

export class CloudSnapshotUnavailableError extends Error {
  constructor(attemptedProviders) {
    super("No Cloud Replica returned the requested snapshot.");
    this.name = "CloudSnapshotUnavailableError";
    this.code = "CLOUD_SNAPSHOT_UNAVAILABLE";
    this.attemptedProviders = attemptedProviders;
  }
}

export function createCloudReadRouter({
  registry,
  now = () => Date.now(),
  priority = defaultPriority,
  failureCacheMs = 10_000,
  defaultMaxAgeMs = 120_000,
} = {}) {
  if (!registry?.get) throw new TypeError("Provider Registry is required.");
  const unavailableUntil = new Map();

  async function readSnapshot({
    snapshotType,
    aggregateId,
    maxAgeMs = defaultMaxAgeMs,
  }) {
    const at = now();
    const attemptedProviders = [];
    let bestStale = null;
    for (const providerId of priority) {
      const provider = registry.get(providerId);
      if (!provider?.isEnabled()) continue;
      if (Number(unavailableUntil.get(providerId) ?? 0) > at) continue;
      attemptedProviders.push(providerId);
      try {
        const snapshot = await provider.readSnapshot({ snapshotType, aggregateId });
        unavailableUntil.delete(providerId);
        if (!snapshot) continue;
        const generatedAt = Number(snapshot.generatedAt);
        const dataAgeMs = Math.max(0, at - generatedAt);
        const result = {
          ...snapshot,
          source: providerId,
          lastUpdated: generatedAt,
          dataAgeMs,
          fresh: dataAgeMs <= maxAgeMs,
          cloudSyncDelayed: dataAgeMs > maxAgeMs,
        };
        if (result.fresh) return result;
        if (!bestStale || result.generatedAt > bestStale.generatedAt) {
          bestStale = result;
        }
      } catch {
        unavailableUntil.set(providerId, at + failureCacheMs);
      }
    }
    if (bestStale) return bestStale;
    throw new CloudSnapshotUnavailableError(attemptedProviders);
  }

  function clearHealthCache(providerId = null) {
    if (providerId === null) unavailableUntil.clear();
    else unavailableUntil.delete(String(providerId));
  }

  return Object.freeze({
    readSnapshot,
    clearHealthCache,
    priority: Object.freeze([...priority]),
  });
}
