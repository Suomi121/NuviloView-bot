import type { CloudSnapshot, ProviderRegistry } from "./sync/providers/registry.mjs";

export type WebReadFreshness = "fresh" | "stale" | "very_stale" | "unavailable";
export type WebReadMetadata = {
  provider: string | null;
  snapshotVersion: number | null;
  checksum: string | null;
  lastUpdatedAt: number | null;
  observedAt: number | null;
  observationSource: "sync_status" | null;
  nextUpdateAt: number | null;
  freshness: WebReadFreshness;
  degraded: boolean;
  truncated: boolean;
  lastKnownGood: boolean;
};
export type WebSnapshotReadResult = {
  available: boolean;
  snapshot: CloudSnapshot | null;
  metadata: WebReadMetadata;
  attempts: readonly string[];
};

export function classifyWebReadFreshness(input: {
  generatedAt: number | null;
  at?: number;
  intervalMs?: number;
}): WebReadFreshness;
export function isWebReadFallbackError(error: unknown): boolean;
export function createWebReadRouter(options: {
  registry: ProviderRegistry;
  intervalMs?: number;
  priority?: readonly string[];
  neonCompatibilityEnabled?: boolean;
  now?: () => number;
  logger?: { warn?: (message: string) => void } | null;
}): {
  readAnalyticsBundle(input: {
    guildId: string;
    dateFrom?: string | null;
    dateTo?: string | null;
    limit?: number;
  }): Promise<{
    available: boolean;
    current: CloudSnapshot | null;
    snapshots: readonly CloudSnapshot[];
    metadata: WebReadMetadata;
    attempts: readonly string[];
  }>;
  readSnapshot(input: {
    snapshotType: string;
    aggregateId: string;
  }): Promise<WebSnapshotReadResult>;
  readGuildCurrent(guildId: string): Promise<WebSnapshotReadResult>;
  readGuildDaily(guildId: string, dateUtc: string): Promise<WebSnapshotReadResult>;
  readChannelDaily(guildId: string, channelId: string, dateUtc: string): Promise<WebSnapshotReadResult>;
  readUserDaily(guildId: string, userId: string, dateUtc: string): Promise<WebSnapshotReadResult>;
  readRuntimeSnapshot(): Promise<WebSnapshotReadResult>;
  readSyncStatusSnapshot(): Promise<WebSnapshotReadResult>;
  getMetrics(): Record<string, number>;
  priority: readonly string[];
};
export function getWebReadMetrics(): Record<string, number>;
export function resetWebReadMetricsForTests(): void;
