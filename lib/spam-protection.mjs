export const defaultSpamProtectionConfig = Object.freeze({
  messageLimit: 8,
  windowMs: 5_000,
  timeoutMinutes: 5,
  detectionCooldownMs: 10 * 60 * 1_000,
});

export function getAutomaticSpamProtectionBlockReason({
  isBot,
  isOwner,
  hasModerationPermission,
}) {
  if (isBot) return "Botアカウント";
  if (isOwner) return "サーバー所有者";
  if (hasModerationPermission) return "管理・モデレーション権限を持つメンバー";
  return null;
}

export function canManageSpamAction({
  isOwner,
  isAdministrator,
  hasRequiredPermission,
}) {
  return Boolean(isOwner || isAdministrator || hasRequiredPermission);
}

const validSpamActionStages = new Set(["confirm", "execute", "cancel"]);
const validSpamActions = new Set(["untimeout", "kick", "ban"]);

export function createSpamActionCustomId({
  stage,
  action,
  detectionId,
  alertChannelId = null,
  alertMessageId = null,
}) {
  if (!validSpamActionStages.has(stage) || !validSpamActions.has(action)) {
    throw new Error("Invalid spam action component.");
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(detectionId))) {
    throw new Error("Invalid spam detection ID.");
  }
  if (Boolean(alertChannelId) !== Boolean(alertMessageId)) {
    throw new Error("Alert channel and message IDs must be provided together.");
  }
  if (
    (alertChannelId && !/^\d{17,20}$/.test(String(alertChannelId))) ||
    (alertMessageId && !/^\d{17,20}$/.test(String(alertMessageId)))
  ) {
    throw new Error("Invalid Discord alert reference.");
  }

  const customId = [
    "nvspam",
    stage,
    action,
    detectionId,
    ...(alertChannelId ? [String(alertChannelId), String(alertMessageId)] : []),
  ].join(":");
  if (customId.length > 100) {
    throw new Error("Spam action component ID exceeds Discord's limit.");
  }
  return customId;
}

export function parseSpamActionCustomId(customId) {
  const [namespace, stage, action, detectionId, alertChannelId, alertMessageId, ...rest] =
    String(customId ?? "").split(":");
  if (
    namespace !== "nvspam" ||
    !validSpamActionStages.has(stage) ||
    !validSpamActions.has(action) ||
    !/^[0-9a-f-]{36}$/i.test(String(detectionId)) ||
    rest.length > 0 ||
    Boolean(alertChannelId) !== Boolean(alertMessageId) ||
    (alertChannelId && !/^\d{17,20}$/.test(alertChannelId)) ||
    (alertMessageId && !/^\d{17,20}$/.test(alertMessageId))
  ) {
    return null;
  }
  return {
    stage,
    action,
    detectionId,
    alertChannelId: alertChannelId ?? null,
    alertMessageId: alertMessageId ?? null,
  };
}

export function createSpamTracker({
  messageLimit = defaultSpamProtectionConfig.messageLimit,
  windowMs = defaultSpamProtectionConfig.windowMs,
  detectionCooldownMs = defaultSpamProtectionConfig.detectionCooldownMs,
} = {}) {
  if (!Number.isInteger(messageLimit) || messageLimit < 2) {
    throw new Error("messageLimit must be an integer of at least 2.");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1_000) {
    throw new Error("windowMs must be an integer of at least 1000.");
  }
  if (!Number.isInteger(detectionCooldownMs) || detectionCooldownMs < windowMs) {
    throw new Error("detectionCooldownMs must be at least as long as windowMs.");
  }

  const windows = new Map();
  const cooldowns = new Map();

  function record(key, timestamp = Date.now()) {
    const normalizedKey = String(key);
    const cooldownUntil = cooldowns.get(normalizedKey) ?? 0;
    if (cooldownUntil > timestamp) {
      return {
        detected: false,
        coolingDown: true,
        count: 0,
        cooldownUntil,
      };
    }

    if (cooldownUntil) cooldowns.delete(normalizedKey);
    const cutoff = timestamp - windowMs;
    const timestamps = (windows.get(normalizedKey) ?? []).filter(
      (entry) => entry >= cutoff,
    );
    timestamps.push(timestamp);

    if (timestamps.length >= messageLimit) {
      const nextCooldownUntil = timestamp + detectionCooldownMs;
      windows.delete(normalizedKey);
      cooldowns.set(normalizedKey, nextCooldownUntil);
      return {
        detected: true,
        coolingDown: false,
        count: timestamps.length,
        cooldownUntil: nextCooldownUntil,
      };
    }

    windows.set(normalizedKey, timestamps);
    return {
      detected: false,
      coolingDown: false,
      count: timestamps.length,
      cooldownUntil: null,
    };
  }

  function prune(timestamp = Date.now()) {
    const cutoff = timestamp - windowMs;
    for (const [key, timestamps] of windows) {
      if (!timestamps.length || timestamps[timestamps.length - 1] < cutoff) {
        windows.delete(key);
      }
    }
    for (const [key, cooldownUntil] of cooldowns) {
      if (cooldownUntil <= timestamp) cooldowns.delete(key);
    }
  }

  return {
    record,
    prune,
    get trackedWindowCount() {
      return windows.size;
    },
    get cooldownCount() {
      return cooldowns.size;
    },
  };
}
