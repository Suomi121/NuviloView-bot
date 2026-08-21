import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_SECURITY_V1_POLICY,
  normalizeSecurityV1Policy,
} from "./security-v1.mjs";

export const NUKE_PROTECTION_SCHEMA_VERSION = 2;
export const SECURITY_INCIDENT_STATUSES = Object.freeze([
  "Open", "Contained", "Monitoring", "Resolved", "FalsePositive",
]);

export const DEFAULT_RISK_WEIGHTS = Object.freeze({
  CHANNEL_DELETE: 25,
  ROLE_DELETE: 25,
  ADMINISTRATOR_GRANT: 30,
  DANGEROUS_PERMISSION: 20,
  MEMBER_BAN: 8,
  MEMBER_KICK: 6,
  WEBHOOK_CREATE: 10,
  WEBHOOK_DELETE: 10,
  BOT_ADDITION: 15,
  INTEGRATION_DELETE: 15,
  GUILD_SETTING_CHANGE: 15,
});

export const DEFAULT_SEVERITY_THRESHOLDS = Object.freeze({
  suspicious: 30,
  high: 60,
  critical: 90,
});

export const SENSITIVITY_THRESHOLDS = Object.freeze({
  low: Object.freeze({ suspicious: 40, high: 75, critical: 95 }),
  balanced: DEFAULT_SEVERITY_THRESHOLDS,
  high: Object.freeze({ suspicious: 20, high: 45, critical: 75 }),
});

export const DEFAULT_TIME_WINDOWS_MS = Object.freeze([
  10_000,
  30_000,
  60_000,
  5 * 60_000,
]);

export const DEFAULT_BURST_RULES = Object.freeze([
  { id: "destructive-3-in-10s", windowMs: 10_000, minimum: 3, bonus: 20, destructiveOnly: true },
  { id: "destructive-5-in-30s", windowMs: 30_000, minimum: 5, bonus: 40, destructiveOnly: true },
  { id: "mixed-actions-in-60s", windowMs: 60_000, minimum: 2, bonus: 15, distinctTypes: true },
]);

export const DEFAULT_NUKE_PROTECTION_POLICY = Object.freeze({
  enabled: true,
  mode: "shadow",
  sensitivity: "balanced",
  alertEnabled: true,
  manualContainment: true,
  automaticContainment: false,
  snapshotEnabled: true,
  ...DEFAULT_SECURITY_V1_POLICY,
  riskWeights: DEFAULT_RISK_WEIGHTS,
  thresholds: DEFAULT_SEVERITY_THRESHOLDS,
  snapshotRetentionCount: 7,
  snapshotRetentionDays: 30,
  incidentRetentionDays: 90,
});

export const DESTRUCTIVE_ACTION_TYPES = new Set([
  "CHANNEL_DELETE",
  "ROLE_DELETE",
  "MEMBER_BAN",
  "MEMBER_KICK",
  "WEBHOOK_DELETE",
  "INTEGRATION_DELETE",
]);

const DANGEROUS_PERMISSION_NAMES = new Set([
  "Administrator",
  "ManageGuild",
  "ManageChannels",
  "ManageRoles",
  "BanMembers",
  "KickMembers",
  "ManageWebhooks",
]);

function integerInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function recordOfNonNegativeIntegers(value, defaults, maximum = 1_000) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
    key,
    integerInRange(input[key], fallback, 0, maximum),
  ]));
}

export function normalizeNukeProtectionPolicy(input = {}) {
  const mode = ["shadow", "monitor", "manual", "protect", "strict"].includes(input.mode)
    ? input.mode
    : "shadow";
  const sensitivity = ["low", "balanced", "high", "custom"].includes(input.sensitivity)
    ? input.sensitivity
    : "balanced";
  let thresholds = recordOfNonNegativeIntegers(
    input.thresholds,
    DEFAULT_SEVERITY_THRESHOLDS,
    10_000,
  );
  if (!(thresholds.suspicious < thresholds.high && thresholds.high < thresholds.critical)) {
    thresholds = { ...DEFAULT_SEVERITY_THRESHOLDS };
  }
  if (sensitivity !== "custom") thresholds = { ...SENSITIVITY_THRESHOLDS[sensitivity] };
  const securityV1 = normalizeSecurityV1Policy(input);
  const automaticMode = mode === "protect" || mode === "strict";
  return {
    enabled: input.enabled !== false,
    mode,
    sensitivity,
    alertEnabled: input.alertEnabled !== false,
    alertChannelId: /^\d{16,22}$/.test(String(input.alertChannelId ?? ""))
      ? String(input.alertChannelId)
      : null,
    manualContainment: input.manualContainment !== false,
    ...securityV1,
    automaticContainment: automaticMode && securityV1.automaticContainment,
    autoRestore: automaticMode && securityV1.autoRestore,
    snapshotEnabled: input.snapshotEnabled !== false,
    riskWeights: recordOfNonNegativeIntegers(input.riskWeights, DEFAULT_RISK_WEIGHTS),
    thresholds,
    snapshotRetentionCount: integerInRange(input.snapshotRetentionCount, 7, 1, 30),
    snapshotRetentionDays: integerInRange(input.snapshotRetentionDays, 30, 1, 365),
    incidentRetentionDays: integerInRange(input.incidentRetentionDays, 90, 7, 730),
  };
}

export function severityForRisk(riskScore, thresholds = DEFAULT_SEVERITY_THRESHOLDS) {
  if (riskScore >= thresholds.critical) return "Critical";
  if (riskScore >= thresholds.high) return "High";
  if (riskScore >= thresholds.suspicious) return "Suspicious";
  return "Normal";
}

function occurredAtMs(action) {
  const value = action.occurredAt instanceof Date
    ? action.occurredAt.getTime()
    : new Date(action.occurredAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function calculateNukeRisk(actions, options = {}) {
  const policy = normalizeNukeProtectionPolicy(options.policy);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const windowed = actions.filter((action) => {
    const age = now - occurredAtMs(action);
    return age >= -5_000 && age <= DEFAULT_TIME_WINDOWS_MS.at(-1);
  });
  const baseItems = windowed.map((action) => ({
    actionType: action.actionType,
    count: 1,
    points: integerInRange(
      action.riskWeight,
      policy.riskWeights[action.actionType] ?? 0,
      0,
      1_000,
    ),
  }));
  const baseRisk = baseItems.reduce((sum, item) => sum + item.points, 0);
  const bonuses = [];
  for (const rule of DEFAULT_BURST_RULES) {
    const recent = windowed.filter((action) => {
      const withinWindow = now - occurredAtMs(action) <= rule.windowMs;
      return withinWindow && (!rule.destructiveOnly || action.destructive === true);
    });
    const qualifies = rule.distinctTypes
      ? new Set(recent.map((action) => action.actionType)).size >= rule.minimum
      : recent.length >= rule.minimum;
    if (qualifies) bonuses.push({ id: rule.id, points: rule.bonus, windowMs: rule.windowMs });
  }
  const rawRisk = baseRisk + bonuses.reduce((sum, bonus) => sum + bonus.points, 0);
  const suppressed = options.trustedActor === true || options.guildOwner === true || options.selfActor === true;
  const riskScore = suppressed ? 0 : Math.min(100, rawRisk);
  return {
    riskScore,
    rawRisk,
    severity: severityForRisk(riskScore, policy.thresholds),
    suppressed,
    actionCount: windowed.length,
    distinctActionTypes: [...new Set(windowed.map((action) => action.actionType))],
    baseItems,
    bonuses,
    windowStart: new Date(now - DEFAULT_TIME_WINDOWS_MS.at(-1)).toISOString(),
    windowEnd: new Date(now).toISOString(),
  };
}

export function shouldCorrelateIncident(incident, action, options = {}) {
  if (!incident || !action) return false;
  if (incident.guildId !== action.guildId) return false;
  if ((incident.actorId ?? null) !== (action.actorId ?? null)) return false;
  if (!["Open", "Monitoring"].includes(incident.status)) return false;
  const windowMs = integerInRange(options.windowMs, 5 * 60_000, 1_000, 30 * 60_000);
  const delta = occurredAtMs(action) - new Date(incident.lastDetectedAt).getTime();
  return delta >= -30_000 && delta <= windowMs;
}

export function sanitizeSecurityMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const safeKeys = new Set([
    "targetName", "targetType", "channelId", "roleId", "permissionNames",
    "changeKeys", "reasonPresent", "source", "auditAction", "guildName",
    "messageId", "fingerprint", "detector", "operationCount", "windowSeconds",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!safeKeys.has(key)) continue;
    if (typeof value === "string") result[key] = value.slice(0, 256);
    else if (typeof value === "boolean" || typeof value === "number") result[key] = value;
    else if (Array.isArray(value)) {
      result[key] = value
        .filter((item) => typeof item === "string")
        .slice(0, 25)
        .map((item) => item.slice(0, 128));
    }
  }
  return result;
}

export function buildContainmentPlan(input) {
  if (!input.actorId) return { allowed: false, code: "UNKNOWN_ACTOR", removableRoleIds: [] };
  if (input.actorId === input.guildOwnerId) return { allowed: false, code: "GUILD_OWNER", removableRoleIds: [] };
  if (input.actorId === input.selfBotId) return { allowed: false, code: "SELF_ACTOR", removableRoleIds: [] };
  if (input.trustedActor) return { allowed: false, code: "TRUSTED_ACTOR", removableRoleIds: [] };
  if (!input.memberPresent) return { allowed: false, code: "MEMBER_NOT_FOUND", removableRoleIds: [] };
  if (!input.botCanManageRoles) return { allowed: false, code: "MISSING_MANAGE_ROLES", removableRoleIds: [] };
  const roles = Array.isArray(input.roles) ? input.roles : [];
  const removableRoleIds = roles
    .filter((role) => (
      role.id !== input.guildId &&
      role.managed !== true &&
      Number(role.position) < Number(input.botHighestRolePosition) &&
      Array.isArray(role.permissionNames) &&
      role.permissionNames.some((permission) => DANGEROUS_PERMISSION_NAMES.has(permission))
    ))
    .map((role) => String(role.id));
  if (removableRoleIds.length === 0) {
    return { allowed: false, code: "NO_REMOVABLE_DANGEROUS_ROLES", removableRoleIds: [] };
  }
  return { allowed: true, code: "OK", removableRoleIds };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function createSecuritySnapshot(input) {
  const document = {
    schemaVersion: NUKE_PROTECTION_SCHEMA_VERSION,
    snapshotId: input.snapshotId ?? randomUUID(),
    guildId: String(input.guildId),
    guildName: String(input.guildName ?? ""),
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: String(input.source ?? "manual"),
    channels: Array.isArray(input.channels) ? input.channels : [],
    roles: Array.isArray(input.roles) ? input.roles : [],
  };
  const serialized = JSON.stringify(stableValue(document));
  return {
    ...document,
    checksum: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function buildRestorePreview(snapshot, current) {
  const currentChannels = new Map((current?.channels ?? []).map((item) => [String(item.id), item]));
  const currentRoles = new Map((current?.roles ?? []).map((item) => [String(item.id), item]));
  const deletedChannels = (snapshot?.channels ?? []).filter((item) => !currentChannels.has(String(item.id)));
  const missingRoles = (snapshot?.roles ?? []).filter((item) => !currentRoles.has(String(item.id)));
  const deletedRoles = missingRoles.filter((item) => !item.isEveryone && !item.managed);
  const unrestorableRoles = missingRoles.filter((item) => item.isEveryone || item.managed);
  const permissionChanges = [];
  for (const channel of snapshot?.channels ?? []) {
    const existing = currentChannels.get(String(channel.id));
    if (!existing) continue;
    if (JSON.stringify(stableValue(channel.permissionOverwrites ?? [])) !== JSON.stringify(stableValue(existing.permissionOverwrites ?? []))) {
      permissionChanges.push({ id: String(channel.id), name: String(channel.name ?? ""), targetType: "channel" });
    }
  }
  for (const role of snapshot?.roles ?? []) {
    const existing = currentRoles.get(String(role.id));
    if (!existing) continue;
    if (String(role.permissions ?? "0") !== String(existing.permissions ?? "0")) {
      permissionChanges.push({ id: String(role.id), name: String(role.name ?? ""), targetType: "role" });
    }
  }
  const safeToRestore = [
    ...deletedChannels.map((item) => ({ targetType: "channel", oldId: String(item.id), name: String(item.name ?? "") })),
    ...deletedRoles.map((item) => ({ targetType: "role", oldId: String(item.id), name: String(item.name ?? "") })),
  ];
  return {
    snapshotId: snapshot?.snapshotId ?? null,
    generatedAt: new Date().toISOString(),
    deletedChannelCount: deletedChannels.length,
    deletedRoleCount: deletedRoles.length,
    permissionChangeCount: permissionChanges.length,
    safeToRestore,
    requiresConfirmation: permissionChanges,
    cannotRestore: unrestorableRoles.map((item) => ({
      targetType: "role",
      oldId: String(item.id),
      name: String(item.name ?? ""),
      reason: item.isEveryone ? "EVERYONE_ROLE" : "MANAGED_ROLE",
    })),
    automaticRestoreAvailable: false,
    warning: "Snapshotに基づくbest-effort previewです。完全な復元は保証されません。",
  };
}

export function selectRetainedSnapshots(snapshots, options = {}) {
  const maximum = integerInRange(options.maximum, 7, 1, 30);
  const retentionDays = integerInRange(options.retentionDays, 30, 1, 365);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return [...snapshots]
    .filter((snapshot) => now - new Date(snapshot.createdAt).getTime() <= retentionDays * 86_400_000)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, maximum);
}
