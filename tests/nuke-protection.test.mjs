import assert from "node:assert/strict";
import test from "node:test";
import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import {
  buildContainmentPlan,
  buildRestorePreview,
  calculateNukeRisk,
  createSecuritySnapshot,
  normalizeNukeProtectionPolicy,
  sanitizeSecurityMetadata,
  selectRetainedSnapshots,
  shouldCorrelateIncident,
} from "../lib/nuke-protection.mjs";
import { classifyAuditEntry, createNukeProtectionService, executeContainmentRoleRemovals } from "../lib/nuke-protection-service.mjs";

const now = Date.parse("2026-08-14T00:05:00.000Z");
const action = (actionType, millisecondsAgo, extra = {}) => ({
  guildId: "100000000000000001",
  actorId: "200000000000000002",
  actionType,
  destructive: ["CHANNEL_DELETE", "ROLE_DELETE", "MEMBER_BAN", "MEMBER_KICK"].includes(actionType),
  occurredAt: new Date(now - millisecondsAgo).toISOString(),
  ...extra,
});

test("single channel delete remains Normal but is explainable", () => {
  const result = calculateNukeRisk([action("CHANNEL_DELETE", 1_000)], { now });
  assert.equal(result.riskScore, 25);
  assert.equal(result.severity, "Normal");
  assert.equal(result.baseItems[0].points, 25);
});

test("channel delete burst and role delete burst receive deterministic bonuses", () => {
  const channelBurst = calculateNukeRisk([
    action("CHANNEL_DELETE", 1_000),
    action("CHANNEL_DELETE", 2_000),
    action("CHANNEL_DELETE", 3_000),
  ], { now });
  assert.equal(channelBurst.riskScore, 95);
  assert.equal(channelBurst.severity, "Critical");
  assert.deepEqual(channelBurst.bonuses.map((item) => item.id), ["destructive-3-in-10s"]);

  const roleBurst = calculateNukeRisk([
    action("ROLE_DELETE", 1_000), action("ROLE_DELETE", 2_000), action("ROLE_DELETE", 3_000),
  ], { now });
  assert.equal(roleBurst.riskScore, 95);
});

test("mixed destructive actions and mass bans raise risk without magic thresholds", () => {
  const mixed = calculateNukeRisk([
    action("CHANNEL_DELETE", 9_000),
    action("ROLE_DELETE", 8_000),
    action("MEMBER_BAN", 7_000),
  ], { now });
  assert.equal(mixed.riskScore, 93);
  assert.equal(mixed.severity, "Critical");
  assert.deepEqual(new Set(mixed.distinctActionTypes), new Set(["CHANNEL_DELETE", "ROLE_DELETE", "MEMBER_BAN"]));

  const bans = calculateNukeRisk(Array.from({ length: 5 }, (_, index) => action("MEMBER_BAN", index * 2_000)), { now });
  assert.equal(bans.riskScore, 100);
});

test("administrator grant is High when combined with another dangerous permission", () => {
  const result = calculateNukeRisk([
    action("ADMINISTRATOR_GRANT", 1_000),
    action("DANGEROUS_PERMISSION", 2_000),
  ], { now });
  assert.equal(result.riskScore, 65);
  assert.equal(result.severity, "High");
});

test("trusted actor, guild owner and self action remain visible but risk-suppressed", () => {
  for (const flag of ["trustedActor", "guildOwner", "selfActor"]) {
    const result = calculateNukeRisk([
      action("CHANNEL_DELETE", 1_000), action("CHANNEL_DELETE", 2_000), action("CHANNEL_DELETE", 3_000),
    ], { now, [flag]: true });
    assert.equal(result.actionCount, 3);
    assert.equal(result.rawRisk, 95);
    assert.equal(result.riskScore, 0);
    assert.equal(result.suppressed, true);
  }
});

test("unknown actor can be scored without fabricating an executor", () => {
  const result = calculateNukeRisk([
    action("ROLE_DELETE", 1_000, { actorId: null }),
    action("ROLE_DELETE", 2_000, { actorId: null }),
    action("ROLE_DELETE", 3_000, { actorId: null }),
  ], { now });
  assert.equal(result.riskScore, 95);
});

test("incident correlation accepts close same-actor events including modest out-of-order delivery", () => {
  const incident = {
    guildId: "100000000000000001",
    actorId: "200000000000000002",
    status: "Open",
    lastDetectedAt: new Date(now - 10_000).toISOString(),
  };
  assert.equal(shouldCorrelateIncident(incident, action("ROLE_DELETE", 5_000)), true);
  assert.equal(shouldCorrelateIncident(incident, action("ROLE_DELETE", 20_000)), true);
  assert.equal(shouldCorrelateIncident({ ...incident, actorId: "other" }, action("ROLE_DELETE", 5_000)), false);
});

test("risk window expires after five minutes", () => {
  const result = calculateNukeRisk([
    action("CHANNEL_DELETE", 301_000),
    action("CHANNEL_DELETE", 1_000),
  ], { now });
  assert.equal(result.actionCount, 1);
  assert.equal(result.riskScore, 25);
});

test("invalid thresholds and negative weights fall back to safe defaults", () => {
  const policy = normalizeNukeProtectionPolicy({
    thresholds: { suspicious: 90, high: 20, critical: 10 },
    riskWeights: { CHANNEL_DELETE: -5 },
    automaticContainment: true,
  });
  assert.deepEqual(policy.thresholds, { suspicious: 30, high: 60, critical: 90 });
  assert.equal(policy.riskWeights.CHANNEL_DELETE, 25);
  assert.equal(policy.automaticContainment, false);
});

test("low, balanced and high sensitivity use documented severity presets", () => {
  const actions = [action("CHANNEL_DELETE", 1_000)];
  assert.equal(calculateNukeRisk(actions, { now, policy: { sensitivity: "low" } }).severity, "Normal");
  assert.equal(calculateNukeRisk(actions, { now, policy: { sensitivity: "balanced" } }).severity, "Normal");
  assert.equal(calculateNukeRisk(actions, { now, policy: { sensitivity: "high" } }).severity, "Suspicious");
});

test("containment protects owner, trusted actor, self, hierarchy and missing permissions", () => {
  const base = {
    actorId: "actor", guildOwnerId: "owner", selfBotId: "bot", trustedActor: false,
    memberPresent: true, botCanManageRoles: true, botHighestRolePosition: 10, guildId: "guild",
    roles: [{ id: "danger", position: 5, managed: false, permissionNames: ["Administrator"] }],
  };
  assert.equal(buildContainmentPlan({ ...base, actorId: "owner" }).code, "GUILD_OWNER");
  assert.equal(buildContainmentPlan({ ...base, trustedActor: true }).code, "TRUSTED_ACTOR");
  assert.equal(buildContainmentPlan({ ...base, actorId: "bot" }).code, "SELF_ACTOR");
  assert.equal(buildContainmentPlan({ ...base, botCanManageRoles: false }).code, "MISSING_MANAGE_ROLES");
  assert.equal(buildContainmentPlan({ ...base, roles: [{ ...base.roles[0], position: 12 }] }).code, "NO_REMOVABLE_DANGEROUS_ROLES");
  assert.deepEqual(buildContainmentPlan(base).removableRoleIds, ["danger"]);
});

test("snapshot captures structure without secret fields and restore preview classifies changes", () => {
  const snapshot = createSecuritySnapshot({
    snapshotId: "snapshot-1",
    guildId: "guild",
    guildName: "Guild",
    createdAt: "2026-08-14T00:00:00.000Z",
    channels: [{ id: "c1", name: "general", permissionOverwrites: [{ id: "r1", allow: "1", deny: "0" }] }],
    roles: [{ id: "r1", name: "Moderator", permissions: "8", managed: false }],
    webhookToken: "must-not-exist",
  });
  assert.equal("webhookToken" in snapshot, false);
  assert.match(snapshot.checksum, /^[a-f0-9]{64}$/);

  const preview = buildRestorePreview(snapshot, {
    channels: [{ id: "c1", name: "general", permissionOverwrites: [] }],
    roles: [],
  });
  assert.equal(preview.deletedChannelCount, 0);
  assert.equal(preview.deletedRoleCount, 1);
  assert.equal(preview.permissionChangeCount, 1);
  assert.equal(preview.automaticRestoreAvailable, false);
});

test("snapshot retention keeps only recent bounded generations", () => {
  const snapshots = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    createdAt: new Date(now - index * 86_400_000).toISOString(),
  }));
  const retained = selectRetainedSnapshots(snapshots, { maximum: 7, retentionDays: 30, now });
  assert.equal(retained.length, 7);
  assert.equal(retained[0].id, "0");
});

test("restore preview marks deleted managed roles as unrestorable", () => {
  const preview = buildRestorePreview({
    snapshotId: "snapshot-managed",
    channels: [],
    roles: [{ id: "managed", name: "Integration", managed: true, isEveryone: false }],
  }, { channels: [], roles: [] });
  assert.equal(preview.deletedRoleCount, 0);
  assert.equal(preview.cannotRestore.length, 1);
  assert.equal(preview.cannotRestore[0].reason, "MANAGED_ROLE");
});

test("evidence metadata excludes message content and secret-like fields", () => {
  const result = sanitizeSecurityMetadata({
    targetName: "general",
    targetType: "channel",
    messageContent: "private",
    token: "secret",
    permissionNames: ["Administrator"],
  });
  assert.deepEqual(result, {
    targetName: "general",
    targetType: "channel",
    permissionNames: ["Administrator"],
  });
});

test("discord.js audit changes classify role and overwrite escalation from old/new fields", () => {
  const administrator = classifyAuditEntry({
    action: AuditLogEvent.RoleCreate,
    changes: [{ key: "permissions", old: "0", new: PermissionFlagsBits.Administrator.toString() }],
    target: { id: "123456789012345678", name: "Dangerous role" },
  }, { roles: { cache: new Map() } });
  assert.equal(administrator?.actionType, "ADMINISTRATOR_GRANT");

  const overwrite = classifyAuditEntry({
    action: AuditLogEvent.ChannelOverwriteUpdate,
    changes: [{ key: "allow", old: "0", new: PermissionFlagsBits.ManageRoles.toString() }],
    target: { id: "223456789012345678", name: "channel overwrite" },
  }, { roles: { cache: new Map() } });
  assert.equal(overwrite?.actionType, "DANGEROUS_PERMISSION");
});

test("member role update reads the Discord audit $add field", () => {
  const roleId = "323456789012345678";
  const classified = classifyAuditEntry({
    action: AuditLogEvent.MemberRoleUpdate,
    changes: [{ key: "$add", new: [{ id: roleId, name: "Administrator" }] }],
    target: { id: "423456789012345678", username: "member" },
  }, {
    roles: { cache: new Map([[roleId, { permissions: { toArray: () => ["Administrator"] } }]]) },
  });
  assert.equal(classified?.actionType, "ADMINISTRATOR_GRANT");
});

test("containment removes roles sequentially, preserves audit reason and reports partial failure", async () => {
  const calls = [];
  const member = {
    roles: {
      remove: async (roleId, reason) => {
        calls.push({ roleId, reason });
        if (roleId === "role-fail") throw new Error("Missing hierarchy");
      },
    },
  };
  const result = await executeContainmentRoleRemovals({
    member,
    roleIds: ["role-ok", "role-fail"],
    reason: "NuviloView Nuke Protection incident incident-1",
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.removedRoleIds, ["role-ok"]);
  assert.deepEqual(calls.map((call) => call.roleId), ["role-ok", "role-fail"]);
  assert.match(calls[0].reason, /incident incident-1/);
});

test("duplicate audit entry exits before creating another incident action", async () => {
  const queries = [];
  const sql = async (strings) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes('SELECT * FROM "security_policy"')) return [{ enabled: true, mode: "shadow" }];
    if (query.includes('SELECT "incidentId" FROM "security_incident_action"')) return [{ incidentId: "existing-incident" }];
    throw new Error(`Unexpected query: ${query}`);
  };
  const service = createNukeProtectionService({
    client: { user: { id: "999999999999999999" } },
    sql,
    environment: { NUVILOVIEW_NUKE_PROTECTION: "true" },
    logger: { info() {}, warn() {}, error() {} },
  });
  const result = await service.handleAuditLogEntry({
    id: "823456789012345678",
    action: AuditLogEvent.ChannelDelete,
    executorId: "923456789012345678",
    targetId: "723456789012345678",
    createdAt: new Date(now),
    changes: [],
  }, { id: "100000000000000001", ownerId: "600000000000000001", roles: { cache: new Map() } });
  assert.deepEqual(result, { duplicate: true, incidentId: "existing-incident" });
  assert.equal(queries.some((query) => query.includes('INSERT INTO "security_incident_action"')), false);
});
