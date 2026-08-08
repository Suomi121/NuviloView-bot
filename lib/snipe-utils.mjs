export const SNIPE_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
export const SNIPE_RESULT_SESSION_MS = 15 * 60 * 1_000;
export const SNIPE_HISTORY_LIMIT = 10;

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
