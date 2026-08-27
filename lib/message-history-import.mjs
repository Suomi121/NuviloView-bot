export const MESSAGE_IMPORT_VERSION = 3;
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
  const requestedMaxPages = Number.parseInt(environment.MESSAGE_HISTORY_IMPORT_MAX_PAGES_PER_CHANNEL ?? "50000", 10);
  const sqliteFirstGuildIds = Object.freeze([
    ...new Set(
      String(environment.MESSAGE_HISTORY_IMPORT_SQLITE_FIRST_GUILD_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]);
  const sqliteFirstEnabled =
    String(environment.MESSAGE_HISTORY_IMPORT_SQLITE_FIRST_ENABLED ?? "false")
      .trim()
      .toLowerCase() === "true";
  return {
    enabled: String(environment.MESSAGE_HISTORY_IMPORT_V2_ENABLED ?? "false").toLowerCase() === "true",
    sqliteFirstEnabled,
    sqliteFirstGuildIds,
    isSqliteFirstGuild: (guildId) =>
      sqliteFirstEnabled && sqliteFirstGuildIds.includes(String(guildId ?? "")),
    maxRetries: Number.isInteger(requestedRetries) ? Math.min(8, Math.max(0, requestedRetries)) : 5,
    stallSeconds: Number.isInteger(requestedStallSeconds) ? Math.min(900, Math.max(60, requestedStallSeconds)) : 120,
    batchSize: 100,
    maxPagesPerChannel: Number.isInteger(requestedMaxPages) ? Math.min(100_000, Math.max(100, requestedMaxPages)) : 50_000,
  };
}

const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 15_000, 30_000, 60_000]);

export function importRetryDelayMs(attempt) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attempt) - 1));
  return RETRY_DELAYS_MS[index];
}

export async function withBoundedImportRetry(operation, options = {}) {
  const maxRetries = Math.max(0, Number(options.maxRetries) || 0);
  const classify = options.classify ?? classifyImportError;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let retries = 0;
  while (true) {
    try {
      return await operation(retries);
    } catch (error) {
      const safe = classify(error);
      if (!safe.retryable || retries >= maxRetries) {
        if (error && typeof error === "object") error.safeImport = safe;
        throw error;
      }
      retries += 1;
      const delayMs = importRetryDelayMs(retries);
      await options.onRetry?.({ retries, delayMs, safe });
      await sleep(delayMs);
    }
  }
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

export const MESSAGE_IMPORT_MUTATION_ACTIONS = Object.freeze([
  "start",
  "pause",
  "resume",
  "cancel",
  "reset",
  "retry-channel",
  "skip-channel",
]);

const MESSAGE_IMPORT_ACTION_SET = new Set(MESSAGE_IMPORT_MUTATION_ACTIONS);
const IMPORT_DAYS = new Set([0, 7, 30, 90]);
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isDiscordSnowflake(value) {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value);
}

export function parseMessageImportMutation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Invalid import request" };
  }
  const action = typeof value.action === "string" ? value.action : "start";
  const guildId = typeof value.guildId === "string" ? value.guildId : "";
  if (!MESSAGE_IMPORT_ACTION_SET.has(action) || !isDiscordSnowflake(guildId)) {
    return { ok: false, error: "Invalid import request" };
  }
  if (action === "start") {
    const days = Number(value.days);
    if (!IMPORT_DAYS.has(days)) return { ok: false, error: "Invalid import options" };
    return {
      ok: true,
      value: {
        action,
        guildId,
        days,
        mode: value.mode === "developer" ? "developer" : "standard",
      },
    };
  }
  const jobId = Number(value.jobId);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return { ok: false, error: "Invalid import job" };
  }
  if (action === "retry-channel" || action === "skip-channel") {
    const channelId = typeof value.channelId === "string" ? value.channelId : "";
    if (!isDiscordSnowflake(channelId)) return { ok: false, error: "Invalid channel" };
    return { ok: true, value: { action, guildId, jobId, channelId } };
  }
  return { ok: true, value: { action, guildId, jobId } };
}

export function parseImportedDataDeletion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Invalid delete request" };
  }
  const guildId = typeof value.guildId === "string" ? value.guildId : "";
  if (!isDiscordSnowflake(guildId) || value.confirmation !== IMPORTED_DATA_CONFIRMATION) {
    return { ok: false, error: "Confirmation does not match" };
  }
  return { ok: true, value: { guildId, confirmation: IMPORTED_DATA_CONFIRMATION } };
}
