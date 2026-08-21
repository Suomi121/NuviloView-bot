export const SNIPE_RETENTION_DAYS = 90;
export const SNIPE_RETENTION_MS = SNIPE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const SNIPE_RESULT_SESSION_MS = 15 * 60 * 1_000;
export const SNIPE_HISTORY_LIMIT = 999_999;
// Node.js timers cannot safely represent the complete 90-day delay in one
// setTimeout. Recheck at most every 24 days until the actual expiry is reached.
export const SNIPE_CLEANUP_TIMER_MAX_MS = 24 * 24 * 60 * 60 * 1_000;

export function getSnipeCleanupDelay(
  earliestExpiry,
  now = Date.now(),
  maximum = SNIPE_CLEANUP_TIMER_MAX_MS,
) {
  if (!Number.isFinite(earliestExpiry) || !Number.isFinite(now)) return 1;
  return Math.min(maximum, Math.max(1, earliestExpiry - now + 10));
}

export function limitSnipeHistory(records, maximum = SNIPE_HISTORY_LIMIT) {
  if (!Array.isArray(records)) return [];
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("Snipe history maximum must be a positive integer.");
  }
  return records.slice(0, maximum);
}

export function escapeSnipeText(value, maxLength = 360) {
  const normalized = String(value ?? "")
    .replace(/\\/g, "＼")
    .replace(/`/g, "ˋ")
    .replace(/@/g, "＠")
    .replace(/([*_~|>#[\]()])/g, "\\$1")
    .replace(/\r/g, "")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function createSnipeDeleteCustomId(executorId) {
  const normalizedId = String(executorId ?? "").trim();
  if (!/^\d{17,20}$/.test(normalizedId)) {
    throw new Error("Invalid Snipe executor ID.");
  }
  return `nvsnipe:delete:${normalizedId}`;
}

export function parseSnipeDeleteCustomId(customId) {
  const [namespace, action, executorId, ...rest] = String(customId ?? "").split(":");
  if (
    namespace !== "nvsnipe" ||
    action !== "delete" ||
    !/^\d{17,20}$/.test(executorId ?? "") ||
    rest.length > 0
  ) {
    return null;
  }
  return { executorId };
}

export function createSnipePageCustomId(direction) {
  if (direction !== "previous" && direction !== "next") {
    throw new Error("Invalid Snipe page direction.");
  }
  return `nvsnipe:page:${direction}`;
}

export function parseSnipePageCustomId(customId) {
  const [namespace, action, direction, ...rest] = String(customId ?? "").split(":");
  if (
    namespace !== "nvsnipe" ||
    action !== "page" ||
    (direction !== "previous" && direction !== "next") ||
    rest.length > 0
  ) {
    return null;
  }
  return { direction };
}

export function canDeleteSnipeResult({
  userId,
  executorId,
  guildOwnerId,
  isAdministrator,
}) {
  return Boolean(
    userId === executorId ||
      userId === guildOwnerId ||
      isAdministrator,
  );
}
