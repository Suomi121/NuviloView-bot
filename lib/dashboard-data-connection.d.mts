export type DashboardDataConnectionState =
  | "connected"
  | "stale"
  | "degraded"
  | "unavailable";

export declare const DASHBOARD_DATA_CONNECTION_STATES: readonly DashboardDataConnectionState[];

export function classifyDashboardDataConnection(
  readMeta: Record<string, unknown> | null | undefined,
): DashboardDataConnectionState;
