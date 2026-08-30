import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventDomainRouter } from "../lib/event-local-first.mjs";
import { createMessageDomainRouter } from "../lib/message-local-first.mjs";
import { createSecurityAuditService } from "../lib/security-local-first.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";
import {
  createAnalyticsCompactionService,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";
import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { MultiProviderSyncWorker } from "../lib/sync/multi-worker.mjs";
import { getProviderPolicyDefinitions } from "../lib/sync/providers/contract.mjs";

const guildA = "100000000000000001";
const guildB = "100000000000000002";
const channelA = "200000000000000001";
const channelB = "200000000000000002";
const userId = "300000000000000001";

const env = Object.freeze({
  LOCAL_STORAGE_ENABLED: "true",
  LOCAL_STORAGE_WRITE_ENABLED: "true",
  LOCAL_MESSAGE_STORAGE_ENABLED: "true",
  LOCAL_MESSAGE_CANARY_GUILDS: guildA,
  LOCAL_FIRST_ALL_GUILDS_ENABLED: "true",
  ANALYTICS_COMPACTION_ENABLED: "true",
  ANALYTICS_COMPACTION_GUILD_IDS: guildA,
  ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "60",
  EVENT_LOCAL_FIRST_ENABLED: "true",
  EVENT_LOCAL_FIRST_GUILD_IDS: guildA,
  EVENT_LOCAL_FIRST_REACTION_ENABLED: "true",
  EVENT_LOCAL_FIRST_VOICE_ENABLED: "true",
  EVENT_LOCAL_FIRST_MEMBER_ENABLED: "true",
  MULTI_DB_SYNC_ENABLED: "true",
  SYNC_WORKER_ENABLED: "true",
  SYNC_SUPABASE_ENABLED: "true",
  SUPABASE_DATABASE_URL: "postgresql://isolated.invalid/replica",
  SYNC_TURSO_ENABLED: "true",
  TURSO_DATABASE_URL: "libsql://isolated.invalid",
  TURSO_AUTH_TOKEN: "test-placeholder",
  SYNC_NEON_ENABLED: "false",
  SYNC_SNAPSHOT_ENABLED: "true",
  SYNC_CIRCUIT_FAILURE_THRESHOLD: "1",
  SYNC_CIRCUIT_OPEN_MS: "1000",
  SYNC_RETRY_BASE_MS: "100",
  SYNC_RETRY_MAX_MS: "1000",
  SYNC_RETRY_JITTER_RATIO: "0",
});

function makeGuild(id = guildB) {
  const value = {
    id,
    memberCount: 2,
    members: {
      cache: new Map(),
      async fetch() {
        return this.cache;
      },
    },
    voiceStates: { cache: new Map() },
  };
  const member = {
    id: userId,
    user: { id: userId, bot: false, username: "local-user" },
    guild: value,
    joinedAt: new Date("2026-08-30T00:00:00.000Z"),
    roles: { cache: new Map([[id, {}], ["400000000000000001", {}]]) },
  };
  value.members.cache.set(userId, member);
  return value;
}

function makeMessage(guild, id = "500000000000000001") {
  return {
    id,
    guild,
    guildId: guild.id,
    channelId: channelA,
    channel: { id: channelA, name: "general" },
    author: { id: userId, bot: false, username: "local-user" },
    member: guild.members.cache.get(userId),
    content: "reply payload",
    createdTimestamp: Date.parse("2026-08-30T10:00:00.000Z"),
    reference: {
      messageId: "500000000000000000",
      channelId: channelB,
      guildId: guild.id,
      type: 0,
    },
  };
}

function makeProvider(id, { failures = 0 } = {}) {
  const state = { failures, events: [], snapshots: [] };
  return {
    id,
    required: true,
    state,
    isEnabled: () => true,
    async pushEvents(items) {
      if (state.failures > 0) {
        state.failures -= 1;
        throw Object.assign(new Error("provider unavailable"), { code: "ECONNREFUSED" });
      }
      state.events.push(...items);
      return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
    },
    async pushSnapshots(items) {
      state.snapshots.push(...items);
      return {
        succeededSnapshotKeys: items.map(
          (item) => `${item.snapshotType}:${item.aggregateId}`,
        ),
        failed: [],
      };
    },
    async health() {
      return { status: "HEALTHY" };
    },
    async close() {},
  };
}

function registry(providers) {
  const values = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    list: () => [...values.values()],
    get: (id) => values.get(id) ?? null,
  };
}

test("all-Guild routing stores complete Raw domains locally and survives reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-all-guild-local-"));
  const databasePath = join(directory, "local.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let at = Date.parse("2026-08-30T10:00:00.000Z");
  const now = () => at;
  const storage = createLocalStorage({
    databasePath,
    providerDefinitions: getProviderPolicyDefinitions(env),
    now,
  });
  const legacy = { message: 0, reaction: 0, voice: 0, member: 0 };
  const messages = createMessageDomainRouter({
    env,
    storage,
    now,
    legacy: {
      create: () => { legacy.message += 1; },
      update: () => { legacy.message += 1; },
      remove: () => { legacy.message += 1; },
      recordActiveMember: () => { legacy.message += 1; },
    },
  });
  const events = createEventDomainRouter({
    env,
    storage,
    now,
    legacy: {
      reaction: () => { legacy.reaction += 1; },
      voice: () => { legacy.voice += 1; },
      member: () => { legacy.member += 1; },
    },
  });
  const guild = makeGuild();
  const member = guild.members.cache.get(userId);
  await messages.create(makeMessage(guild));
  const current = storage.messageDomain.getCurrent(guild.id, "500000000000000001");
  assert.deepEqual(current.payload.reference, {
    channelId: channelB,
    guildId: guild.id,
    messageId: "500000000000000000",
    type: "0",
  });
  assert.equal(messages.getRoutingMode(guild.id), "LOCAL_FIRST");
  at += 1_000;
  await messages.update({
    ...makeMessage(guild),
    content: "edited reply payload",
    editedTimestamp: at,
  });
  at += 1_000;
  await messages.remove(makeMessage(guild));
  assert.equal(
    storage.messageDomain.getCurrent(guild.id, "500000000000000001").eventType,
    "delete",
  );
  at += 1_000;
  await messages.removeMany([
    makeMessage(guild, "500000000000000002"),
    makeMessage(guild, "500000000000000003"),
  ]);

  await events.reaction({
    emoji: { id: null, name: "👍" },
    message: {
      id: "500000000000000001",
      channelId: channelA,
      guild,
      author: { id: "600000000000000001" },
    },
  }, member.user, "add");
  at += 1_000;
  await events.reaction({
    emoji: { id: null, name: "👍" },
    message: {
      id: "500000000000000001",
      channelId: channelA,
      guild,
      author: { id: "600000000000000001" },
    },
  }, member.user, "remove");
  at += 1_000;
  await events.voice(
    { guild, member, channelId: null },
    { guild, member, channelId: channelA },
  );
  at += 60_000;
  await events.voice(
    { guild, member, channelId: channelA },
    { guild, member, channelId: channelB },
  );
  at += 60_000;
  await events.voice(
    { guild, member, channelId: channelB },
    { guild, member, channelId: null },
  );
  at += 1_000;
  await events.member(member, "join");
  const beforeRoleUpdate = {
    ...member,
    roles: { cache: new Map(member.roles.cache) },
  };
  member.roles.cache.set("400000000000000002", {});
  at += 1_000;
  await events.member(member, "update", beforeRoleUpdate);
  at += 1_000;
  await events.member(member, "leave");
  at += 1_000;
  await events.voice(
    { guild, member, channelId: null },
    { guild, member, channelId: channelA },
  );

  assert.deepEqual(legacy, { message: 0, reaction: 0, voice: 0, member: 0 });
  assert.deepEqual(storage.analytics.getRawEventCounts(guild.id), {
    reactions: 2,
    voice: 4,
    members: 3,
  });
  assert.equal(storage.outbox.getQueueSize().count, 0);

  const compaction = createAnalyticsCompactionService(storage, {
    config: getAnalyticsCompactionConfig(env),
    now,
    logger: { info() {} },
  });
  const built = compaction.refreshDue({ at });
  assert.equal(built.changed > 0, true);
  assert.equal(storage.outbox.getQueueSize().count, 0);
  storage.close();

  const reopened = createLocalStorage({
    databasePath,
    providerDefinitions: getProviderPolicyDefinitions(env),
    now,
  });
  assert.equal(
    reopened.messageDomain.getCurrent(guild.id, "500000000000000001").eventType,
    "delete",
  );
  assert.equal(
    reopened.messageDomain.getCurrent(guild.id, "500000000000000003").eventType,
    "delete",
  );
  assert.deepEqual(reopened.analytics.getRawEventCounts(guild.id), {
    reactions: 2,
    voice: 4,
    members: 3,
  });
  assert.equal(
    reopened.analytics.getOpenVoiceSession(guild.id, userId).channelId,
    channelA,
  );
  assert.equal(
    reopened.syncMetadata.get("message_domain_routing").state,
    "local_first_all",
  );
  reopened.close();
});

test("Security audit is SQLite-primary, durable, and the only Raw audit replica", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-security-local-"));
  const databasePath = join(directory, "local.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let at = Date.parse("2026-08-30T11:00:00.000Z");
  const now = () => at;
  const providers = getProviderPolicyDefinitions(env);
  const storage = createLocalStorage({ databasePath, providerDefinitions: providers, now });
  const security = createSecurityAuditService({ storage, now });
  const started = security.startModeration({
    incidentId: "70000000-0000-4000-8000-000000000001",
    guildId: guildB,
    guildName: "Guild",
    action: "spam_timeout",
    actorId: "800000000000000001",
    actorName: "Moderator",
    targetId: userId,
    targetName: "Target",
    channelId: channelA,
    reason: "bounded spam detection",
    requestedCount: 3,
  });
  at += 1_000;
  security.completeModeration(started.incidentId, {
    status: "success",
    affectedCount: 1,
  });
  assert.equal(storage.outbox.getQueueSize().count, 2);
  storage.close();

  const reopened = createLocalStorage({ databasePath, providerDefinitions: providers, now });
  const reopenedSecurity = createSecurityAuditService({ storage: reopened, now });
  assert.equal(reopenedSecurity.getModerationAudit(started.incidentId).action, "spam_timeout");
  assert.equal(reopened.security.getByEventId(`${started.incidentId}:completion`).status, "success");
  assert.equal(reopened.outbox.getQueueSize().count, 2);

  const supabase = makeProvider("supabase", { failures: 1 });
  const turso = makeProvider("turso");
  const worker = new MultiProviderSyncWorker({
    storage: reopened,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(env),
    now,
    random: () => 0,
    logger: { info() {}, error() {} },
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(turso.state.events.every((item) => item.domain === "security"), true);
  assert.equal(reopened.outbox.getStatusCounts().dead_letter ?? 0, 0);
  at += 1_101;
  await worker.processOnce();
  assert.equal(supabase.state.events.length, 2);
  assert.equal(reopened.outbox.getStatusCounts().pending ?? 0, 0);
  assert.equal(reopened.outbox.getStatusCounts().retry ?? 0, 0);
  assert.equal(reopened.outbox.getStatusCounts().dead_letter ?? 0, 0);
  reopened.close();
});

test("Discord handlers do not contain direct Raw Cloud writes", () => {
  const source = readFileSync(new URL("../discord-bot.mjs", import.meta.url), "utf8");
  const start = source.indexOf('client.on("messageCreate"');
  const end = source.indexOf('client.on("error"');
  const eventHandlers = source.slice(start, end);
  assert.match(eventHandlers, /messageRouter\.create\(message\)/);
  assert.match(eventHandlers, /eventRouter\.reaction\(reaction, user, "add"\)/);
  assert.match(eventHandlers, /eventRouter\.voice\(oldState, newState\)/);
  assert.match(eventHandlers, /eventRouter\.member\(member, "join"\)/);
  assert.doesNotMatch(eventHandlers, /\bsql`|pool\.query|neon\(|discord_message|daily_stats|recent_activity|discord_reaction_event|voice_session|guild_member_event/);
});
