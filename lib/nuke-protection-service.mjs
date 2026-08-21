import {
  AuditLogEvent,
  ChannelType,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { createHash, randomUUID } from "node:crypto";
import {
  DESTRUCTIVE_ACTION_TYPES,
  buildContainmentPlan,
  buildRestorePreview,
  calculateNukeRisk,
  createSecuritySnapshot,
  normalizeNukeProtectionPolicy,
  resolveNukeProtectionMode,
  sanitizeSecurityMetadata,
} from "./nuke-protection.mjs";
import {
  SECURITY_V1_INCIDENT_TYPES,
  SecurityV1WindowTracker,
  executeBestEffort,
  getSecurityV1Detector,
  hasEveryoneOrHereMention,
  shouldMonitorSecurityV1Actor,
  summarizeBestEffort,
} from "./security-v1.mjs";

const INCIDENT_CORRELATION_MS = 5 * 60_000;
const severityRanks = Object.freeze({ Normal: 0, Suspicious: 1, High: 2, Critical: 3 });
const dangerousPermissionFlags = Object.freeze([
  ["Administrator", PermissionFlagsBits.Administrator],
  ["ManageGuild", PermissionFlagsBits.ManageGuild],
  ["ManageChannels", PermissionFlagsBits.ManageChannels],
  ["ManageRoles", PermissionFlagsBits.ManageRoles],
  ["BanMembers", PermissionFlagsBits.BanMembers],
  ["KickMembers", PermissionFlagsBits.KickMembers],
  ["ManageWebhooks", PermissionFlagsBits.ManageWebhooks],
]);

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function idOf(value) {
  const stringValue = value === null || value === undefined ? "" : String(value);
  return /^\d{16,22}$/.test(stringValue) ? stringValue : null;
}

function toPermissionBits(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function addedDangerousPermissions(oldValue, newValue) {
  const oldBits = toPermissionBits(oldValue);
  const newBits = toPermissionBits(newValue);
  return dangerousPermissionFlags
    .filter(([, flag]) => (newBits & flag) === flag && (oldBits & flag) !== flag)
    .map(([name]) => name);
}

function permissionChange(entry) {
  return entry.changes?.find((change) => change.key === "permissions" || change.key === "allow") ?? null;
}

function addedRoleIds(entry) {
  const additions = entry.changes?.find((change) => change.key === "$add")?.new;
  return Array.isArray(additions)
    ? additions.map((role) => idOf(role?.id)).filter(Boolean)
    : [];
}

export function classifyAuditEntry(entry, guild) {
  let actionType = null;
  let securityV1ActionType = null;
  let permissionNames = [];
  switch (entry.action) {
    case AuditLogEvent.ChannelCreate: actionType = "CHANNEL_CREATE"; break;
    case AuditLogEvent.ChannelDelete: actionType = "CHANNEL_DELETE"; break;
    case AuditLogEvent.RoleDelete: actionType = "ROLE_DELETE"; break;
    case AuditLogEvent.MemberBanAdd: actionType = "MEMBER_BAN"; break;
    case AuditLogEvent.MemberKick: actionType = "MEMBER_KICK"; break;
    case AuditLogEvent.WebhookCreate: actionType = "WEBHOOK_CREATE"; break;
    case AuditLogEvent.WebhookDelete: actionType = "WEBHOOK_DELETE"; break;
    case AuditLogEvent.BotAdd: actionType = "BOT_ADDITION"; break;
    case AuditLogEvent.IntegrationDelete: actionType = "INTEGRATION_DELETE"; break;
    case AuditLogEvent.GuildUpdate: actionType = "GUILD_SETTING_CHANGE"; break;
    case AuditLogEvent.RoleCreate: {
      securityV1ActionType = "ROLE_CREATE";
      const change = permissionChange(entry);
      permissionNames = addedDangerousPermissions(change?.old, change?.new);
      if (permissionNames.includes("Administrator")) actionType = "ADMINISTRATOR_GRANT";
      else if (permissionNames.length > 0) actionType = "DANGEROUS_PERMISSION";
      else actionType = "ROLE_CREATE";
      break;
    }
    case AuditLogEvent.RoleUpdate: {
      const change = permissionChange(entry);
      permissionNames = addedDangerousPermissions(change?.old, change?.new);
      if (permissionNames.includes("Administrator")) actionType = "ADMINISTRATOR_GRANT";
      else if (permissionNames.length > 0) actionType = "DANGEROUS_PERMISSION";
      break;
    }
    case AuditLogEvent.MemberRoleUpdate: {
      const addedRoles = addedRoleIds(entry)
        .map((roleId) => guild.roles.cache.get(roleId))
        .filter(Boolean);
      permissionNames = [...new Set(addedRoles.flatMap((role) => role.permissions.toArray())
        .filter((name) => dangerousPermissionFlags.some(([candidate]) => candidate === name)))];
      if (permissionNames.includes("Administrator")) actionType = "ADMINISTRATOR_GRANT";
      else if (permissionNames.length > 0) actionType = "DANGEROUS_PERMISSION";
      break;
    }
    case AuditLogEvent.ChannelOverwriteCreate:
    case AuditLogEvent.ChannelOverwriteUpdate: {
      const change = permissionChange(entry);
      permissionNames = addedDangerousPermissions(change?.old, change?.new);
      if (permissionNames.length > 0) actionType = "DANGEROUS_PERMISSION";
      break;
    }
    default:
      break;
  }
  if (!actionType) return null;
  const target = entry.target;
  const targetName = typeof target?.name === "string"
    ? target.name
    : typeof target?.username === "string"
      ? target.username
      : null;
  return {
    actionType,
    securityV1ActionType,
    destructive: DESTRUCTIVE_ACTION_TYPES.has(actionType),
    metadata: sanitizeSecurityMetadata({
      targetName,
      targetType: target?.constructor?.name ?? null,
      permissionNames,
      changeKeys: entry.changes?.map((change) => String(change.key)) ?? [],
      reasonPresent: Boolean(entry.reason),
      auditAction: String(entry.action),
      source: "guildAuditLogEntryCreate",
    }),
  };
}

function safeError(error) {
  if (!error) return "Unknown error";
  return String(error.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function incidentAlertBody(incident, actionSummary) {
  const actor = incident.actorId ? `User ${incident.actorId}` : "Unknown Actor";
  return [
    `${incident.severity} security incident detected`,
    `Actor: ${actor}`,
    `Risk: ${incident.riskScore} / 100`,
    `Activity: ${actionSummary}`,
    "NuviloView: manual review required",
  ].join("\n");
}

function actionSummaryFromRows(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.actionType, (counts.get(row.actionType) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${type} ×${count}`).join(", ");
}

function serializeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    position: Number(channel.rawPosition ?? channel.position ?? 0),
    topic: typeof channel.topic === "string" ? channel.topic : null,
    nsfw: channel.nsfw === true,
    rateLimitPerUser: Number(channel.rateLimitPerUser ?? 0),
    bitrate: Number(channel.bitrate ?? 0),
    userLimit: Number(channel.userLimit ?? 0),
    permissionOverwrites: channel.permissionOverwrites?.cache
      ? [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield.toString(),
          deny: overwrite.deny.bitfield.toString(),
        })).sort((a, b) => a.id.localeCompare(b.id))
      : [],
  };
}

function serializeRole(role, guildId) {
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    permissions: role.permissions.bitfield.toString(),
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    managed: role.managed,
    isEveryone: role.id === guildId,
  };
}

export async function executeContainmentRoleRemovals({ member, roleIds, reason }) {
  const removedRoleIds = [];
  const failures = [];
  for (const roleId of roleIds) {
    try {
      await member.roles.remove(roleId, reason);
      removedRoleIds.push(roleId);
    } catch (error) {
      failures.push({ roleId, error: safeError(error) });
    }
  }
  return {
    status: removedRoleIds.length === 0 ? "failed" : failures.length ? "partial" : "contained",
    removedRoleIds,
    failures,
  };
}

export async function executeSecurityKick({ member, reason }) {
  if (!member || typeof member.kick !== "function") {
    return { kicked: false, error: "MEMBER_NOT_FOUND" };
  }
  try {
    await member.kick(reason);
    return { kicked: true, error: null };
  } catch (error) {
    return { kicked: false, error: safeError(error) };
  }
}

export function createNukeProtectionService({ client, sql, environment = process.env, logger = console }) {
  const globallyEnabled = asBoolean(environment.NUVILOVIEW_NUKE_PROTECTION, false);
  const tracker = new SecurityV1WindowTracker();
  const policyCache = new Map();
  const trustedCache = new Map();
  const incidentLocks = new Map();
  // Dashboard changes are made in a separate process. Keep this deliberately
  // short so OFF takes effect without restarting the Bot.
  const configuredPolicyCacheMs = Number(environment.NUVILOVIEW_NUKE_POLICY_CACHE_MS ?? 2_000);
  const POLICY_CACHE_MS = Number.isFinite(configuredPolicyCacheMs)
    ? Math.min(10_000, Math.max(0, configuredPolicyCacheMs))
    : 2_000;
  const TRUSTED_CACHE_MS = 60_000;
  let requestPolling = false;

  async function loadPolicy(guildId) {
    const cached = policyCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const rows = await sql`
      SELECT * FROM "security_policy" WHERE "guildId" = ${guildId} LIMIT 1
    `;
    if (!rows[0]) {
      await sql`
        INSERT INTO "security_policy" ("guildId", "enabled", "nukeProtectionMode", "mode", "createdAt", "updatedAt")
        VALUES (${guildId}, true, 'shadow', 'shadow', now(), now())
        ON CONFLICT ("guildId") DO NOTHING
      `;
    }
    const row = rows[0] ?? {};
    const value = {
      ...normalizeNukeProtectionPolicy({
        ...row,
        riskWeights: row.riskWeights,
        thresholds: row.thresholds,
      }),
      protectionStatus: row.protectionStatus ?? "Disabled",
      statusReason: row.statusReason ?? null,
      missingPermissions: Array.isArray(row.missingPermissions) ? row.missingPermissions : [],
    };
    policyCache.set(guildId, { value, expiresAt: Date.now() + POLICY_CACHE_MS });
    return value;
  }

  function effectiveMode(policy) {
    return resolveNukeProtectionMode({
      globallyEnabled,
      guildEnabled: policy?.enabled !== false,
      mode: policy?.nukeProtectionMode,
    });
  }

  async function withIncidentLock(key, worker) {
    const previous = incidentLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    incidentLocks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await worker();
    } finally {
      release();
      if (incidentLocks.get(key) === queued) incidentLocks.delete(key);
    }
  }

  async function diagnoseGuild(guild) {
    let status = "Active";
    let reason = null;
    let missingPermissions = [];
    try {
      const policy = await loadPolicy(guild.id);
      const nukeMode = effectiveMode(policy);
      if (nukeMode === "off") {
        status = "Disabled";
        reason = globallyEnabled ? "Nuke Protection v2 is disabled for this Guild" : "NUVILOVIEW_NUKE_PROTECTION is disabled";
        await sql`
          UPDATE "security_policy"
          SET "protectionStatus" = ${status}, "statusReason" = ${reason},
              "missingPermissions" = '[]'::jsonb, "lastDiagnosticAt" = now(), "updatedAt" = now()
          WHERE "guildId" = ${guild.id}
        `;
        return { status, reason, missingPermissions };
      }
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      const hasGatewayIntent = client.options.intents.has(GatewayIntentBits.GuildModeration);
      const protectiveMode = policy.mode === "protect" || policy.mode === "strict";
      const permissionChecks = new Map([
        ["ViewAuditLog", PermissionFlagsBits.ViewAuditLog],
      ]);
      if (policy.manualContainment && ["manual", "protect", "strict"].includes(policy.mode)) {
        permissionChecks.set("ManageRoles", PermissionFlagsBits.ManageRoles);
      }
      if (protectiveMode && policy.autoRestore && policy.channelProtection) {
        permissionChecks.set("ManageChannels", PermissionFlagsBits.ManageChannels);
      }
      if (protectiveMode && policy.autoRestore && policy.roleProtection) {
        permissionChecks.set("ManageRoles", PermissionFlagsBits.ManageRoles);
      }
      if (protectiveMode && policy.autoRestore && policy.webhookProtection) {
        permissionChecks.set("ManageWebhooks", PermissionFlagsBits.ManageWebhooks);
      }
      if (protectiveMode && policy.automaticContainment) {
        permissionChecks.set("KickMembers", PermissionFlagsBits.KickMembers);
      }
      if (protectiveMode && policy.botSpamProtection) {
        permissionChecks.set("ManageMessages", PermissionFlagsBits.ManageMessages);
      }
      missingPermissions = [...permissionChecks]
        .filter(([, permission]) => !botMember.permissions.has(permission))
        .map(([name]) => name);
      if (!hasGatewayIntent) {
        status = "Limited";
        reason = "GUILD_MODERATION gateway intent is missing";
      } else if (!botMember.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        status = "Limited";
        reason = "VIEW_AUDIT_LOG permission is missing";
      } else if (policy.alertEnabled && policy.alertChannelId && !guild.channels.cache.has(policy.alertChannelId)) {
        status = "Limited";
        reason = "Configured security alert channel is unavailable; dashboard detection remains active";
      } else if (missingPermissions.length > 0) {
        status = "Limited";
        reason = `Protection degraded: missing ${missingPermissions.join(", ")}`;
      } else if (nukeMode === "shadow") {
        reason = "Shadow mode: detection and evidence only";
      }
      await sql`
        UPDATE "security_policy"
        SET "protectionStatus" = ${status}, "statusReason" = ${reason},
            "missingPermissions" = ${JSON.stringify(missingPermissions)}::jsonb,
            "lastDiagnosticAt" = now(), "updatedAt" = now()
        WHERE "guildId" = ${guild.id}
      `;
    } catch (error) {
      status = "Error";
      reason = safeError(error);
      await sql`
        INSERT INTO "security_policy" ("guildId", "protectionStatus", "statusReason", "lastDiagnosticAt")
        VALUES (${guild.id}, 'Error', ${reason}, now())
        ON CONFLICT ("guildId") DO UPDATE SET
          "protectionStatus" = 'Error', "statusReason" = EXCLUDED."statusReason",
          "lastDiagnosticAt" = now(), "updatedAt" = now()
      `.catch(() => {});
    }
    logger.info("[Security] diagnostics", JSON.stringify({ guild: guild.id, status, reason }));
    return { status, reason, missingPermissions };
  }

  async function isTrustedActor(guildId, actorId) {
    if (!actorId) return false;
    const cacheKey = `${guildId}:${actorId}`;
    const cached = trustedCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const rows = await sql`
      SELECT 1 FROM "security_trusted_actor"
      WHERE "guildId" = ${guildId} AND "actorId" = ${actorId}
      LIMIT 1
    `;
    const value = Boolean(rows[0]);
    trustedCache.set(cacheKey, { value, expiresAt: Date.now() + TRUSTED_CACHE_MS });
    return value;
  }

  async function sendIncidentAlert(guild, policy, incident, actionRows) {
    if (!policy.alertEnabled || !["High", "Critical"].includes(incident.severity)) return;
    const previousRank = severityRanks[incident.lastAlertedSeverity] ?? -1;
    if (previousRank >= severityRanks[incident.severity]) return;
    const summary = actionSummaryFromRows(actionRows);
    const body = incidentAlertBody(incident, summary);
    await sql`
      INSERT INTO "guild_alert_event" ("guildId", "type", "severity", "title", "body", "createdAt")
      VALUES (${guild.id}, ${`security_incident:${incident.id}`}, ${incident.severity.toLowerCase()},
        ${`${incident.severity} security incident`}, ${body}, now())
    `;
    let alertMessageId = incident.alertMessageId ?? null;
    const alertChannel = policy.alertChannelId ? guild.channels.cache.get(policy.alertChannelId) : null;
    if (alertChannel?.isTextBased() && typeof alertChannel.send === "function") {
      const payload = { content: `${body}\nDashboard: https://nuviloview-oem.vercel.app/dashboard/security?guildId=${guild.id}`, allowedMentions: { parse: [] } };
      try {
        if (alertMessageId && alertChannel.messages?.fetch) {
          const previous = await alertChannel.messages.fetch(alertMessageId).catch(() => null);
          if (previous) await previous.edit(payload);
          else alertMessageId = null;
        }
        if (!alertMessageId) alertMessageId = (await alertChannel.send(payload)).id;
      } catch (error) {
        logger.warn("[Security] Discord alert unavailable", JSON.stringify({ guild: guild.id, incident: incident.id, error: safeError(error) }));
      }
    }
    await sql`
      UPDATE "security_incident"
      SET "lastAlertedSeverity" = ${incident.severity}, "lastAlertedAt" = now(),
          "alertMessageId" = ${alertMessageId}, "updatedAt" = now()
      WHERE "id" = ${incident.id}
    `;
  }

  async function latestSnapshot(guildId) {
    const rows = await sql`
      SELECT "data" FROM "security_snapshot"
      WHERE "guildId" = ${guildId}
      ORDER BY "createdAt" DESC LIMIT 1
    `;
    return rows[0]?.data ?? null;
  }

  async function restoreDeletedConfiguration(guild, events) {
    const snapshot = await latestSnapshot(guild.id);
    if (!snapshot) return { status: "failed", reason: "SNAPSHOT_NOT_FOUND", rolesRestored: 0, categoriesRestored: 0, channelsRestored: 0, failures: [] };
    const deletedRoleIds = new Set(events.filter((event) => event.actionType === "ROLE_DELETE").map((event) => event.targetId).filter(Boolean));
    const deletedChannelIds = new Set(events.filter((event) => event.actionType === "CHANNEL_DELETE").map((event) => event.targetId).filter(Boolean));
    const roleIdMap = new Map([[guild.id, guild.id]]);
    const channelIdMap = new Map();
    const reason = "NuviloView Security v1 automatic recovery";
    const roleDefinitions = (snapshot.roles ?? [])
      .filter((role) => deletedRoleIds.has(String(role.id)) && !role.isEveryone && !role.managed)
      .sort((left, right) => Number(left.position) - Number(right.position));
    const roleResults = await executeBestEffort(roleDefinitions, async (role) => {
      const created = await guild.roles.create({
        name: String(role.name ?? "restored-role").slice(0, 100),
        permissions: BigInt(role.permissions ?? "0"),
        color: Number(role.color ?? 0),
        hoist: role.hoist === true,
        mentionable: role.mentionable === true,
        reason,
      });
      roleIdMap.set(String(role.id), created.id);
      return created;
    });

    const missingChannels = (snapshot.channels ?? []).filter((channel) => deletedChannelIds.has(String(channel.id)));
    const categories = missingChannels.filter((channel) => Number(channel.type) === ChannelType.GuildCategory).sort((a, b) => Number(a.position) - Number(b.position));
    const children = missingChannels.filter((channel) => Number(channel.type) !== ChannelType.GuildCategory).sort((a, b) => Number(a.position) - Number(b.position));
    const createChannel = async (channel) => {
      const permissionOverwrites = (channel.permissionOverwrites ?? []).map((overwrite) => ({
        id: roleIdMap.get(String(overwrite.id)) ?? String(overwrite.id),
        type: overwrite.type,
        allow: BigInt(overwrite.allow ?? "0"),
        deny: BigInt(overwrite.deny ?? "0"),
      }));
      const options = {
        name: String(channel.name ?? "restored-channel").slice(0, 100),
        type: Number(channel.type),
        parent: channelIdMap.get(String(channel.parentId))
          ?? (channel.parentId && guild.channels.cache.has(String(channel.parentId))
            ? String(channel.parentId)
            : null),
        permissionOverwrites,
        reason,
      };
      if (typeof channel.topic === "string") options.topic = channel.topic;
      if (channel.nsfw === true) options.nsfw = true;
      if (Number(channel.rateLimitPerUser) > 0) options.rateLimitPerUser = Number(channel.rateLimitPerUser);
      if (Number(channel.bitrate) > 0) options.bitrate = Number(channel.bitrate);
      if (Number(channel.userLimit) > 0) options.userLimit = Number(channel.userLimit);
      const created = await guild.channels.create(options);
      channelIdMap.set(String(channel.id), created.id);
      return created;
    };
    const categoryResults = await executeBestEffort(categories, createChannel);
    const channelResults = await executeBestEffort(children, createChannel);
    const positionItems = [
      ...roleResults.filter((item) => item.status === "restored").map((item) => ({ target: item.value, position: item.item.position })),
      ...categoryResults.filter((item) => item.status === "restored").map((item) => ({ target: item.value, position: item.item.position })),
      ...channelResults.filter((item) => item.status === "restored").map((item) => ({ target: item.value, position: item.item.position })),
    ];
    const positionResults = await executeBestEffort(positionItems, ({ target, position }) => target.setPosition(Number(position ?? 0), { reason }));
    const allResults = [...roleResults, ...categoryResults, ...channelResults, ...positionResults];
    const summary = summarizeBestEffort(allResults);
    return {
      status: summary.status,
      rolesRestored: roleResults.filter((item) => item.status === "restored").length,
      categoriesRestored: categoryResults.filter((item) => item.status === "restored").length,
      channelsRestored: channelResults.filter((item) => item.status === "restored").length,
      failures: allResults.filter((item) => item.status === "failed").map((item) => item.error),
    };
  }

  async function deleteMaliciousObjects(guild, events) {
    const reason = "NuviloView Security v1 malicious object cleanup";
    const targets = events.filter((event) => ["CHANNEL_CREATE", "ROLE_CREATE", "WEBHOOK_CREATE"].includes(event.actionType));
    const results = await executeBestEffort(targets, async (event) => {
      if (event.actionType === "CHANNEL_CREATE") {
        const channel = guild.channels.cache.get(event.targetId);
        if (!channel) throw new Error("CHANNEL_NOT_FOUND");
        await channel.delete(reason);
        return event.targetId;
      }
      if (event.actionType === "ROLE_CREATE") {
        const role = guild.roles.cache.get(event.targetId);
        if (!role || role.managed || role.id === guild.id) throw new Error("ROLE_NOT_REMOVABLE");
        await role.delete(reason);
        return event.targetId;
      }
      const webhooks = await guild.fetchWebhooks();
      const webhook = webhooks.get(event.targetId);
      if (!webhook) throw new Error("WEBHOOK_NOT_FOUND");
      await webhook.delete(reason);
      return event.targetId;
    });
    return { deleted: results.filter((item) => item.status === "restored").length, failures: results.filter((item) => item.status === "failed").map((item) => item.error) };
  }

  async function deleteSpamMessages(guild, events) {
    const results = await executeBestEffort(events, async (event) => {
      const channel = guild.channels.cache.get(event.channelId);
      if (!channel?.isTextBased() || !channel.messages?.fetch) throw new Error("CHANNEL_UNAVAILABLE");
      const message = await channel.messages.fetch(event.messageId);
      await message.delete();
      return event.messageId;
    });
    return { deleted: results.filter((item) => item.status === "restored").length, failures: results.filter((item) => item.status === "failed").map((item) => item.error) };
  }

  async function respondToSecurityV1Incident(guild, policy, incident, tracking) {
    const actionTaken = {
      kicked: false,
      messagesDeleted: 0,
      maliciousObjectsDeleted: 0,
      rolesRestored: 0,
      categoriesRestored: 0,
      channelsRestored: 0,
      failures: [],
    };
    const protectiveMode = effectiveMode(policy) === "active" && (policy.mode === "protect" || policy.mode === "strict");
    if (!protectiveMode) return { actionTaken, status: "Monitoring", containmentStatus: "monitor_only" };
    if (policy.automaticContainment && incident.actorId) {
      const member = await guild.members.fetch(incident.actorId).catch(() => null);
      const kick = await executeSecurityKick({ member, reason: `NuviloView Security incident ${incident.id}`.slice(0, 512) });
      actionTaken.kicked = kick.kicked;
      if (kick.error) actionTaken.failures.push(`kick:${kick.error}`);
    }
    if ([SECURITY_V1_INCIDENT_TYPES.DUPLICATE_SPAM, SECURITY_V1_INCIDENT_TYPES.EVERYONE_SPAM].includes(incident.incidentType)) {
      const deletion = await deleteSpamMessages(guild, tracking.events);
      actionTaken.messagesDeleted = deletion.deleted;
      actionTaken.failures.push(...deletion.failures.map((error) => `message:${error}`));
    } else if (policy.autoRestore) {
      const cleanup = await deleteMaliciousObjects(guild, tracking.events);
      actionTaken.maliciousObjectsDeleted = cleanup.deleted;
      actionTaken.failures.push(...cleanup.failures.map((error) => `cleanup:${error}`));
      const recovery = await restoreDeletedConfiguration(guild, tracking.events);
      actionTaken.rolesRestored = recovery.rolesRestored;
      actionTaken.categoriesRestored = recovery.categoriesRestored;
      actionTaken.channelsRestored = recovery.channelsRestored;
      if (recovery.reason) actionTaken.failures.push(`restore:${recovery.reason}`);
      actionTaken.failures.push(...recovery.failures.map((error) => `restore:${error}`));
    }
    const successfulActions = Number(actionTaken.kicked) + actionTaken.messagesDeleted + actionTaken.maliciousObjectsDeleted + actionTaken.rolesRestored + actionTaken.categoriesRestored + actionTaken.channelsRestored;
    const status = successfulActions > 0
      ? actionTaken.failures.length > 0 ? "Monitoring" : "Contained"
      : actionTaken.failures.length > 0 ? "Monitoring" : "Monitoring";
    return { actionTaken, status, containmentStatus: successfulActions > 0 ? (actionTaken.failures.length ? "partial" : "contained") : "not_available" };
  }

  async function persistSecurityV1Incident({ guild, actorId, actorName, tracking }) {
    const occurredAt = new Date(Math.max(...tracking.events.map((event) => event.occurredAt)));
    const recent = await sql`
      SELECT * FROM "security_incident"
      WHERE "guildId" = ${guild.id} AND "actorId" = ${actorId}
        AND "incidentType" = ${tracking.detector.incidentType}
        AND "lastDetectedAt" >= ${new Date(occurredAt.getTime() - INCIDENT_CORRELATION_MS)}
      ORDER BY "lastDetectedAt" DESC LIMIT 1
    `;
    if (recent[0]) return { duplicate: true, incident: recent[0] };
    const incidentId = randomUUID();
    const severity = tracking.detector.severity;
    const riskScore = severity === "Critical" ? 100 : 75;
    const explanation = {
      detector: tracking.events[0]?.actionType,
      operationCount: tracking.count,
      windowSeconds: Math.round(tracking.detector.windowMs / 1_000),
    };
    await sql`
      INSERT INTO "security_incident" (
        "id", "guildId", "actorId", "actorType", "actorName", "incidentType",
        "severity", "riskScore", "riskExplanation", "actionTaken", "status",
        "firstDetectedAt", "lastDetectedAt", "actionCount", "trustedActor",
        "guildOwner", "selfActor", "containmentStatus", "createdAt", "updatedAt"
      ) VALUES (
        ${incidentId}, ${guild.id}, ${actorId}, 'bot', ${actorName}, ${tracking.detector.incidentType},
        ${severity}, ${riskScore}, ${JSON.stringify(explanation)}::jsonb, '{}'::jsonb, 'Open',
        ${new Date(Math.min(...tracking.events.map((event) => event.occurredAt)))}, ${occurredAt},
        ${tracking.count}, false, false, false, 'not_requested', now(), now()
      )
    `;
    for (const event of tracking.events) {
      const auditLogEntryId = event.auditLogEntryId ?? `event:${event.actionType}:${event.messageId ?? randomUUID()}`;
      await sql`
        INSERT INTO "security_incident_action" (
          "incidentId", "guildId", "auditLogEntryId", "actionType", "actorId", "targetId",
          "occurredAt", "riskWeight", "destructive", "metadata", "createdAt"
        ) VALUES (
          ${incidentId}, ${guild.id}, ${auditLogEntryId}, ${event.actionType}, ${actorId}, ${event.targetId},
          ${new Date(event.occurredAt)}, 0, ${event.actionType.endsWith("DELETE")},
          ${JSON.stringify(sanitizeSecurityMetadata({
            targetName: event.targetName,
            channelId: event.channelId,
            messageId: event.messageId,
            fingerprint: event.fingerprint,
            detector: tracking.detector.incidentType,
            operationCount: tracking.count,
            windowSeconds: Math.round(tracking.detector.windowMs / 1_000),
          }))}::jsonb, now()
        ) ON CONFLICT ("auditLogEntryId") DO NOTHING
      `;
    }
    return { duplicate: false, incident: { id: incidentId, guildId: guild.id, actorId, actorName, incidentType: tracking.detector.incidentType, severity, riskScore } };
  }

  async function processSecurityV1Detection({ guild, policy, actorId, actorName, event }) {
    const trustedActor = actorId ? await isTrustedActor(guild.id, actorId) : false;
    if (!shouldMonitorSecurityV1Actor({ actorId, selfBotId: client.user?.id, trustedActor, actorIsBot: true })) return { suppressed: true };
    const tracking = tracker.record(event, policy);
    if (!tracking.detected) return tracking;
    const persisted = await persistSecurityV1Incident({ guild, actorId, actorName, tracking });
    if (persisted.duplicate) return { ...tracking, duplicate: true, incidentId: persisted.incident.id };
    const response = await respondToSecurityV1Incident(guild, policy, persisted.incident, tracking);
    await sql`
      UPDATE "security_incident"
      SET "actionTaken" = ${JSON.stringify(response.actionTaken)}::jsonb,
          "status" = ${response.status}, "containmentStatus" = ${response.containmentStatus}, "updatedAt" = now()
      WHERE "id" = ${persisted.incident.id}
    `;
    await sql`UPDATE "security_policy" SET "lastIncidentAt" = now(), "updatedAt" = now() WHERE "guildId" = ${guild.id}`;
    await sql`
      INSERT INTO "security_audit_event" ("guildId", "incidentId", "eventType", "actorId", "actorName", "source", "details")
      VALUES (${guild.id}, ${persisted.incident.id}, 'SecurityV1IncidentDetected', ${actorId}, ${actorName}, 'bot',
        ${JSON.stringify({ incidentType: persisted.incident.incidentType, response: response.actionTaken })}::jsonb)
    `;
    await sendIncidentAlert(guild, policy, persisted.incident, tracking.events);
    return { ...tracking, incidentId: persisted.incident.id, response };
  }

  async function isManagedIntegrationActor(guild, actorId) {
    if (!actorId) return false;
    let member = guild.members?.cache?.get(actorId) ?? null;
    if (!member && typeof guild.members?.fetch === "function") {
      member = await guild.members.fetch(actorId).catch(() => null);
    }
    if (!member?.roles?.cache) return false;
    return [...member.roles.cache.values()].some((role) => (
      role.managed === true && Boolean(role.tags?.integrationId)
    ));
  }

  async function handleAuditLogEntry(entry, guild, options = {}) {
    if (!globallyEnabled || !guild || !entry?.id) return null;
    const actorKey = idOf(entry.executorId ?? entry.userId ?? entry.executor?.id) ?? "unknown";
    return withIncidentLock(`${guild.id}:${actorKey}`, () => handleAuditLogEntryUnlocked(entry, guild, options));
  }

  async function handleAuditLogEntryUnlocked(entry, guild, options = {}) {
    if (!globallyEnabled || !guild || !entry?.id) return null;
    try {
      const policy = await loadPolicy(guild.id);
      // This is the per-Guild fast path. Nothing below it may classify an
      // action, correlate an actor, score risk, create incidents, or alert.
      if (effectiveMode(policy) === "off") return null;
      const classified = classifyAuditEntry(entry, guild);
      if (!classified) return null;
      const duplicate = await sql`
        SELECT "incidentId" FROM "security_incident_action"
        WHERE "auditLogEntryId" = ${String(entry.id)} LIMIT 1
      `;
      if (duplicate[0]) return { duplicate: true, incidentId: duplicate[0].incidentId };

      const actorId = idOf(entry.executorId ?? entry.userId ?? entry.executor?.id);
      const targetId = idOf(entry.targetId ?? entry.target?.id);
      const occurredAt = entry.createdAt instanceof Date ? entry.createdAt : new Date();
      const trustedActor = await isTrustedActor(guild.id, actorId);
      const guildOwner = actorId !== null && actorId === guild.ownerId;
      const selfActor = actorId !== null && actorId === client.user?.id;
      const managedIntegration = actorId !== null && await isManagedIntegrationActor(guild, actorId);
      const actorType = actorId === null ? "unknown" : entry.executor?.bot ? "bot" : "user";
      const actorName = entry.executor?.globalName ?? entry.executor?.username ?? null;
      const correlationConfidence = actorId === null
        ? "low"
        : options.correlationSource === "webhook_lookup" ? "medium" : "high";
      if (trustedActor || guildOwner || selfActor || managedIntegration) {
        return { suppressed: true };
      }
      const securityV1ActionType = classified.securityV1ActionType ?? classified.actionType;
      const securityV1Detector = getSecurityV1Detector(securityV1ActionType, policy);
      if (securityV1Detector) {
        if (actorType !== "bot") return null;
        return processSecurityV1Detection({
          guild,
          policy,
          actorId,
          actorName,
          event: {
            guildId: guild.id,
            actorId,
            actionType: securityV1ActionType,
            auditLogEntryId: String(entry.id),
            targetId,
            targetName: classified.metadata.targetName,
            correlationConfidence,
            occurredAt: occurredAt.getTime(),
          },
        });
      }
      const openIncidents = await sql`
        SELECT * FROM "security_incident"
        WHERE "guildId" = ${guild.id}
          AND "actorId" IS NOT DISTINCT FROM ${actorId}
          AND "incidentType" IS NULL
          AND "status" IN ('Open', 'Monitoring')
          AND "lastDetectedAt" >= ${new Date(occurredAt.getTime() - INCIDENT_CORRELATION_MS)}
          AND "lastDetectedAt" <= ${new Date(occurredAt.getTime() + 30_000)}
        ORDER BY "lastDetectedAt" DESC LIMIT 1
      `;
      const incidentId = openIncidents[0]?.id ?? randomUUID();
      if (!openIncidents[0]) {
        await sql`
          INSERT INTO "security_incident" (
            "id", "guildId", "actorId", "actorType", "actorName", "severity",
            "riskScore", "riskExplanation", "status", "firstDetectedAt",
            "lastDetectedAt", "actionCount", "trustedActor", "guildOwner", "selfActor",
            "containmentStatus", "createdAt", "updatedAt"
          ) VALUES (
            ${incidentId}, ${guild.id}, ${actorId}, ${actorType}, ${actorName}, 'Normal',
            0, ${JSON.stringify({})}::jsonb, 'Open', ${occurredAt}, ${occurredAt}, 0,
            ${trustedActor}, ${guildOwner}, ${selfActor}, 'not_requested', now(), now()
          )
        `;
      }
      const weight = Number(policy.riskWeights[classified.actionType] ?? 0);
      const inserted = await sql`
        INSERT INTO "security_incident_action" (
          "incidentId", "guildId", "auditLogEntryId", "actionType", "actorId",
          "targetId", "occurredAt", "riskWeight", "destructive", "metadata", "createdAt"
        ) VALUES (
          ${incidentId}, ${guild.id}, ${String(entry.id)}, ${classified.actionType}, ${actorId},
          ${targetId}, ${occurredAt}, ${weight}, ${classified.destructive},
          ${JSON.stringify(classified.metadata)}::jsonb, now()
        ) ON CONFLICT ("auditLogEntryId") DO NOTHING
        RETURNING "id"
      `;
      if (!inserted[0]) return { duplicate: true, incidentId };
      const windowRows = await sql`
        SELECT "actionType", "riskWeight", "destructive", "occurredAt"
        FROM "security_incident_action"
        WHERE "incidentId" = ${incidentId}
          AND "occurredAt" >= ${new Date(occurredAt.getTime() - 5 * 60_000)}
          AND "occurredAt" <= ${new Date(occurredAt.getTime() + 5_000)}
        ORDER BY "occurredAt" ASC
      `;
      const risk = calculateNukeRisk(windowRows, {
        now: occurredAt.getTime(),
        policy,
        trustedActor,
        guildOwner,
        selfActor,
        correlationConfidence,
      });
      await sql`
        UPDATE "security_incident"
        SET "severity" = ${risk.severity}, "riskScore" = ${risk.riskScore},
            "riskExplanation" = ${JSON.stringify(risk)}::jsonb,
            "lastDetectedAt" = GREATEST("lastDetectedAt", ${occurredAt}),
            "actionCount" = (SELECT count(*)::int FROM "security_incident_action" WHERE "incidentId" = ${incidentId}),
            "trustedActor" = ${trustedActor}, "guildOwner" = ${guildOwner}, "selfActor" = ${selfActor},
            "updatedAt" = now()
        WHERE "id" = ${incidentId}
      `;
      await sql`
        UPDATE "security_policy" SET "lastIncidentAt" = now(), "updatedAt" = now()
        WHERE "guildId" = ${guild.id}
      `;
      await sql`
        INSERT INTO "security_audit_event" (
          "guildId", "incidentId", "eventType", "actorId", "actorName", "source", "details", "createdAt"
        ) VALUES (
          ${guild.id}, ${incidentId}, 'IncidentActionRecorded', ${actorId}, ${actorName}, 'bot',
          ${JSON.stringify({ auditLogEntryId: String(entry.id), actionType: classified.actionType, severity: risk.severity, riskScore: risk.riskScore })}::jsonb,
          now()
        )
      `;
      if (openIncidents[0] && openIncidents[0].severity !== risk.severity) {
        await sql`
          INSERT INTO "security_audit_event" (
            "guildId", "incidentId", "eventType", "actorId", "actorName", "source", "details", "createdAt"
          ) VALUES (
            ${guild.id}, ${incidentId}, 'IncidentSeverityChanged', ${actorId}, ${actorName}, 'bot',
            ${JSON.stringify({ from: openIncidents[0].severity, to: risk.severity, riskScore: risk.riskScore })}::jsonb,
            now()
          )
        `;
      }
      const incident = {
        ...(openIncidents[0] ?? {}),
        id: incidentId,
        guildId: guild.id,
        actorId,
        actorName,
        severity: risk.severity,
        riskScore: risk.riskScore,
      };
      logger.info("[Security] incident", JSON.stringify({ guild: guild.id, actor: actorId ?? "unknown", action: classified.actionType, risk: risk.riskScore, incident: incidentId }));
      await sendIncidentAlert(guild, policy, incident, windowRows);
      return { incidentId, risk };
    } catch (error) {
      logger.error("[Security] engine error", JSON.stringify({ guild: guild?.id, auditEntry: String(entry?.id ?? "unknown"), error: safeError(error) }));
      await sql`
        UPDATE "security_policy" SET "protectionStatus" = 'Error', "statusReason" = ${safeError(error)}, "updatedAt" = now()
        WHERE "guildId" = ${guild.id}
      `.catch(() => {});
      return null;
    }
  }

  async function handleWebhookUpdate(channel) {
    const guild = channel?.guild;
    if (!globallyEnabled || !guild) return null;
    const policy = await loadPolicy(guild.id).catch(() => null);
    if (!policy || effectiveMode(policy) === "off") return null;
    for (const delayMs of [0, 350, 900]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 6 });
        const entry = logs.entries.find((candidate) => {
          const createdAt = candidate.createdAt instanceof Date ? candidate.createdAt.getTime() : 0;
          const candidateChannelId = idOf(candidate.extra?.channel?.id ?? candidate.extra?.channelId ?? candidate.target?.channelId);
          return Date.now() - createdAt <= 10_000 && (!candidateChannelId || candidateChannelId === channel.id);
        });
        if (entry) return handleAuditLogEntry(entry, guild, { correlationSource: "webhook_lookup" });
      } catch (error) {
        if (delayMs === 900) logger.warn("[Security] webhook audit lookup failed", JSON.stringify({ guild: guild.id, error: safeError(error) }));
      }
    }
    return null;
  }

  async function handleBotMessage(message) {
    if (!globallyEnabled || !message?.guild || !message.author?.bot || !message.id) return null;
    const guild = message.guild;
    const actorId = String(message.author.id);
    try {
      const policy = await loadPolicy(guild.id);
      // Do not hash content, look up trusted actors, or touch detector state in OFF.
      if (effectiveMode(policy) === "off" || !policy.botSpamProtection) return null;
      if (actorId === client.user?.id || await isTrustedActor(guild.id, actorId)) return { suppressed: true };
      const content = String(message.content ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
      const results = [];
      if (content && policy.botDuplicateSpam) {
        const fingerprint = createHash("sha256").update(content).digest("hex");
        results.push(await processSecurityV1Detection({
          guild,
          policy,
          actorId,
          actorName: message.author.globalName ?? message.author.username ?? null,
          event: {
            guildId: guild.id,
            actorId,
            actionType: "BOT_DUPLICATE_SPAM",
            auditLogEntryId: `message:${message.id}`,
            channelId: message.channelId,
            messageId: message.id,
            fingerprint,
            occurredAt: message.createdTimestamp ?? Date.now(),
          },
        }));
      }
      if (policy.botEveryoneSpam && hasEveryoneOrHereMention(message)) {
        results.push(await processSecurityV1Detection({
          guild,
          policy,
          actorId,
          actorName: message.author.globalName ?? message.author.username ?? null,
          event: {
            guildId: guild.id,
            actorId,
            actionType: "BOT_EVERYONE_SPAM",
            auditLogEntryId: `message:${message.id}`,
            channelId: message.channelId,
            messageId: message.id,
            occurredAt: message.createdTimestamp ?? Date.now(),
          },
        }));
      }
      return results;
    } catch (error) {
      logger.error("[Security] bot spam detector error", JSON.stringify({ guild: guild.id, actor: actorId, error: safeError(error) }));
      return null;
    }
  }

  async function createSnapshotForGuild(guild, { source = "manual", createdBy = null } = {}) {
    const policy = await loadPolicy(guild.id);
    if (effectiveMode(policy) === "off" || !policy.snapshotEnabled) {
      throw Object.assign(new Error("Snapshot is disabled."), { code: "SNAPSHOT_DISABLED" });
    }
    const snapshot = createSecuritySnapshot({
      guildId: guild.id,
      guildName: guild.name,
      source,
      channels: [...guild.channels.cache.values()].map(serializeChannel).sort((a, b) => a.position - b.position),
      roles: [...guild.roles.cache.values()].map((role) => serializeRole(role, guild.id)).sort((a, b) => a.position - b.position),
    });
    await sql`
      INSERT INTO "security_snapshot" ("id", "guildId", "source", "schemaVersion", "checksum", "data", "createdBy", "createdAt")
      VALUES (${snapshot.snapshotId}, ${guild.id}, ${source}, ${snapshot.schemaVersion}, ${snapshot.checksum}, ${JSON.stringify(snapshot)}::jsonb, ${createdBy}, ${new Date(snapshot.createdAt)})
    `;
    await sql`
      DELETE FROM "security_snapshot"
      WHERE "guildId" = ${guild.id}
        AND (
          "createdAt" < now() - (${policy.snapshotRetentionDays}::int * interval '1 day')
          OR "id" IN (
            SELECT "id" FROM "security_snapshot" WHERE "guildId" = ${guild.id}
            ORDER BY "createdAt" DESC OFFSET ${policy.snapshotRetentionCount}
          )
        )
    `;
    await sql`
      INSERT INTO "security_audit_event" ("guildId", "eventType", "actorId", "source", "details")
      VALUES (${guild.id}, 'SnapshotCreated', ${createdBy}, 'bot', ${JSON.stringify({ snapshotId: snapshot.snapshotId, source })}::jsonb)
    `;
    return { snapshotId: snapshot.snapshotId, checksum: snapshot.checksum, createdAt: snapshot.createdAt };
  }

  async function ensureDailySnapshot(guild) {
    if (!globallyEnabled) return null;
    const policy = await loadPolicy(guild.id);
    if (effectiveMode(policy) === "off" || !policy.snapshotEnabled) return null;
    const rows = await sql`SELECT "createdAt" FROM "security_snapshot" WHERE "guildId" = ${guild.id} ORDER BY "createdAt" DESC LIMIT 1`;
    if (rows[0] && Date.now() - new Date(rows[0].createdAt).getTime() < 24 * 60 * 60_000) return null;
    return createSnapshotForGuild(guild, { source: "daily" });
  }

  async function containIncident(guild, request) {
    const policy = await loadPolicy(guild.id);
    const nukeMode = effectiveMode(policy);
    if (nukeMode === "off") throw Object.assign(new Error("Nuke Protection is disabled."), { code: "NUKE_PROTECTION_OFF" });
    if (nukeMode === "shadow") throw Object.assign(new Error("Shadow mode does not permit containment."), { code: "SHADOW_MODE" });
    if (policy.mode === "shadow" || policy.mode === "monitor") throw Object.assign(new Error("Response policy does not permit containment."), { code: "RESPONSE_MODE" });
    if (!policy.manualContainment) throw Object.assign(new Error("Manual containment is disabled."), { code: "CONTAINMENT_DISABLED" });
    const incidents = await sql`SELECT * FROM "security_incident" WHERE "id" = ${request.incidentId} AND "guildId" = ${guild.id} LIMIT 1`;
    const incident = incidents[0];
    if (!incident) throw Object.assign(new Error("Incident not found."), { code: "INCIDENT_NOT_FOUND" });
    if (incident.containmentStatus === "contained") return { status: "already_contained", removedRoleIds: [] };
    const trustedActor = await isTrustedActor(guild.id, incident.actorId);
    const botMember = guild.members.me ?? await guild.members.fetchMe();
    const member = incident.actorId ? await guild.members.fetch(incident.actorId).catch(() => null) : null;
    const plan = buildContainmentPlan({
      actorId: incident.actorId,
      guildOwnerId: guild.ownerId,
      selfBotId: client.user?.id,
      trustedActor,
      memberPresent: Boolean(member),
      botCanManageRoles: botMember.permissions.has(PermissionFlagsBits.ManageRoles),
      botHighestRolePosition: botMember.roles.highest.position,
      guildId: guild.id,
      roles: member ? [...member.roles.cache.values()].map((role) => ({
        id: role.id,
        position: role.position,
        managed: role.managed,
        permissionNames: role.permissions.toArray(),
      })) : [],
    });
    if (!plan.allowed) throw Object.assign(new Error(`Containment unavailable: ${plan.code}`), { code: plan.code });
    const reason = `NuviloView Nuke Protection incident ${incident.id}`.slice(0, 512);
    const execution = await executeContainmentRoleRemovals({ member, roleIds: plan.removableRoleIds, reason });
    const { removedRoleIds, failures } = execution;
    const containmentStatus = execution.status;
    await sql`
      UPDATE "security_incident"
      SET "containmentStatus" = ${containmentStatus},
          "status" = ${containmentStatus === "contained" ? "Contained" : "Monitoring"},
          "updatedAt" = now()
      WHERE "id" = ${incident.id}
    `;
    await sql`
      INSERT INTO "security_audit_event" ("guildId", "incidentId", "eventType", "actorId", "actorName", "source", "details")
      VALUES (${guild.id}, ${incident.id}, ${containmentStatus === "failed" ? "ContainmentFailed" : "ContainmentExecuted"},
        ${request.requestedBy}, ${request.requestedByName}, 'dashboard',
        ${JSON.stringify({ containmentStatus, removedRoleIds, failedRoleIds: failures.map((item) => item.roleId), auditReason: reason })}::jsonb)
    `;
    return { status: containmentStatus, removedRoleIds, failures };
  }

  async function createRestorePreviewForGuild(guild, request) {
    const policy = await loadPolicy(guild.id);
    if (effectiveMode(policy) === "off") {
      throw Object.assign(new Error("Nuke Protection is disabled."), { code: "NUKE_PROTECTION_OFF" });
    }
    const snapshotId = typeof request.payload?.snapshotId === "string" ? request.payload.snapshotId : null;
    const rows = snapshotId
      ? await sql`SELECT "data" FROM "security_snapshot" WHERE "id" = ${snapshotId} AND "guildId" = ${guild.id} LIMIT 1`
      : await sql`SELECT "data" FROM "security_snapshot" WHERE "guildId" = ${guild.id} ORDER BY "createdAt" DESC LIMIT 1`;
    if (!rows[0]) throw Object.assign(new Error("Snapshot not found."), { code: "SNAPSHOT_NOT_FOUND" });
    const current = {
      channels: [...guild.channels.cache.values()].map(serializeChannel),
      roles: [...guild.roles.cache.values()].map((role) => serializeRole(role, guild.id)),
    };
    const preview = buildRestorePreview(rows[0].data, current);
    await sql`
      INSERT INTO "security_audit_event" ("guildId", "eventType", "actorId", "actorName", "source", "details")
      VALUES (${guild.id}, 'RestorePreviewCreated', ${request.requestedBy}, ${request.requestedByName}, 'dashboard',
        ${JSON.stringify({ snapshotId: preview.snapshotId, deletedChannelCount: preview.deletedChannelCount, deletedRoleCount: preview.deletedRoleCount, permissionChangeCount: preview.permissionChangeCount })}::jsonb)
    `;
    return preview;
  }

  async function claimActionRequest() {
    await sql`
      UPDATE "security_action_request"
      SET "status" = 'queued', "claimedAt" = NULL
      WHERE "status" = 'running' AND "completedAt" IS NULL
        AND "claimedAt" < now() - interval '15 minutes'
    `;
    const rows = await sql`
      WITH candidate AS (
        SELECT "id" FROM "security_action_request"
        WHERE "status" = 'queued'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "security_action_request" AS request
      SET "status" = 'running', "claimedAt" = now()
      FROM candidate
      WHERE request."id" = candidate."id"
      RETURNING request.*
    `;
    return rows[0] ?? null;
  }

  async function pollActionRequests() {
    if (!globallyEnabled || requestPolling) return;
    requestPolling = true;
    let claimedRequest = null;
    try {
      claimedRequest = await claimActionRequest();
      if (!claimedRequest) return;
      const guild = client.guilds.cache.get(claimedRequest.guildId);
      if (!guild) throw Object.assign(new Error("Guild is not connected."), { code: "GUILD_NOT_CONNECTED" });
      const policy = await loadPolicy(guild.id);
      if (effectiveMode(policy) === "off") {
        throw Object.assign(new Error("Nuke Protection is disabled."), { code: "NUKE_PROTECTION_OFF" });
      }
      let result;
      if (claimedRequest.action === "contain") result = await containIncident(guild, claimedRequest);
      else if (claimedRequest.action === "snapshot") result = await createSnapshotForGuild(guild, { source: "manual", createdBy: claimedRequest.requestedBy });
      else if (claimedRequest.action === "restore_preview") result = await createRestorePreviewForGuild(guild, claimedRequest);
      else throw Object.assign(new Error("Unsupported security request."), { code: "UNSUPPORTED_ACTION" });
      await sql`
        UPDATE "security_action_request"
        SET "status" = 'completed', "result" = ${JSON.stringify(result)}::jsonb, "completedAt" = now()
        WHERE "id" = ${claimedRequest.id}
      `;
    } catch (error) {
      if (claimedRequest?.id) {
        await sql`
          UPDATE "security_action_request"
          SET "status" = 'failed', "errorCode" = ${String(error.code ?? "SECURITY_ACTION_FAILED")},
              "errorMessage" = ${safeError(error)}, "completedAt" = now()
          WHERE "id" = ${claimedRequest.id} AND "status" = 'running'
        `;
      }
      logger.error("[Security] action request failed", JSON.stringify({
        request: claimedRequest?.id ?? null,
        error: safeError(error),
        code: error.code ?? null,
      }));
    } finally {
      requestPolling = false;
    }
  }

  async function purgeExpiredSecurityData() {
    if (!globallyEnabled) return;
    await sql`
      DELETE FROM "security_incident" AS incident
      USING "security_policy" AS policy
      WHERE incident."guildId" = policy."guildId"
        AND incident."status" IN ('Resolved', 'FalsePositive')
        AND incident."updatedAt" < now() - (policy."incidentRetentionDays"::int * interval '1 day')
    `;
    await sql`
      DELETE FROM "security_action_request"
      WHERE "status" IN ('completed', 'failed') AND "completedAt" < now() - interval '30 days'
    `;
  }

  function clearGuild(guildId) {
    tracker.clearGuild(guildId);
    policyCache.delete(String(guildId));
    for (const key of trustedCache.keys()) {
      if (key.startsWith(`${guildId}:`)) trustedCache.delete(key);
    }
    for (const key of incidentLocks.keys()) {
      if (key.startsWith(`${guildId}:`)) incidentLocks.delete(key);
    }
  }

  return {
    globallyEnabled,
    diagnoseGuild,
    handleAuditLogEntry,
    handleWebhookUpdate,
    handleBotMessage,
    createSnapshotForGuild,
    ensureDailySnapshot,
    pollActionRequests,
    purgeExpiredSecurityData,
    clearGuild,
  };
}
