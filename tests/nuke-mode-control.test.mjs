import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuditLogEvent } from "discord.js";
import {
  calculateNukeRisk,
  normalizeNukeProtectionPolicy,
  normalizeNukeProtectionMode,
  resolveNukeProtectionMode,
} from "../lib/nuke-protection.mjs";
import { createNukeProtectionService } from "../lib/nuke-protection-service.mjs";

const guildId = "100000000000000001";
const actorId = "200000000000000002";
const botId = "900000000000000009";
const silentLogger = { info() {}, warn() {}, error() {} };

function auditEntry(id, action) {
  return {
    id,
    action,
    executorId: actorId,
    executor: { id: actorId, bot: false, username: "actor" },
    targetId: "300000000000000003",
    createdAt: new Date("2026-08-22T00:00:00.000Z"),
    changes: [],
  };
}

function guild() {
  return {
    id: guildId,
    ownerId: "400000000000000004",
    roles: { cache: new Map() },
    members: { cache: new Map() },
  };
}

test("mode normalization is safe and the global kill switch has highest priority", () => {
  assert.equal(normalizeNukeProtectionMode("ACTIVE"), "active");
  assert.equal(normalizeNukeProtectionMode("invalid"), "shadow");
  assert.equal(resolveNukeProtectionMode({ globallyEnabled: false, guildEnabled: true, mode: "active" }), "off");
  assert.equal(resolveNukeProtectionMode({ globallyEnabled: true, guildEnabled: false, mode: "active" }), "off");
  assert.equal(resolveNukeProtectionMode({ globallyEnabled: true, guildEnabled: true, mode: "shadow" }), "shadow");
  assert.equal(resolveNukeProtectionMode({ globallyEnabled: true, guildEnabled: true, mode: "active" }), "active");
  const saved = normalizeNukeProtectionPolicy({ nukeProtectionMode: "off", mode: "protect", automaticContainment: true, autoRestore: true });
  assert.equal(saved.automaticContainment, true);
  assert.equal(saved.autoRestore, true);
});

test("low and medium confidence cannot be promoted to Critical", () => {
  const actions = Array.from({ length: 5 }, (_, index) => ({
    guildId,
    actorId,
    actionType: "CHANNEL_DELETE",
    destructive: true,
    occurredAt: new Date(Date.parse("2026-08-22T00:00:00.000Z") - index * 1_000).toISOString(),
  }));
  const now = Date.parse("2026-08-22T00:00:00.000Z");
  assert.equal(calculateNukeRisk(actions, { now, correlationConfidence: "high" }).severity, "Critical");
  assert.equal(calculateNukeRisk(actions, { now, correlationConfidence: "medium" }).severity, "High");
  assert.equal(calculateNukeRisk(actions, { now, correlationConfidence: "low" }).severity, "Normal");
});

test("Guild OFF exits before classification, actor lookup, risk, incidents, alerts, or snapshots", async () => {
  const queries = [];
  const sql = async (strings) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes('SELECT * FROM "security_policy"')) {
      return [{ enabled: true, nukeProtectionMode: "off", mode: "protect", automaticContainment: true, autoRestore: true }];
    }
    throw new Error(`OFF executed an unexpected query: ${query}`);
  };
  const service = createNukeProtectionService({
    client: { user: { id: botId } }, sql,
    environment: { NUVILOVIEW_NUKE_PROTECTION: "true" }, logger: silentLogger,
  });
  for (const [id, action] of [
    ["500000000000000001", AuditLogEvent.ChannelDelete],
    ["500000000000000002", AuditLogEvent.RoleDelete],
    ["500000000000000003", AuditLogEvent.MemberBanAdd],
  ]) {
    assert.equal(await service.handleAuditLogEntry(auditEntry(id, action), guild()), null);
  }
  assert.equal(queries.length, 1);
  await assert.rejects(
    service.createSnapshotForGuild({ ...guild(), name: "Guild", channels: { cache: new Map() } }),
    (error) => error.code === "SNAPSHOT_DISABLED",
  );
  assert.equal(queries.some((query) => /security_incident|security_snapshot|security_trusted_actor/.test(query)), false);
});

test("global OFF plus Guild Active performs no DB or detector work", async () => {
  let queryCount = 0;
  const service = createNukeProtectionService({
    client: { user: { id: botId } },
    sql: async () => { queryCount += 1; return []; },
    environment: { NUVILOVIEW_NUKE_PROTECTION: "false" },
    logger: silentLogger,
  });
  assert.equal(await service.handleAuditLogEntry(auditEntry("600000000000000001", AuditLogEvent.ChannelDelete), guild()), null);
  assert.equal(queryCount, 0);
});

test("Active to Off and Off to Shadow changes are observed without a Bot restart", async () => {
  let mode = "active";
  let duplicateQueries = 0;
  const sql = async (strings) => {
    const query = strings.join("?");
    if (query.includes('SELECT * FROM "security_policy"')) return [{ enabled: true, nukeProtectionMode: mode, mode: "shadow" }];
    if (query.includes('SELECT "incidentId" FROM "security_incident_action"')) {
      duplicateQueries += 1;
      return [{ incidentId: "existing" }];
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  const service = createNukeProtectionService({
    client: { user: { id: botId } }, sql,
    environment: { NUVILOVIEW_NUKE_PROTECTION: "true", NUVILOVIEW_NUKE_POLICY_CACHE_MS: "0" },
    logger: silentLogger,
  });
  assert.deepEqual(await service.handleAuditLogEntry(auditEntry("700000000000000001", AuditLogEvent.ChannelDelete), guild()), { duplicate: true, incidentId: "existing" });
  mode = "off";
  assert.equal(await service.handleAuditLogEntry(auditEntry("700000000000000002", AuditLogEvent.RoleDelete), guild()), null);
  mode = "shadow";
  assert.deepEqual(await service.handleAuditLogEntry(auditEntry("700000000000000003", AuditLogEvent.ChannelDelete), guild()), { duplicate: true, incidentId: "existing" });
  assert.equal(duplicateQueries, 2);
});

test("runtime queries keep legacy actions out of typed incidents and score one incident only", async () => {
  const source = await readFile(new URL("../lib/nuke-protection-service.mjs", import.meta.url), "utf8");
  assert.match(source, /AND "incidentType" IS NULL/);
  assert.match(source, /WHERE "incidentId" = \$\{incidentId\}/);
  const fastPath = source.indexOf('if (effectiveMode(policy) === "off") return null;', source.indexOf("async function handleAuditLogEntry"));
  const classify = source.indexOf("classifyAuditEntry(entry, guild)", fastPath - 500);
  assert.ok(fastPath >= 0 && classify > fastPath);
});

test("Guild owner and known managed integration actors are suppressed before incident creation", async () => {
  const inserted = [];
  const sql = async (strings) => {
    const query = strings.join("?");
    if (query.includes('SELECT * FROM "security_policy"')) return [{ enabled: true, nukeProtectionMode: "active", mode: "protect" }];
    if (query.includes('SELECT "incidentId" FROM "security_incident_action"')) return [];
    if (query.includes('SELECT 1 FROM "security_trusted_actor"')) return [];
    if (query.includes("INSERT")) inserted.push(query);
    return [];
  };
  const service = createNukeProtectionService({
    client: { user: { id: botId } }, sql,
    environment: { NUVILOVIEW_NUKE_PROTECTION: "true" }, logger: silentLogger,
  });
  const ownerEntry = { ...auditEntry("800000000000000001", AuditLogEvent.ChannelDelete), executorId: actorId };
  assert.deepEqual(await service.handleAuditLogEntry(ownerEntry, { ...guild(), ownerId: actorId }), { suppressed: true });

  const integrationGuild = guild();
  integrationGuild.members.cache.set(actorId, {
    roles: { cache: new Map([["role", { managed: true, tags: { integrationId: "integration" } }]]) },
  });
  assert.deepEqual(await service.handleAuditLogEntry(auditEntry("800000000000000002", AuditLogEvent.ChannelDelete), integrationGuild), { suppressed: true });
  assert.equal(inserted.length, 0);
});

test("migration, API, UI and Developer Console expose additive audited mode control", async () => {
  const [migration, policyRoute, securityPage, developerRoute, developerPage] = await Promise.all([
    readFile(new URL("../scripts/migrations/20260822-nuke-protection-mode.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/security/policy/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard/security/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/developer/guilds/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/developer/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "nukeProtectionMode" text NOT NULL DEFAULT 'shadow'/);
  assert.match(migration, /CHECK \("nukeProtectionMode" IN \('off', 'shadow', 'active'\)\)/);
  assert.match(policyRoute, /NUKE_PROTECTION_MODE_CHANGED/);
  assert.match(policyRoute, /requiredScope: SECURITY_SCOPES\.policy/);
  assert.match(securityPage, /Disable Nuke Protection v2\?/);
  assert.match(securityPage, /Disabled because Nuke Protection is Off/);
  assert.match(developerRoute, /nukeProtectionGlobalEnabled/);
  assert.match(developerPage, /GLOBAL DISABLED/);
});
