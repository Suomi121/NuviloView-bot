import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuditLogEvent, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import {
  SecurityV1WindowTracker,
  executeBestEffort,
  getSecurityV1Detector,
  hasEveryoneOrHereMention,
  shouldMonitorSecurityV1Actor,
  summarizeBestEffort,
} from "../lib/security-v1.mjs";
import {
  classifyAuditEntry,
  createNukeProtectionService,
  executeSecurityKick,
} from "../lib/nuke-protection-service.mjs";

const guildId = "100000000000000001";
const botId = "200000000000000002";
const selfBotId = "900000000000000009";

function event(actionType, occurredAt, overrides = {}) {
  return {
    guildId,
    actorId: botId,
    actionType,
    auditLogEntryId: `${actionType}:${occurredAt}:${overrides.targetId ?? "target"}`,
    targetId: overrides.targetId ?? "300000000000000003",
    occurredAt,
    ...overrides,
  };
}

test("one normal channel operation and every pre-threshold operation remain below detection", () => {
  const tracker = new SecurityV1WindowTracker();
  for (let index = 0; index < 4; index += 1) {
    const result = tracker.record(event("CHANNEL_CREATE", index * 1_000, { targetId: String(index) }), {}, index * 1_000);
    assert.equal(result.detected, false);
    assert.equal(result.count, index + 1);
  }
});

test("the configured channel threshold creates exactly one detection", () => {
  const tracker = new SecurityV1WindowTracker();
  let result;
  for (let index = 0; index < 5; index += 1) {
    result = tracker.record(event("CHANNEL_DELETE", index * 1_000, { targetId: String(index) }), {}, index * 1_000);
  }
  assert.equal(result.detected, true);
  assert.equal(result.count, 5);
  const repeated = tracker.record(event("CHANNEL_DELETE", 5_000, { targetId: "5" }), {}, 5_000);
  assert.equal(repeated.detected, false);
  assert.equal(repeated.duplicateSuppressed, true);
});

test("NuviloView itself and trusted or human actors are excluded", () => {
  assert.equal(shouldMonitorSecurityV1Actor({ actorId: selfBotId, selfBotId, trustedActor: false, actorIsBot: true }), false);
  assert.equal(shouldMonitorSecurityV1Actor({ actorId: botId, selfBotId, trustedActor: true, actorIsBot: true }), false);
  assert.equal(shouldMonitorSecurityV1Actor({ actorId: botId, selfBotId, trustedActor: false, actorIsBot: false }), false);
  assert.equal(shouldMonitorSecurityV1Actor({ actorId: botId, selfBotId, trustedActor: false, actorIsBot: true }), true);
});

test("tracker state is isolated by Guild and actor", () => {
  const tracker = new SecurityV1WindowTracker();
  for (let index = 0; index < 4; index += 1) {
    tracker.record(event("CHANNEL_CREATE", index * 1_000, { targetId: `a-${index}` }), {}, index * 1_000);
  }
  const otherGuild = tracker.record(event("CHANNEL_CREATE", 4_000, { guildId: "400000000000000004", targetId: "other-guild" }), {}, 4_000);
  const otherActor = tracker.record(event("CHANNEL_CREATE", 4_000, { actorId: "500000000000000005", targetId: "other-actor" }), {}, 4_000);
  assert.equal(otherGuild.count, 1);
  assert.equal(otherActor.count, 1);
  assert.equal(otherGuild.detected, false);
  assert.equal(otherActor.detected, false);
});

test("events outside the rolling window are not counted", () => {
  const tracker = new SecurityV1WindowTracker();
  tracker.record(event("ROLE_DELETE", 0, { targetId: "old" }), {}, 0);
  const result = tracker.record(event("ROLE_DELETE", 61_000, { targetId: "new" }), {}, 61_000);
  assert.equal(result.count, 1);
  assert.equal(result.detected, false);
});

test("Role Anti-Nuke uses the two-operation default threshold", () => {
  const tracker = new SecurityV1WindowTracker();
  const first = tracker.record(event("ROLE_CREATE", 0, { targetId: "role-1" }), {}, 0);
  const second = tracker.record(event("ROLE_DELETE", 1_000, { targetId: "role-2" }), {}, 1_000);
  assert.equal(first.detected, false);
  assert.equal(second.detected, true);
  assert.equal(second.count, 2);
});

test("webhook incident cooldown covers its full one-hour detector window", () => {
  const tracker = new SecurityV1WindowTracker();
  tracker.record(event("WEBHOOK_CREATE", 0, { targetId: "webhook-1" }), {}, 0);
  const detected = tracker.record(event("WEBHOOK_CREATE", 1_000, { targetId: "webhook-2" }), {}, 1_000);
  const suppressed = tracker.record(event("WEBHOOK_CREATE", 10 * 60_000, { targetId: "webhook-3" }), {}, 10 * 60_000);
  assert.equal(detected.detected, true);
  assert.equal(suppressed.detected, false);
  assert.equal(suppressed.duplicateSuppressed, true);
});

test("duplicate Bot spam is fingerprint-scoped and detected at five messages", () => {
  const tracker = new SecurityV1WindowTracker();
  for (let index = 0; index < 4; index += 1) {
    const result = tracker.record(event("BOT_DUPLICATE_SPAM", index * 1_000, { messageId: String(index), fingerprint: "same" }), {}, index * 1_000);
    assert.equal(result.detected, false);
  }
  const different = tracker.record(event("BOT_DUPLICATE_SPAM", 4_000, { messageId: "different", fingerprint: "other" }), {}, 4_000);
  const detected = tracker.record(event("BOT_DUPLICATE_SPAM", 5_000, { messageId: "fifth", fingerprint: "same" }), {}, 5_000);
  assert.equal(different.count, 1);
  assert.equal(detected.detected, true);
});

test("everyone/here Bot spam detects mentions including punctuation", () => {
  assert.equal(hasEveryoneOrHereMention({ mentions: { everyone: true }, content: "text" }), true);
  assert.equal(hasEveryoneOrHereMention({ mentions: { everyone: false }, content: "@everyone shown as plain text" }), false);
  assert.equal(hasEveryoneOrHereMention({ content: "@everyone! check this" }), true);
  assert.equal(hasEveryoneOrHereMention({ content: "email@example.com" }), false);
  const tracker = new SecurityV1WindowTracker();
  tracker.record(event("BOT_EVERYONE_SPAM", 0, { messageId: "1" }), {}, 0);
  tracker.record(event("BOT_EVERYONE_SPAM", 1_000, { messageId: "2" }), {}, 1_000);
  const result = tracker.record(event("BOT_EVERYONE_SPAM", 2_000, { messageId: "3" }), {}, 2_000);
  assert.equal(result.detected, true);
});

test("webhook create is a Security v1 detector while webhook delete is not mistaken for creation", () => {
  const guild = { roles: { cache: new Map() } };
  const created = classifyAuditEntry({ action: AuditLogEvent.WebhookCreate, changes: [] }, guild);
  const deleted = classifyAuditEntry({ action: AuditLogEvent.WebhookDelete, changes: [] }, guild);
  assert.equal(created?.actionType, "WEBHOOK_CREATE");
  assert.equal(deleted?.actionType, "WEBHOOK_DELETE");
  assert.equal(getSecurityV1Detector(created.actionType)?.incidentType, "WEBHOOK_NUKE");
  assert.equal(getSecurityV1Detector(deleted.actionType), null);
});

test("kick failure is bounded and cannot crash incident response", async () => {
  const result = await executeSecurityKick({ member: { kick: async () => { throw new Error("Missing hierarchy"); } }, reason: "test" });
  assert.equal(result.kicked, false);
  assert.match(result.error, /Missing hierarchy/);
});

test("incident persistence occurs before automatic response is attempted", async () => {
  const source = await readFile(new URL("../lib/nuke-protection-service.mjs", import.meta.url), "utf8");
  const persistIndex = source.indexOf("const persisted = await persistSecurityV1Incident({ guild, actorId, actorName, tracking })");
  const responseIndex = source.indexOf("respondToSecurityV1Incident(guild, policy, persisted.incident, tracking)", persistIndex);
  assert.ok(persistIndex >= 0);
  assert.ok(responseIndex > persistIndex);
});

test("best-effort restore continues after an individual object failure", async () => {
  const visited = [];
  const results = await executeBestEffort(["role", "category", "channel"], async (item) => {
    visited.push(item);
    if (item === "category") throw new Error("missing permission");
    return item;
  });
  assert.deepEqual(visited, ["role", "category", "channel"]);
  assert.deepEqual(summarizeBestEffort(results), { restored: 2, failed: 1, status: "partially_restored" });
});

test("missing audit permission degrades diagnostics without throwing", async () => {
  const sql = async (strings) => {
    const query = strings.join("?");
    if (query.includes('SELECT * FROM "security_policy"')) return [{ enabled: true, mode: "shadow" }];
    return [];
  };
  const service = createNukeProtectionService({
    client: {
      options: { intents: { has: (intent) => intent === GatewayIntentBits.GuildModeration } },
      user: { id: selfBotId },
    },
    sql,
    environment: { NUVILOVIEW_NUKE_PROTECTION: "true" },
    logger: { info() {}, warn() {}, error() {} },
  });
  const permissions = { has: () => false };
  const result = await service.diagnoseGuild({
    id: guildId,
    members: { me: { permissions }, fetchMe: async () => ({ permissions }) },
    channels: { cache: new Map() },
  });
  assert.equal(result.status, "Limited");
  assert.deepEqual(result.missingPermissions, ["ViewAuditLog"]);
});

test("Shadow Mode does not report response-only permissions as missing", async () => {
  const sql = async (strings) => {
    const query = strings.join("?");
    if (query.includes('SELECT * FROM "security_policy"')) return [{ enabled: true, mode: "shadow" }];
    return [];
  };
  const service = createNukeProtectionService({
    client: {
      options: { intents: { has: () => true } },
      user: { id: selfBotId },
    },
    sql,
    environment: { NUVILOVIEW_NUKE_PROTECTION: "true" },
    logger: { info() {}, warn() {}, error() {} },
  });
  const permissions = { has: (permission) => permission === PermissionFlagsBits.ViewAuditLog };
  const result = await service.diagnoseGuild({
    id: guildId,
    members: { me: { permissions }, fetchMe: async () => ({ permissions }) },
    channels: { cache: new Map() },
  });
  assert.equal(result.status, "Active");
  assert.deepEqual(result.missingPermissions, []);
});
