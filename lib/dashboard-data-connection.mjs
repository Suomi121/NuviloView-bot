export const DASHBOARD_DATA_CONNECTION_STATES = Object.freeze([
  "connected",
  "stale",
  "degraded",
  "unavailable",
]);

export function classifyDashboardDataConnection(readMeta) {
  if (!readMeta || typeof readMeta !== "object") return "unavailable";
  if (readMeta.lastKnownGood === true) return "degraded";
  if (readMeta.available !== true) return "unavailable";
  if (readMeta.freshness === "fresh") return "connected";
  return "stale";
}
