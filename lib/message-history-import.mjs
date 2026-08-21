export const MESSAGE_IMPORT_VERSION = 2;
export const MESSAGE_SOURCE = Object.freeze({
  existing: "existing",
  live: "live",
  history: "history_import",
});

export const MESSAGE_IMPORT_STATUS = Object.freeze({
  queued: "queued",
  preparing: "preparing",
  running: "running",
  pausing: "pausing",
  paused: "paused",
  cancelling: "cancelling",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
  stalled: "stalled",
});

export const ACTIVE_IMPORT_STATUSES = new Set([
  MESSAGE_IMPORT_STATUS.queued,
  MESSAGE_IMPORT_STATUS.preparing,
  MESSAGE_IMPORT_STATUS.running,
  MESSAGE_IMPORT_STATUS.pausing,
  MESSAGE_IMPORT_STATUS.paused,
  MESSAGE_IMPORT_STATUS.cancelling,
  MESSAGE_IMPORT_STATUS.stalled,
]);

export const TERMINAL_IMPORT_STATUSES = new Set([
  MESSAGE_IMPORT_STATUS.cancelled,
  MESSAGE_IMPORT_STATUS.completed,
  MESSAGE_IMPORT_STATUS.failed,
]);

const TRANSITIONS = Object.freeze({
  queued: new Set(["preparing", "cancelling", "cancelled", "failed"]),
  preparing: new Set(["running", "pausing", "cancelling", "failed", "stalled"]),
  running: new Set(["pausing", "cancelling", "completed", "failed", "stalled"]),
  pausing: new Set(["paused", "cancelling", "failed", "stalled"]),
  paused: new Set(["queued", "cancelling", "cancelled"]),
  cancelling: new Set(["cancelled", "failed", "stalled"]),
  stalled: new Set(["queued", "cancelling", "cancelled", "failed"]),
  cancelled: new Set(),
  completed: new Set(),
  failed: new Set(),
});

export function canTransitionImport(from, to) {
  return TRANSITIONS[from]?.has(to) === true;
}

export function assertImportTransition(from, to) {
  if (!canTransitionImport(from, to)) {
    const error = new Error(`Invalid import transition: ${from} -> ${to}`);
    error.code = "INVALID_IMPORT_TRANSITION";
    throw error;
  }
}

export function getMessageImportConfig(environment = process.env) {
  const requestedRetries = Number.parseInt(environment.MESSAGE_HISTORY_IMPORT_MAX_RETRIES ?? "5", 10);
  const requestedStallSeconds = Number.parseInt(environment.MESSAGE_HISTORY_IMPORT_STALL_SECONDS ?? "120", 10);
  return {
    enabled: String(environment.MESSAGE_HISTORY_IMPORT_V2_ENABLED ?? "false").toLowerCase() === "true",
    maxRetries: Number.isInteger(requestedRetries) ? Math.min(8, Math.max(0, requestedRetries)) : 5,
    stallSeconds: Number.isInteger(requestedStallSeconds) ? Math.min(900, Math.max(60, requestedStallSeconds)) : 120,
    batchSize: 100,
  };
}

const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 15_000, 30_000, 60_000]);

export function importRetryDelayMs(attempt) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attempt) - 1));
  return RETRY_DELAYS_MS[index];
}

export function classifyImportError(error) {
  const code = String(error?.code ?? error?.rawError?.code ?? "").toUpperCase();
  const status = Number(error?.status ?? error?.httpStatus ?? 0);
  if (status === 429 || code === "RATE_LIMITED") {
    return { code: "DISCORD_RATE_LIMITED", summary: "Discordのレート制限解除を待っています。", retryable: true };
  }
  if (["50001", "50013", "MISSING_ACCESS", "MISSING_PERMISSIONS"].includes(code) || status === 403) {
    return { code: "DISCORD_FORBIDDEN", summary: "このチャンネルの履歴を読み取る権限がありません。", retryable: false };
  }
  if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(code) || status >= 500) {
    return { code: "TEMPORARY_NETWORK", summary: "一時的な通信エラーが発生しました。", retryable: true };
  }
  if (/^(08|53|57P0)/.test(code)) {
    return { code: "DATABASE_TEMPORARY", summary: "データベースへの一時的な接続エラーが発生しました。", retryable: true };
  }
  return { code: "IMPORT_INTERNAL", summary: "履歴取り込み中に安全に継続できないエラーが発生しました。", retryable: false };
}

export function isImportStalled(job, now = Date.now(), stallSeconds = 120) {
  if (![MESSAGE_IMPORT_STATUS.running, MESSAGE_IMPORT_STATUS.preparing, MESSAGE_IMPORT_STATUS.pausing, MESSAGE_IMPORT_STATUS.cancelling].includes(job?.status)) return false;
  const retryAfter = Date.parse(job?.retryAfterAt ?? "");
  if (Number.isFinite(retryAfter) && retryAfter > now) return false;
  const threshold = Math.max(60, stallSeconds) * 1_000;
  const progressAt = Date.parse(job?.lastProgressAt ?? job?.startedAt ?? "");
  const heartbeatAt = Date.parse(job?.lastWorkerHeartbeatAt ?? "");
  const progressStale = !Number.isFinite(progressAt) || now - progressAt > threshold;
  const heartbeatStale = !Number.isFinite(heartbeatAt) || now - heartbeatAt > Math.min(threshold, 60_000);
  return progressStale && heartbeatStale;
}

export function calculateImportProgress(job, now = Date.now()) {
  const startedAt = Date.parse(job?.startedAt ?? "");
  const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, (now - startedAt) / 1_000) : 0;
  const fetched = Math.max(0, Number(job?.fetchedMessages) || 0);
  const totalChannels = Math.max(0, Number(job?.totalChannels) || 0);
  const completedChannels = Math.max(0, Number(job?.completedChannels) || 0) + Math.max(0, Number(job?.skippedChannels) || 0);
  return {
    elapsedSeconds,
    messagesPerSecond: elapsedSeconds > 0 ? fetched / elapsedSeconds : 0,
    channelProgressPercent: totalChannels > 0 ? Math.min(100, (completedChannels / totalChannels) * 100) : null,
  };
}

export const IMPORTED_DATA_CONFIRMATION = "RESET IMPORTED DATA";
