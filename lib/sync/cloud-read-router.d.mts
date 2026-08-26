import type {
  CloudSnapshot,
  ProviderRegistry,
} from "./providers/registry.mjs";

export class CloudSnapshotUnavailableError extends Error {
  code: "CLOUD_SNAPSHOT_UNAVAILABLE";
  attemptedProviders: string[];
}

export type RoutedCloudSnapshot = CloudSnapshot & {
  source: string;
  lastUpdated: number;
  dataAgeMs: number;
  fresh: boolean;
  cloudSyncDelayed: boolean;
};

export function createCloudReadRouter(options: {
  registry: ProviderRegistry;
  now?: () => number;
  priority?: readonly string[];
  failureCacheMs?: number;
  defaultMaxAgeMs?: number;
}): {
  readSnapshot(input: {
    snapshotType: string;
    aggregateId: string;
    maxAgeMs?: number;
  }): Promise<RoutedCloudSnapshot>;
  clearHealthCache(providerId?: string | null): void;
  priority: readonly string[];
};
