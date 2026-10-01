import { createHash } from "node:crypto";

export const SPAM_POLICY_PRESETS = Object.freeze(["RELAXED", "NORMAL", "STRICT", "CUSTOM"]);
export const SPAM_POLICY_ACTIONS = Object.freeze(["LOG_ONLY", "ALERT", "INCIDENT"]);
export const SPAM_POLICY_MODES = Object.freeze(["STRENGTH", "CUSTOM"]);
export const SPAM_POLICY_MODULES = Object.freeze([
  "messageBurstEnabled", "duplicateEnabled", "mentionEnabled", "linkEnabled", "crossChannelEnabled",
]);
export const SPAM_POLICY_LIMITS = Object.freeze({
  thresholdMin: 1,
  thresholdMax: 100,
  windowMinSeconds: 1,
  windowMaxSeconds: 300,
  ignoredIdMax: 50,
});

// NORMAL preserves the currently deployed message-rate rule. The other
// detectors are available to Guilds that explicitly save a policy; Guilds
// without a row continue to use the legacy global rule in the Bot.
const presetValues = {
  RELAXED: { messageCountThreshold: 10, messageWindowSeconds: 10, duplicateCountThreshold: 5, duplicateWindowSeconds: 20, mentionCountThreshold: 10, mentionWindowSeconds: 10, linkCountThreshold: 8, linkWindowSeconds: 20, crossChannelThreshold: 5, crossChannelWindowSeconds: 15 },
  NORMAL: { messageCountThreshold: 3, messageWindowSeconds: 5, duplicateCountThreshold: 3, duplicateWindowSeconds: 20, mentionCountThreshold: 5, mentionWindowSeconds: 10, linkCountThreshold: 4, linkWindowSeconds: 20, crossChannelThreshold: 3, crossChannelWindowSeconds: 15 },
  STRICT: { messageCountThreshold: 3, messageWindowSeconds: 3, duplicateCountThreshold: 3, duplicateWindowSeconds: 30, mentionCountThreshold: 4, mentionWindowSeconds: 10, linkCountThreshold: 3, linkWindowSeconds: 20, crossChannelThreshold: 2, crossChannelWindowSeconds: 15 },
};

const strengthProfiles = Object.freeze({
  relaxed: {
    messageCountThreshold: 10, messageWindowSeconds: 3,
    duplicateCountThreshold: 5, duplicateWindowSeconds: 10,
    mentionCountThreshold: 10, mentionWindowSeconds: 5,
    linkCountThreshold: 8, linkWindowSeconds: 10,
    crossChannelThreshold: 5, crossChannelWindowSeconds: 8,
  },
  normal: presetValues.NORMAL,
  strict: {
    messageCountThreshold: 2, messageWindowSeconds: 8,
    duplicateCountThreshold: 2, duplicateWindowSeconds: 30,
    mentionCountThreshold: 3, mentionWindowSeconds: 15,
    linkCountThreshold: 2, linkWindowSeconds: 30,
    crossChannelThreshold: 2, crossChannelWindowSeconds: 20,
  },
});

const strengthPresetValues = Object.freeze({ RELAXED: 25, NORMAL: 50, STRICT: 75 });

export const DEFAULT_GUILD_SPAM_POLICY = Object.freeze({
  enabled: true,
  strength: 50,
  mode: "STRENGTH",
  preset: "NORMAL",
  ...presetValues.NORMAL,
  messageBurstEnabled: true,
  duplicateEnabled: true,
  mentionEnabled: true,
  linkEnabled: true,
  crossChannelEnabled: true,
  action: "ALERT",
  ignoreBots: false,
  ignoreAdmins: false,
  ignoredRoleIds: Object.freeze([]),
  ignoredChannelIds: Object.freeze([]),
  updatedAt: null,
  updatedBy: null,
});

const thresholdKeys = [
  "messageCountThreshold", "duplicateCountThreshold", "mentionCountThreshold",
  "linkCountThreshold", "crossChannelThreshold",
];
const windowKeys = [
  "messageWindowSeconds", "duplicateWindowSeconds", "mentionWindowSeconds",
  "linkWindowSeconds", "crossChannelWindowSeconds",
];
const discordIdPattern = /^\d{16,22}$/;

function isIntegerStrength(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

export function spamProtectionLevel(strength) {
  if (!isIntegerStrength(strength) || strength === 0) return "OFF";
  if (strength <= 33) return "RELAXED";
  if (strength <= 66) return "NORMAL";
  return "STRICT";
}

export function strengthForSpamPreset(preset) {
  return strengthPresetValues[preset] ?? null;
}

export function strengthToSpamPolicy(strength) {
  if (!isIntegerStrength(strength)) return null;
  const lower = strength <= 50 ? strengthProfiles.relaxed : strengthProfiles.normal;
  const upper = strength <= 50 ? strengthProfiles.normal : strengthProfiles.strict;
  const start = strength <= 50 ? 0 : 50;
  const end = strength <= 50 ? 50 : 100;
  const ratio = (strength - start) / (end - start);
  const values = {};
  for (const key of thresholdKeys.concat(windowKeys)) {
    const min = key.endsWith("Seconds") ? SPAM_POLICY_LIMITS.windowMinSeconds : SPAM_POLICY_LIMITS.thresholdMin;
    const max = key.endsWith("Seconds") ? SPAM_POLICY_LIMITS.windowMaxSeconds : SPAM_POLICY_LIMITS.thresholdMax;
    values[key] = Math.max(min, Math.min(max, Math.round(lower[key] + (upper[key] - lower[key]) * ratio)));
  }
  const matchingPreset = Object.entries(presetValues).find(([, preset]) =>
    thresholdKeys.concat(windowKeys).every((key) => preset[key] === values[key]),
  )?.[0] ?? "CUSTOM";
  return { strength, mode: "STRENGTH", preset: matchingPreset, ...values };
}

export function applySpamProtectionStrength(policy, strength) {
  const mapped = strengthToSpamPolicy(strength);
  return mapped && policy ? { ...policy, ...mapped } : null;
}

export function applySpamProtectionCommand(policy, operation, value) {
  if (!policy || typeof policy !== "object") return null;
  if (operation === "on" || operation === "off") return { ...policy, enabled: operation === "on" };
  if (operation === "level") return applySpamProtectionStrength(policy, value);
  const moduleByOperation = {
    messages: "messageBurstEnabled",
    duplicate: "duplicateEnabled",
    mentions: "mentionEnabled",
    links: "linkEnabled",
    "cross-channel": "crossChannelEnabled",
  };
  const field = moduleByOperation[operation];
  if (!field || typeof value !== "boolean") return null;
  return { ...policy, [field]: value };
}

export function spamPolicyToDatabaseFields(policy, fields = GUILD_SPAM_POLICY_AUDIT_FIELDS) {
  if (!policy || typeof policy !== "object" || !Array.isArray(fields)) return null;
  const fieldMap = {
    enabled: "enabled", strength: "strength", mode: "policy_mode", preset: "preset",
    messageCountThreshold: "message_count_threshold", messageWindowSeconds: "message_window_seconds",
    duplicateCountThreshold: "duplicate_count_threshold", duplicateWindowSeconds: "duplicate_window_seconds",
    mentionCountThreshold: "mention_count_threshold", mentionWindowSeconds: "mention_window_seconds",
    linkCountThreshold: "link_count_threshold", linkWindowSeconds: "link_window_seconds",
    crossChannelThreshold: "cross_channel_threshold", crossChannelWindowSeconds: "cross_channel_window_seconds",
    messageBurstEnabled: "message_burst_enabled", duplicateEnabled: "duplicate_enabled",
    mentionEnabled: "mention_enabled", linkEnabled: "link_enabled", crossChannelEnabled: "cross_channel_enabled",
    action: "action", ignoreBots: "ignore_bots", ignoreAdmins: "ignore_admins",
    ignoredRoleIds: "ignored_role_ids", ignoredChannelIds: "ignored_channel_ids",
  };
  const output = {};
  for (const field of fields) {
    const column = fieldMap[field];
    if (column) output[column] = policy[field];
  }
  return output;
}

export function isSpamProtectionActive(policy) {
  return Boolean(policy?.enabled && !(policy.mode === "STRENGTH" && policy.strength === 0));
}

export function canAccessGuildSpamPolicy(managedGuilds, guildId) {
  return discordIdPattern.test(String(guildId ?? "")) &&
    Array.isArray(managedGuilds) &&
    managedGuilds.some((guild) => guild?.id === guildId);
}

function normalizeIdList(value) {
  if (!Array.isArray(value) || value.length > SPAM_POLICY_LIMITS.ignoredIdMax) return null;
  const ids = [...new Set(value.map((item) => String(item)))];
  return ids.every((id) => discordIdPattern.test(id)) ? ids : null;
}

export function getSpamPolicyPreset(preset) {
  if (!Object.hasOwn(presetValues, preset)) return null;
  return Object.freeze({ preset, ...presetValues[preset] });
}

export function normalizeGuildSpamPolicy(input, { allowCustom = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const preset = String(input.preset ?? "");
  const mode = String(input.mode ?? (preset === "CUSTOM" ? "CUSTOM" : "STRENGTH"));
  const action = String(input.action ?? "");
  if (!SPAM_POLICY_PRESETS.includes(preset) || (!allowCustom && preset === "CUSTOM") || !SPAM_POLICY_MODES.includes(mode) || !SPAM_POLICY_ACTIONS.includes(action)) return null;
  const rawStrength = input.strength === undefined ? strengthForSpamPreset(preset) : input.strength;
  const strength = rawStrength === null ? null : rawStrength;
  if ((mode === "STRENGTH" && !isIntegerStrength(strength)) || (strength !== null && !isIntegerStrength(strength))) return null;
  if (mode === "CUSTOM" && (preset !== "CUSTOM" || strength !== null)) return null;
  const values = {};
  for (const key of thresholdKeys) {
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < SPAM_POLICY_LIMITS.thresholdMin || value > SPAM_POLICY_LIMITS.thresholdMax) return null;
    values[key] = value;
  }
  for (const key of windowKeys) {
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < SPAM_POLICY_LIMITS.windowMinSeconds || value > SPAM_POLICY_LIMITS.windowMaxSeconds) return null;
    values[key] = value;
  }
  const matches = (expected) => Boolean(expected) && thresholdKeys.concat(windowKeys).every((key) => values[key] === expected[key]);
  if (preset !== "CUSTOM" && !matches(presetValues[preset])) return null;
  if (mode === "STRENGTH" && preset === "CUSTOM" && !matches(strengthToSpamPolicy(strength))) return null;
  const ignoredRoleIds = normalizeIdList(input.ignoredRoleIds ?? []);
  const ignoredChannelIds = normalizeIdList(input.ignoredChannelIds ?? []);
  if (!ignoredRoleIds || !ignoredChannelIds) return null;
  const moduleValues = Object.fromEntries(SPAM_POLICY_MODULES.map((key) => [key, input[key] ?? true]));
  if (typeof input.enabled !== "boolean" || typeof input.ignoreBots !== "boolean" || typeof input.ignoreAdmins !== "boolean"
    || SPAM_POLICY_MODULES.some((key) => typeof moduleValues[key] !== "boolean")) return null;
  return {
    enabled: input.enabled,
    strength,
    mode,
    preset,
    ...values,
    ...moduleValues,
    action,
    ignoreBots: input.ignoreBots,
    ignoreAdmins: input.ignoreAdmins,
    ignoredRoleIds,
    ignoredChannelIds,
    updatedAt: input.updatedAt ?? null,
    updatedBy: input.updatedBy ?? null,
  };
}

export function policyFromPreset(preset, current = DEFAULT_GUILD_SPAM_POLICY) {
  if (preset === "CUSTOM") return { ...current, preset: "CUSTOM", mode: "CUSTOM", strength: null };
  const values = getSpamPolicyPreset(preset);
  if (!values) return null;
  return { ...current, ...values, mode: "STRENGTH", strength: strengthForSpamPreset(preset) };
}

export function withCustomPresetOnManualChange(policy, key, value) {
  if (!thresholdKeys.includes(key) && !windowKeys.includes(key)) return { ...policy, [key]: value };
  return { ...policy, [key]: value, preset: "CUSTOM", mode: "CUSTOM", strength: null };
}

export function shouldApplyGuildSpamPolicy({ policy, isBot = false, isOwnBot = false, isWebhook = false, isAdmin = false, roleIds = [], channelId = "" }) {
  if (!isSpamProtectionActive(policy) || SPAM_POLICY_MODULES.every((module) => policy[module] === false) || isOwnBot || isWebhook) return { track: false, reason: "system_exclusion" };
  if (policy.ignoreBots && isBot) return { track: false, reason: "bot_exclusion" };
  if (policy.ignoreAdmins && isAdmin) return { track: false, reason: "admin_exclusion" };
  if (policy.ignoredChannelIds?.includes(String(channelId))) return { track: false, reason: "channel_exclusion" };
  if ((policy.ignoredRoleIds ?? []).some((id) => roleIds.includes(id))) return { track: false, reason: "role_exclusion" };
  return { track: true, reason: null };
}

export function resolveSpamPolicyAction({ isCustom, policy, source = isCustom ? "guild" : "default" }) {
  // A Guild with no policy row keeps the existing timeout + audit + alert flow.
  if (source === "fallback") return "LOG_ONLY";
  if (!isCustom) return "LEGACY_TIMEOUT";
  return SPAM_POLICY_ACTIONS.includes(policy?.action) ? policy.action : "LOG_ONLY";
}

export const GUILD_SPAM_POLICY_AUDIT_FIELDS = Object.freeze([
  "enabled", "strength", "mode", "preset", ...SPAM_POLICY_MODULES, "messageCountThreshold", "messageWindowSeconds",
  "duplicateCountThreshold", "duplicateWindowSeconds", "mentionCountThreshold",
  "mentionWindowSeconds", "linkCountThreshold", "linkWindowSeconds",
  "crossChannelThreshold", "crossChannelWindowSeconds", "action", "ignoreBots",
  "ignoreAdmins", "ignoredRoleIds", "ignoredChannelIds",
]);

export function getChangedSpamPolicyFields(previous, next) {
  return GUILD_SPAM_POLICY_AUDIT_FIELDS.filter((field) =>
    JSON.stringify(previous?.[field] ?? null) !== JSON.stringify(next?.[field] ?? null),
  );
}

export function countSpamLinks(content) {
  return String(content ?? "").match(/(?:https?:\/\/|www\.|discord\.gg\/)[^\s<>]+/gi)?.length ?? 0;
}

export function countSpamMentions({ userCount = 0, roleCount = 0, everyone = false } = {}) {
  return Math.max(0, Math.min(200, Number(userCount) || 0) + Math.min(200, Number(roleCount) || 0) + Number(Boolean(everyone)));
}

export function parseGuildSpamPolicyRow(row) {
  if (!row) return null;
  return normalizeGuildSpamPolicy({
    enabled: row.enabled,
    strength: row.strength ?? strengthForSpamPreset(row.preset),
    mode: row.policy_mode ?? (row.preset === "CUSTOM" ? "CUSTOM" : "STRENGTH"),
    preset: row.preset,
    messageCountThreshold: row.message_count_threshold,
    messageWindowSeconds: row.message_window_seconds,
    duplicateCountThreshold: row.duplicate_count_threshold,
    duplicateWindowSeconds: row.duplicate_window_seconds,
    mentionCountThreshold: row.mention_count_threshold,
    mentionWindowSeconds: row.mention_window_seconds,
    linkCountThreshold: row.link_count_threshold,
    linkWindowSeconds: row.link_window_seconds,
    crossChannelThreshold: row.cross_channel_threshold,
    crossChannelWindowSeconds: row.cross_channel_window_seconds,
    messageBurstEnabled: row.message_burst_enabled ?? true,
    duplicateEnabled: row.duplicate_enabled ?? true,
    mentionEnabled: row.mention_enabled ?? true,
    linkEnabled: row.link_enabled ?? true,
    crossChannelEnabled: row.cross_channel_enabled ?? true,
    action: row.action,
    ignoreBots: row.ignore_bots,
    ignoreAdmins: row.ignore_admins,
    ignoredRoleIds: row.ignored_role_ids,
    ignoredChannelIds: row.ignored_channel_ids,
    updatedAt: row.updated_at ?? null,
    updatedBy: row.updated_by ?? null,
  });
}

export function createGuildSpamPolicyCache({ loadPolicy, ttlMs = 30_000, maxEntries = 5_000, now = () => Date.now(), logger = console } = {}) {
  if (typeof loadPolicy !== "function") throw new TypeError("loadPolicy is required.");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive integer.");
  const cache = new Map();
  const inFlight = new Map();

  async function get(guildId) {
    const key = String(guildId);
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) return entry.value;
    const pending = inFlight.get(key);
    if (pending) return pending.promise;
    const load = { invalidated: false, promise: null };
    load.promise = (async () => {
      let value;
      try {
        const policy = await loadPolicy(key);
        value = { policy: policy ?? null, isCustom: Boolean(policy), source: policy ? "guild" : "default" };
      } catch (error) {
        const code = String(error?.code ?? error?.name ?? "POLICY_READ_FAILED").slice(0, 40);
        logger.warn?.(`[spam-policy] Guild policy read unavailable (${code}); using legacy defaults.`);
        value = { policy: null, isCustom: false, source: "fallback" };
      }
      const currentTime = now();
      for (const [cachedKey, cachedValue] of cache) {
        if (cachedValue.expiresAt <= currentTime) cache.delete(cachedKey);
      }
      if (!load.invalidated) {
        cache.delete(key);
        while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expiresAt: currentTime + ttlMs });
      }
      return value;
    })();
    inFlight.set(key, load);
    try {
      return await load.promise;
    } finally {
      if (inFlight.get(key) === load) inFlight.delete(key);
    }
  }

  return Object.freeze({
    get,
    invalidate(guildId) {
      if (guildId === undefined) {
        cache.clear();
        for (const load of inFlight.values()) load.invalidated = true;
        inFlight.clear();
      } else {
        const key = String(guildId);
        cache.delete(key);
        const load = inFlight.get(key);
        if (load) {
          load.invalidated = true;
          inFlight.delete(key);
        }
      }
    },
    get size() { return cache.size; },
  });
}

function textDigest(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

export function createGuildSpamDetectionTracker({ cooldownMs = 10 * 60_000 } = {}) {
  if (!Number.isInteger(cooldownMs) || cooldownMs < 1_000) throw new TypeError("cooldownMs must be at least 1000.");
  const windows = new Map();
  const cooldowns = new Map();

  function record({ guildId, userId, channelId, content, mentionCount = 0, linkCount = 0, policy, timestamp = Date.now() }) {
    const guild = String(guildId ?? "");
    const user = String(userId ?? "");
    const channel = String(channelId ?? "");
    if (!discordIdPattern.test(guild) || !discordIdPattern.test(user) || !discordIdPattern.test(channel)) return { detected: false, excluded: true, signals: [], count: 0, coolingDown: false };
    if (!isSpamProtectionActive(policy) || SPAM_POLICY_MODULES.every((module) => policy[module] === false)) {
      forgetUser(guild, user);
      return { detected: false, excluded: true, signals: [], count: 0, coolingDown: false };
    }
    if (policy.ignoredChannelIds?.includes(channel)) return { detected: false, excluded: true, signals: [], count: 0, coolingDown: false };
    const key = `${guild}:${user}`;
    const cooldownUntil = cooldowns.get(key) ?? 0;
    if (cooldownUntil > timestamp) return { detected: false, excluded: false, signals: [], count: 0, coolingDown: true, cooldownUntil };
    const maxWindowMs = Math.max(...windowKeys.map((name) => policy[name] * 1_000));
    const previous = (windows.get(key) ?? [])
      .filter((entry) => entry.timestamp >= timestamp - maxWindowMs)
      .map((entry) => ({
        ...entry,
        channelId: policy.crossChannelEnabled === false ? null : entry.channelId,
        digest: policy.duplicateEnabled === false ? null : entry.digest,
        mentionCount: policy.mentionEnabled === false ? 0 : entry.mentionCount,
        linkCount: policy.linkEnabled === false ? 0 : entry.linkCount,
      }));
    const current = {
      timestamp,
      channelId: policy.crossChannelEnabled === false ? null : channel,
      digest: policy.duplicateEnabled === false ? null : textDigest(content),
      mentionCount: policy.mentionEnabled === false ? 0 : Math.min(Number(mentionCount) || 0, 200),
      linkCount: policy.linkEnabled === false ? 0 : Math.min(Number(linkCount) || 0, 100),
    };
    const events = [...previous, current];
    const recent = (seconds) => events.filter((entry) => entry.timestamp >= timestamp - seconds * 1_000);
    const duplicateEvents = current.digest ? recent(policy.duplicateWindowSeconds).filter((entry) => entry.digest === current.digest) : [];
    const mentionTotal = recent(policy.mentionWindowSeconds).reduce((sum, entry) => sum + entry.mentionCount, 0);
    const linkTotal = recent(policy.linkWindowSeconds).reduce((sum, entry) => sum + entry.linkCount, 0);
    const channelTotal = new Set(recent(policy.crossChannelWindowSeconds).map((entry) => entry.channelId).filter(Boolean)).size;
    const signals = [];
    if (policy.messageBurstEnabled !== false && recent(policy.messageWindowSeconds).length >= policy.messageCountThreshold) signals.push("messages");
    if (policy.duplicateEnabled !== false && duplicateEvents.length >= policy.duplicateCountThreshold) signals.push("duplicates");
    if (policy.mentionEnabled !== false && mentionTotal >= policy.mentionCountThreshold) signals.push("mentions");
    if (policy.linkEnabled !== false && linkTotal >= policy.linkCountThreshold) signals.push("links");
    if (policy.crossChannelEnabled !== false && channelTotal >= policy.crossChannelThreshold) signals.push("cross_channel");
    if (signals.length) {
      const nextCooldownUntil = timestamp + cooldownMs;
      windows.delete(key);
      cooldowns.set(key, nextCooldownUntil);
      return { detected: true, excluded: false, signals, count: recent(policy.messageWindowSeconds).length, cooldownUntil: nextCooldownUntil, coolingDown: false };
    }
    windows.set(key, events);
    return { detected: false, excluded: false, signals: [], count: recent(policy.messageWindowSeconds).length, cooldownUntil: null, coolingDown: false };
  }

  function prune(timestamp = Date.now()) {
    for (const [key, entries] of windows) {
      if (!entries.length || entries.at(-1).timestamp < timestamp - 300_000) windows.delete(key);
    }
    for (const [key, until] of cooldowns) if (until <= timestamp) cooldowns.delete(key);
  }

  function forgetGuild(guildId) {
    const prefix = `${String(guildId)}:`;
    for (const key of windows.keys()) if (key.startsWith(prefix)) windows.delete(key);
    for (const key of cooldowns.keys()) if (key.startsWith(prefix)) cooldowns.delete(key);
  }

  function forgetUser(guildId, userId) {
    const key = `${String(guildId)}:${String(userId)}`;
    windows.delete(key);
    cooldowns.delete(key);
  }

  return Object.freeze({ record, prune, forgetGuild, forgetUser, get trackedWindowCount() { return windows.size; }, get cooldownCount() { return cooldowns.size; } });
}

export function getSpamPolicyAuditChanges(previous, next) {
  return Object.fromEntries(getChangedSpamPolicyFields(previous, next).map((field) => [field, {
    before: previous?.[field] ?? null,
    after: next?.[field] ?? null,
  }]));
}
