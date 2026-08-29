export type AnalyticsFreshness = "fresh" | "stale" | "very_stale" | "unavailable";
export type AnalyticsRefreshReason = "initial" | "filter" | "countdown" | "visibility";

export type AnalyticsRefreshContract = Readonly<{
  last_updated_at: number | null;
  next_update_at: number;
  snapshot_version: number | null;
  checksum: string | null;
  freshness: AnalyticsFreshness;
  interval_ms: number;
}>;

export type AnalyticsRefreshSchedule = Readonly<{
  lastUpdatedAt: number;
  nextUpdateAt: number;
  snapshotVersion: number | null;
  checksum: string | null;
  freshness: AnalyticsFreshness;
  intervalMs: number;
}>;

export declare const DEFAULT_ANALYTICS_REFRESH_INTERVAL_MS: number;
export declare const MINIMUM_ANALYTICS_REFRESH_INTERVAL_MS: number;
export declare const MAXIMUM_ANALYTICS_REFRESH_INTERVAL_MS: number;

export function getAnalyticsRefreshIntervalMs(
  env?: Record<string, string | undefined>,
): number;

export function createAnalyticsRefreshContract(
  metadata: Record<string, unknown> | null | undefined,
  options?: { at?: number; intervalMs?: number },
): AnalyticsRefreshContract;

export function toAnalyticsRefreshSchedule(
  value: Record<string, unknown> | null | undefined,
): AnalyticsRefreshSchedule | null;

export function recordAnalyticsFetch(reason?: AnalyticsRefreshReason): Readonly<{
  analytics_fetches: number;
  countdown_refetches: number;
  visibility_refetches: number;
}>;

export function getAnalyticsRefreshMetrics(): Readonly<{
  analytics_fetches: number;
  countdown_refetches: number;
  visibility_refetches: number;
}>;

export function resetAnalyticsRefreshMetricsForTests(): void;

export function isAnalyticsRefreshDue(options?: {
  at?: number;
  nextUpdateAt?: number | null;
  inFlight?: boolean;
  lastRequestedNextUpdateAt?: number | null;
}): boolean;
