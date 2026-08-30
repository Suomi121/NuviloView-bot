import { buildRuntimeReadModel } from "./runtime-read-model.mjs";

function timestamp(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function isFreshTimestamp(value, { at, maxAgeMs }) {
  const normalized = timestamp(value);
  if (normalized === null) return false;
  // A small positive skew is tolerated, but a materially future heartbeat is
  // not accepted as proof that the process is alive.
  if (normalized > at + 60_000) return false;
  return at - normalized <= maxAgeMs;
}

function payloadOf(read) {
  const payload = read?.snapshot?.payload;
  return payload && typeof payload === "object" ? payload : {};
}

function unavailable(reason, model = null) {
  return Object.freeze({ available: false, state: "Down", reason, model });
}

export function evaluateProjectionBotHealth({
  runtimeRead,
  syncRead,
  at = Date.now(),
  maxAgeMs = 180_000,
} = {}) {
  if (!Number.isFinite(at) || at <= 0) {
    throw new TypeError("at must be a positive timestamp.");
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 60_000 || maxAgeMs > 3_600_000) {
    throw new TypeError("maxAgeMs must be between 60 seconds and 1 hour.");
  }
  if (!runtimeRead?.available || !syncRead?.available) {
    return unavailable("projection_unavailable");
  }
  if (runtimeRead.metadata?.lastKnownGood || syncRead.metadata?.lastKnownGood) {
    return unavailable("last_known_good_only");
  }

  const runtimePayload = payloadOf(runtimeRead);
  const model = buildRuntimeReadModel({ runtimeRead, syncRead, at });
  if (!isFreshTimestamp(runtimeRead.snapshot?.generatedAt, { at, maxAgeMs })) {
    return unavailable("runtime_snapshot_stale", model);
  }
  if (!isFreshTimestamp(syncRead.snapshot?.generatedAt, { at, maxAgeMs })) {
    return unavailable("sync_snapshot_stale", model);
  }
  if (!isFreshTimestamp(runtimePayload.botHeartbeatAt, { at, maxAgeMs })) {
    return unavailable("bot_heartbeat_stale", model);
  }
  if (!isFreshTimestamp(runtimePayload.workerHeartbeatAt, { at, maxAgeMs })) {
    return unavailable("worker_heartbeat_stale", model);
  }
  if (model.botStatus !== "RUNNING") {
    return unavailable("bot_not_running", model);
  }
  if (model.workerStatus !== "RUNNING") {
    return unavailable("worker_not_running", model);
  }
  if (model.sqliteStatus !== "HEALTHY") {
    return unavailable("sqlite_unhealthy", model);
  }

  const warning =
    model.overallStatus !== "HEALTHY"
    || Boolean(runtimeRead.metadata?.degraded)
    || Boolean(syncRead.metadata?.degraded)
    || runtimeRead.metadata?.provider !== "supabase"
    || syncRead.metadata?.provider !== "supabase"
    || Number(runtimeRead.attempts?.length ?? 0) > 1
    || Number(syncRead.attempts?.length ?? 0) > 1
    || model.deadLetterCount > 0;
  return Object.freeze({
    available: true,
    state: warning ? "Warning" : "Healthy",
    reason: warning ? "runtime_degraded" : "runtime_healthy",
    model,
  });
}
