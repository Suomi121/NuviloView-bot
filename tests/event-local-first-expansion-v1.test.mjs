import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEventDomainRouter,
  getEventLocalFirstConfig,
} from "../lib/event-local-first.mjs";
import { createLocalStorage } from "../lib/storage/index.mjs";
import {
  analyticsCurrentProjectionKey,
  createAnalyticsCompactionService,
  getAnalyticsCompactionConfig,
} from "../lib/sync/analytics-compaction.mjs";
import { getMultiDbSyncConfig } from "../lib/sync/multi-config.mjs";
import { MultiProviderSyncWorker } from "../lib/sync/multi-worker.mjs";
import { getProviderPolicyDefinitions } from "../lib/sync/providers/contract.mjs";
import { analyticsProjectionKey } from "../lib/storage/repositories/analytics-projections.mjs";

const guildId = "100000000000000001";
const channelA = "200000000000000001";
const channelB = "200000000000000002";
const userId = "300000000000000001";

const eventEnv = Object.freeze({
  LOCAL_STORAGE_ENABLED: "true",
  LOCAL_STORAGE_WRITE_ENABLED: "true",
  LOCAL_MESSAGE_STORAGE_ENABLED: "true",
  LOCAL_MESSAGE_CANARY_GUILDS: guildId,
  ANALYTICS_COMPACTION_ENABLED: "true",
  ANALYTICS_COMPACTION_GUILD_IDS: guildId,
  ANALYTICS_SNAPSHOT_INTERVAL_SECONDS: "60",
  EVENT_LOCAL_FIRST_ENABLED: "true",
  EVENT_LOCAL_FIRST_GUILD_IDS: guildId,
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
  SYNC_PROVIDER_BATCH_MIN: "25",
  SYNC_PROVIDER_BATCH_MAX: "100",
  SYNC_CIRCUIT_FAILURE_THRESHOLD: "1",
  SYNC_CIRCUIT_OPEN_MS: "1000",
  SYNC_RETRY_BASE_MS: "100",
  SYNC_RETRY_MAX_MS: "1000",
  SYNC_RETRY_JITTER_RATIO: "0",
});

function member(guild, id = userId, roles = ["500000000000000001"]) {
  const value = {
    id,
    user: { id, bot: false, username: `user-${id.slice(-4)}` },
    guild,
    joinedAt: new Date("2026-08-28T00:00:00.000Z"),
    roles: { cache: new Map([[guild.id, {}], ...roles.map((role) => [role, {}])]) },
  };
  guild.members.cache.set(id, value);
  return value;
}

function guild() {
  const value = {
    id: guildId,
    memberCount: 76,
    members: {
      cache: new Map(),
      async fetch() {
        return this.cache;
      },
    },
    voiceStates: { cache: new Map() },
  };
  member(value);
  return value;
}

function reaction(guildValue, index = 0, emoji = "👍") {
  return {
    emoji: { id: null, name: emoji },
    message: {
      id: String(400000000000000000n + BigInt(index)),
      channelId: channelA,
      guild: guildValue,
      author: { id: "600000000000000001" },
    },
  };
}

function provider(id, { failures = 0 } = {}) {
  const state = {
    failures,
    eventWrites: 0,
    snapshotWrites: 0,
    snapshots: new Map(),
  };
  return {
    id,
    required: true,
    state,
    isEnabled: () => true,
    async pushEvents(items) {
      state.eventWrites += items.length;
      return { succeededEventIds: items.map((item) => item.eventId), failed: [] };
    },
    async pushSnapshots(items) {
      if (state.failures > 0) {
        state.failures -= 1;
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
        });
      }
      state.snapshotWrites += items.length;
      for (const item of items) {
        state.snapshots.set(`${item.snapshotType}:${item.aggregateId}`, item);
      }
      return {
        succeededSnapshotKeys: items.map(
          (item) => `${item.snapshotType}:${item.aggregateId}`,
        ),
        failed: [],
        queryCount: 1,
      };
    },
    async health() {
      return { status: "HEALTHY" };
    },
    async close() {},
  };
}

function registry(providers) {
  const values = new Map(providers.map((item) => [item.id, item]));
  return {
    list: () => [...values.values()],
    get: (id) => values.get(id) ?? null,
  };
}

function harness({ databasePath = ":memory:", start = Date.parse("2026-08-28T10:00:00.000Z") } = {}) {
  let at = start;
  const now = () => at;
  const storage = createLocalStorage({
    databasePath,
    providerDefinitions: getProviderPolicyDefinitions(eventEnv),
    now,
  });
  const legacyCalls = { reaction: 0, voice: 0, member: 0 };
  const router = createEventDomainRouter({
    env: eventEnv,
    storage,
    now,
    logger: { error() {}, warn() {} },
    legacy: {
      reaction: () => { legacyCalls.reaction += 1; },
      voice: () => { legacyCalls.voice += 1; },
      member: () => { legacyCalls.member += 1; },
    },
  });
  return {
    storage,
    router,
    legacyCalls,
    now,
    advance(milliseconds) {
      at += milliseconds;
      return at;
    },
  };
}

test("Event Local-First defaults OFF and rejects unsafe Canary configuration", () => {
  assert.equal(getEventLocalFirstConfig({}).enabled, false);
  const unsafe = getEventLocalFirstConfig({
    EVENT_LOCAL_FIRST_ENABLED: "true",
    EVENT_LOCAL_FIRST_GUILD_IDS: guildId,
  });
  assert.equal(unsafe.errors.includes("event_local_first_requires_writable_local_storage"), true);
  assert.equal(unsafe.errors.includes("event_local_first_requires_analytics_compaction"), true);
  assert.throws(
    () => createEventDomainRouter({ env: {
      ...eventEnv,
      ANALYTICS_COMPACTION_GUILD_IDS: "999999999999999999",
    } }),
    (error) => error?.code === "EVENT_LOCAL_FIRST_UNSAFE_CONFIGURATION",
  );
});

test("Reaction add/remove is idempotent, stays local, and syncs only projections", async () => {
  const h = harness();
  const guildValue = guild();
  const user = guildValue.members.cache.get(userId).user;
  for (let index = 0; index < 100; index += 1) {
    await h.router.reaction(reaction(guildValue, index), user, "add");
    h.advance(1);
  }
  const duplicate = await h.router.reaction(reaction(guildValue, 0), user, "add");
  assert.equal(duplicate.inserted, false);
  h.advance(1);
  await h.router.reaction(reaction(guildValue, 0), user, "remove");
  assert.deepEqual(h.storage.analytics.getRawEventCounts(guildId), {
    reactions: 101,
    voice: 0,
    members: 0,
  });
  assert.equal(h.storage.outbox.getQueueSize().count, 0);

  const service = createAnalyticsCompactionService(h.storage, {
    config: getAnalyticsCompactionConfig(eventEnv),
    now: h.now,
    logger: { info() {} },
  });
  const built = service.refreshDue({ at: h.now() });
  assert.equal(built.changed, 4);
  const current = h.storage.snapshots.get(
    "analytics",
    analyticsCurrentProjectionKey(guildId),
  );
  assert.equal(current.payload.reactionCount, 99);
  assert.equal(current.payload.uniqueReactors, 1);
  assert.equal(current.payload.reactedMessages, 99);
  assert.equal(current.payload.rawContentIncluded, false);
  const daily = h.storage.analyticsProjections.buildMaterial({
    projectionKind: "guild_daily",
    guildId,
    dateUtc: "2026-08-28",
    channelId: null,
    userId: null,
  });
  assert.equal(daily.reactionCount, 100);
  assert.equal(daily.reactionAdds, 100);
  assert.equal(daily.reactionRemoves, 1);

  const supabase = provider("supabase");
  const turso = provider("turso");
  const worker = new MultiProviderSyncWorker({
    storage: h.storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(eventEnv),
    now: h.now,
    logger: { info() {}, error() {} },
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(supabase.state.eventWrites, 0);
  assert.equal(turso.state.eventWrites, 0);
  const key = `analytics:${analyticsCurrentProjectionKey(guildId)}`;
  assert.equal(supabase.state.snapshots.get(key).checksum, turso.state.snapshots.get(key).checksum);
  h.storage.close();
});

test("Reaction current projection uses local state across a pre-observation remove", async () => {
  const h = harness();
  const guildValue = guild();
  const user = guildValue.members.cache.get(userId).user;
  const value = reaction(guildValue, 501);
  await h.router.reaction(value, user, "remove");
  h.advance(1);
  await h.router.reaction(value, user, "add");
  const material = h.storage.analyticsProjections.buildMaterial({
    projectionKind: "guild_current",
    guildId,
    dateUtc: null,
    channelId: null,
    userId: null,
  });
  assert.equal(material.reactionCount, 1);
  assert.equal(material.uniqueReactors, 1);
  assert.equal(material.reactedMessages, 1);
  h.storage.close();
});

test("Voice join/move/leave records exact segments and duplicate events do not split sessions", async () => {
  const h = harness();
  const guildValue = guild();
  const memberValue = guildValue.members.cache.get(userId);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: null },
    { guild: guildValue, member: memberValue, channelId: channelA },
  );
  h.advance(120_000);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: channelA },
    { guild: guildValue, member: memberValue, channelId: channelB },
  );
  const duplicateMove = await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: channelA },
    { guild: guildValue, member: memberValue, channelId: channelB },
  );
  assert.equal(duplicateMove.inserted, false);
  h.advance(60_000);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: channelB },
    { guild: guildValue, member: memberValue, channelId: null },
  );
  const duplicateLeave = await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: channelB },
    { guild: guildValue, member: memberValue, channelId: null },
  );
  assert.equal(duplicateLeave.inserted, false);
  assert.equal(h.storage.analytics.getRawEventCounts(guildId).voice, 3);
  assert.equal(h.storage.analytics.getOpenVoiceSession(guildId, userId), null);

  const material = h.storage.analyticsProjections.buildMaterial({
    projectionKind: "guild_daily",
    guildId,
    dateUtc: "2026-08-28",
    channelId: null,
    userId: null,
  });
  assert.equal(material.voiceSeconds, 180);
  assert.equal(material.voiceSessions, 2);
  assert.equal(material.uniqueVoiceMembers, 1);
  assert.equal(material.peakConcurrent, 1);
  assert.deepEqual(material.channelVoiceMinutes, [
    { channelId: channelA, minutes: 2 },
    { channelId: channelB, minutes: 1 },
  ]);
  h.storage.close();
});

test("Voice sessions crossing UTC midnight dirty and aggregate every affected day", async () => {
  const h = harness({ start: Date.parse("2026-08-28T23:59:00.000Z") });
  const guildValue = guild();
  const memberValue = guildValue.members.cache.get(userId);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: null },
    { guild: guildValue, member: memberValue, channelId: channelA },
  );
  h.advance(120_000);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: channelA },
    { guild: guildValue, member: memberValue, channelId: null },
  );
  for (const [dateUtc, expectedSeconds] of [
    ["2026-08-28", 60],
    ["2026-08-29", 60],
  ]) {
    assert.equal(
      h.storage.analyticsProjections.getDirty(analyticsProjectionKey({
        kind: "guild_daily",
        guildId,
        dateUtc,
      }))?.dirty,
      true,
    );
    const material = h.storage.analyticsProjections.buildMaterial({
      projectionKind: "guild_daily",
      guildId,
      dateUtc,
      channelId: null,
      userId: null,
    });
    assert.equal(material.voiceSeconds, expectedSeconds);
  }
  h.storage.close();
});

test("Voice recovery survives reopen and never invents an unknown duration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nuviloview-event-voice-"));
  const databasePath = join(directory, "local.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = harness({ databasePath });
  const guildValue = guild();
  const memberValue = guildValue.members.cache.get(userId);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: null },
    { guild: guildValue, member: memberValue, channelId: channelA },
  );
  h.advance(300_000);
  h.storage.close();

  const reopened = createLocalStorage({
    databasePath,
    providerDefinitions: getProviderPolicyDefinitions(eventEnv),
    now: h.now,
  });
  const results = reopened.analytics.reconcileVoiceSessions({
    guildId,
    states: [],
    occurredAt: h.now(),
  });
  for (const result of results) {
    for (const event of result.events ?? []) {
      reopened.analyticsProjections.markVoiceEvent({
        ...event,
        affectedChannelIds: result.affectedChannelIds,
      });
    }
  }
  assert.equal(reopened.analytics.getOpenVoiceSession(guildId, userId), null);
  const material = reopened.analyticsProjections.buildMaterial({
    projectionKind: "guild_daily",
    guildId,
    dateUtc: "2026-08-28",
    channelId: null,
    userId: null,
  });
  assert.equal(material.voiceSeconds, 0);
  assert.equal(material.recoveredUnknownSessions, 1);
  reopened.close();
});

test("Member join/update/leave is deduplicated and keeps exact current count", async () => {
  const h = harness();
  const guildValue = guild();
  const joined = guildValue.members.cache.get(userId);
  assert.equal((await h.router.member(joined, "join")).inserted, true);
  assert.equal((await h.router.member(joined, "join")).inserted, false);
  h.advance(1_000);
  const before = joined;
  const after = member(guildValue, userId, ["500000000000000002"]);
  assert.equal((await h.router.member(after, "update", before)).inserted, true);
  assert.equal((await h.router.member(after, "update", before)).inserted, false);
  h.advance(1_000);
  guildValue.memberCount = 75;
  assert.equal((await h.router.member(after, "leave")).inserted, true);
  assert.equal((await h.router.member(after, "leave")).inserted, false);
  assert.equal(h.storage.analytics.getRawEventCounts(guildId).members, 3);
  assert.equal(h.storage.analytics.getGuildMemberCount(guildId), 75);
  assert.equal(h.storage.analytics.getMemberState(guildId, userId).isPresent, false);

  const material = h.storage.analyticsProjections.buildMaterial({
    projectionKind: "guild_daily",
    guildId,
    dateUtc: "2026-08-28",
    channelId: null,
    userId: null,
  });
  assert.equal(material.joins, 1);
  assert.equal(material.leaves, 1);
  assert.equal(material.memberDelta, 0);
  assert.equal(material.currentMemberCount, 75);
  h.storage.close();
});

test("Member startup baseline can repair an absent state without Stable ID collision", async () => {
  const h = harness();
  const guildValue = guild();
  const memberValue = guildValue.members.cache.get(userId);
  const initial = await h.router.syncMemberGuild(guildValue, { fetchMembers: false });
  assert.equal(initial.filter((result) => result.inserted).length, 1);
  h.advance(1_000);
  guildValue.memberCount = 75;
  assert.equal((await h.router.member(memberValue, "leave")).inserted, true);
  h.advance(1_000);
  guildValue.memberCount = 76;
  const recovered = await h.router.syncMemberGuild(guildValue, { fetchMembers: false });
  assert.equal(recovered.filter((result) => result.inserted).length, 1);
  assert.equal(h.storage.analytics.getMemberState(guildId, userId).isPresent, true);
  assert.equal(h.storage.analytics.getGuildMemberCount(guildId), 76);
  const repeated = await h.router.syncMemberGuild(guildValue, { fetchMembers: false });
  assert.equal(repeated.filter((result) => result.inserted).length, 0);
  h.storage.close();
});

test("Message, Reaction, Voice, and Member events share a stable 15-minute projection", async () => {
  const h = harness();
  const guildValue = guild();
  const memberValue = guildValue.members.cache.get(userId);
  h.storage.transaction(() => {
    const messageResult = h.storage.messageDomain.recordEvent({
      eventId: `message-create:${guildId}:700000000000000001`,
      guildId,
      channelId: channelA,
      messageId: "700000000000000001",
      authorId: userId,
      eventType: "create",
      revision: `create:${h.now()}`,
      sourceSequence: h.now(),
      content: "local-only",
      occurredAt: h.now(),
      actorName: "user",
      channelName: "general",
      payload: { source: "test" },
    });
    h.storage.analyticsProjections.markMessageEvent(messageResult.event);
  });
  await h.router.reaction(reaction(guildValue, 1), memberValue.user, "add");
  h.advance(1_000);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: null },
    { guild: guildValue, member: memberValue, channelId: channelA },
  );
  h.advance(60_000);
  await h.router.voice(
    { guild: guildValue, member: memberValue, channelId: channelA },
    { guild: guildValue, member: memberValue, channelId: null },
  );
  h.advance(1_000);
  await h.router.member(memberValue, "join");
  const service = createAnalyticsCompactionService(h.storage, {
    config: getAnalyticsCompactionConfig(eventEnv),
    now: h.now,
    logger: { info() {} },
  });
  service.refreshDue({ at: h.now() });
  const payload = h.storage.snapshots.get(
    "analytics",
    analyticsCurrentProjectionKey(guildId),
  ).payload;
  assert.equal(payload.schemaVersion, 3);
  assert.equal(payload.messageCount, 1);
  assert.equal(payload.reactionCount, 1);
  assert.equal(payload.voiceSeconds, 60);
  assert.equal(payload.joins, 1);
  assert.equal(payload.rawContentIncluded, false);
  assert.equal(JSON.stringify(payload).includes("local-only"), false);
  h.storage.close();
});

test("one or both Cloud replicas can fail while local Events remain durable and recover without DLQ", async () => {
  const h = harness();
  const guildValue = guild();
  const user = guildValue.members.cache.get(userId).user;
  await h.router.reaction(reaction(guildValue, 10), user, "add");
  const service = createAnalyticsCompactionService(h.storage, {
    config: getAnalyticsCompactionConfig(eventEnv),
    now: h.now,
    logger: { info() {} },
  });
  service.refreshDue({ at: h.now() });

  const supabase = provider("supabase", { failures: 1 });
  const turso = provider("turso");
  const worker = new MultiProviderSyncWorker({
    storage: h.storage,
    registry: registry([supabase, turso]),
    config: getMultiDbSyncConfig(eventEnv),
    now: h.now,
    random: () => 0,
    logger: { info() {}, error() {} },
    snapshotWriter: async () => {},
  });
  await worker.processOnce();
  assert.equal(h.storage.snapshots.getStatusCounts("supabase").retry > 0, true);
  assert.equal(h.storage.snapshots.getStatusCounts("supabase").dead_letter ?? 0, 0);
  assert.equal(h.storage.snapshots.getStatusCounts("turso").synced > 0, true);
  assert.equal(h.storage.analytics.getRawEventCounts(guildId).reactions, 1);

  h.advance(1_101);
  await worker.processOnce();
  assert.equal(h.storage.snapshots.getStatusCounts("supabase").retry ?? 0, 0);
  assert.equal(h.storage.snapshots.getStatusCounts("supabase").dead_letter ?? 0, 0);

  await h.router.reaction(reaction(guildValue, 11), user, "add");
  h.advance(60_001);
  service.refreshDue({ at: h.now() });
  supabase.state.failures = 1;
  turso.state.failures = 1;
  await worker.processOnce();
  assert.equal(h.storage.analytics.getRawEventCounts(guildId).reactions, 2);
  assert.equal(h.storage.snapshots.getStatusCounts("supabase").dead_letter ?? 0, 0);
  assert.equal(h.storage.snapshots.getStatusCounts("turso").dead_letter ?? 0, 0);
  h.advance(1_101);
  await worker.processOnce();
  await worker.processOnce();
  for (const providerId of ["supabase", "turso"]) {
    const status = h.storage.snapshots.getStatusCounts(providerId);
    assert.equal(status.pending ?? 0, 0);
    assert.equal(status.retry ?? 0, 0);
    assert.equal(status.dead_letter ?? 0, 0);
  }
  h.storage.close();
});

test("Reaction/Voice/Member 100/1000/10000 matrices keep Cloud work bucket-bounded", async () => {
  for (const domain of ["reaction", "voice", "members"]) {
    for (const count of [100, 1_000, 10_000]) {
      const at = Date.parse("2026-08-28T12:00:00.000Z");
      const now = () => at;
      const storage = createLocalStorage({ databasePath: ":memory:", now });
      storage.transaction(() => {
        for (let index = 0; index < count; index += 1) {
          const occurredAt = at + index * 1_000;
          if (domain === "reaction") {
            const result = storage.analytics.recordReactionTransition({
              guildId,
              channelId: channelA,
              messageId: "800000000000000001",
              userId,
              emojiKey: "unicode:👍",
              action: index % 2 === 0 ? "add" : "remove",
              occurredAt,
              sourceSequence: occurredAt,
            });
            if (result.inserted) storage.analyticsProjections.markReactionEvent(result.event);
          } else if (domain === "voice") {
            const joining = index % 2 === 0;
            const result = storage.analytics.recordVoiceTransition({
              guildId,
              userId,
              previousChannelId: joining ? null : channelA,
              channelId: joining ? channelA : null,
              occurredAt,
              sourceSequence: occurredAt,
            });
            for (const event of result.events ?? []) {
              storage.analyticsProjections.markVoiceEvent({
                ...event,
                affectedChannelIds: result.affectedChannelIds,
              });
            }
          } else {
            const result = storage.analytics.recordMemberTransition({
              guildId,
              userId,
              eventType: index % 2 === 0 ? "join" : "leave",
              roleIds: [],
              roleHash: "empty",
              memberCount: 76 - (index % 2),
              occurredAt,
              sourceSequence: occurredAt,
            });
            if (result.inserted) storage.analyticsProjections.markMemberEvent(result.event);
          }
        }
      });
      const service = createAnalyticsCompactionService(storage, {
        config: getAnalyticsCompactionConfig(eventEnv),
        now,
        logger: { info() {} },
      });
      const result = service.refreshDue({ at });
      const supabase = provider("supabase");
      const turso = provider("turso");
      const worker = new MultiProviderSyncWorker({
        storage,
        registry: registry([supabase, turso]),
        config: getMultiDbSyncConfig(eventEnv),
        now,
        logger: { info() {}, error() {} },
        snapshotWriter: async () => {},
      });
      await worker.processOnce();
      const rawKey = domain === "reaction" ? "reactions" : domain;
      const raw = storage.analytics.getRawEventCounts(guildId)[rawKey];
      const metrics = storage.analyticsProjections.getMetrics();
      assert.equal(raw, count, `${domain}:${count}`);
      assert.equal(result.changed <= 4, true, `${domain}:${count}:bounded`);
      assert.equal(metrics.rawEventsSeen, count, `${domain}:${count}:raw-metrics`);
      assert.equal(metrics.snapshotsBuilt <= 4, true, `${domain}:${count}:built`);
      assert.equal(metrics.snapshotsChanged <= 4, true, `${domain}:${count}:changed`);
      assert.equal(metrics.providerWrites <= 8, true, `${domain}:${count}:provider-writes`);
      assert.equal(
        metrics.providerWriteReductionRatio >= 0.92,
        true,
        `${domain}:${count}:reduction`,
      );
      assert.equal(supabase.state.eventWrites + turso.state.eventWrites, 0);
      assert.equal(storage.outbox.getQueueSize().count, 0);
      storage.close();
    }
  }
});

test("discord-bot handlers route target events through the guarded local router", () => {
  const source = readFileSync(
    new URL("../discord-bot.mjs", import.meta.url),
    "utf8",
  );
  const reactionSection = source.slice(
    source.indexOf('client.on("messageReactionAdd"'),
    source.indexOf('client.on("voiceStateUpdate"'),
  );
  assert.match(reactionSection, /eventRouter\.reaction\(reaction, user, "add"\)/);
  assert.match(reactionSection, /eventRouter\.reaction\(reaction, user, "remove"\)/);
  assert.doesNotMatch(reactionSection, /INSERT INTO "discord_reaction_event"/);
  assert.match(source, /eventRouter\.voice\(oldState, newState\)/);
  assert.match(source, /eventRouter\.member\(member, "join"\)/);
  assert.match(source, /eventRouter\.member\(member, "leave"\)/);
  assert.match(source, /eventRouter\.member\(after, "update", before\)/);
  assert.match(
    source,
    /async function syncMemberEventCloudSummaries\(guild\)[\s\S]*?isLocalFirstGuild\("member", guild\.id\)\) return null;/,
  );
  const memberSection = source.slice(
    source.indexOf('client.on(\n  "guildMemberAdd"'),
    source.indexOf('client.on("error"'),
  );
  assert.doesNotMatch(memberSection, /INSERT INTO "guild_member_event"/);
  assert.doesNotMatch(memberSection, /INSERT INTO "daily_stats"/);
});
