import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectionCommunityAnalytics,
  buildProjectionDashboardStatus,
  buildProjectionGoalMetrics,
} from "../lib/projection-analytics.ts";

const guildId = "1542212573389127723";
const generatedAt = Date.parse("2026-08-28T12:00:00.000Z");

function projection(aggregateId, payload) {
  return {
    aggregateId,
    snapshotVersion: 3,
    payload: {
      schemaVersion: 3,
      guildId,
      lastUpdatedAt: generatedAt,
      nextUpdateAt: generatedAt + 900_000,
      ...payload,
    },
    checksum: aggregateId,
    generatedAt,
    syncedAt: generatedAt,
  };
}

const bundle = {
  available: true,
  current: projection(`v2:guild:${guildId}:current`, {
    projection: "guild_current",
    currentMemberCount: 100,
    messageCount: 18,
    reactionCount: 7,
  }),
  snapshots: [
    projection(`v2:guild:${guildId}:daily:2026-08-27`, {
      projection: "guild_daily",
      dateUtc: "2026-08-27",
      messageCount: 8,
      reactionCount: 3,
      voiceSeconds: 300,
      voiceSessions: 1,
      uniqueVoiceMembers: 1,
      joins: 0,
      leaves: 1,
      memberDelta: -1,
      currentMemberCount: 99,
      activeMembers: 1,
    }),
    projection(`v2:guild:${guildId}:daily:2026-08-28`, {
      projection: "guild_daily",
      dateUtc: "2026-08-28",
      messageCount: 10,
      reactionCount: 4,
      voiceSeconds: 600,
      voiceSessions: 2,
      uniqueVoiceMembers: 2,
      joins: 1,
      leaves: 0,
      memberDelta: 1,
      currentMemberCount: 100,
      activeMembers: 2,
    }),
    projection(`v2:guild:${guildId}:channel:1507737783404462130:daily:2026-08-28`, {
      projection: "channel_daily",
      dateUtc: "2026-08-28",
      channelId: "1507737783404462130",
      messageCount: 10,
      reactionCount: 4,
      voiceSeconds: 600,
      voiceSessions: 2,
      activeMembers: 2,
    }),
    projection(`v2:guild:${guildId}:user:1489038702377435149:daily:2026-08-28`, {
      projection: "user_daily",
      dateUtc: "2026-08-28",
      userId: "1489038702377435149",
      messageCount: 6,
      reactionCount: 1,
      voiceSeconds: 300,
      joins: 1,
    }),
    projection(`v2:guild:${guildId}:user:1489038702377435150:daily:2026-08-28`, {
      projection: "user_daily",
      dateUtc: "2026-08-28",
      userId: "1489038702377435150",
      messageCount: 4,
      reactionCount: 3,
      voiceSeconds: 300,
    }),
  ],
  metadata: {
    provider: "supabase",
    snapshotVersion: 3,
    checksum: "current",
    lastUpdatedAt: generatedAt,
    nextUpdateAt: generatedAt + 900_000,
    freshness: "fresh",
    degraded: false,
  },
};

const range = {
  startDate: "2026-08-28",
  endDate: "2026-08-28",
  previousStartDate: "2026-08-27",
  previousEndDate: "2026-08-27",
  days: 1,
  timeZone: "Asia/Tokyo",
  roleId: null,
  channelId: null,
  excludeBots: true,
};

test("Message, Reaction, Voice, and Member totals come from compacted rows", () => {
  const analytics = buildProjectionCommunityAnalytics(bundle, range, {
    locale: "ja",
    channelNames: {
      "1507737783404462130": { name: "雑談", deleted: false },
    },
  });
  assert.equal(analytics.diagnostics.metrics.find((item) => item.key === "messages").current, 10);
  assert.equal(analytics.diagnostics.metrics.find((item) => item.key === "reaction_rate").current, 40);
  assert.equal(analytics.diagnostics.metrics.find((item) => item.key === "voice_activity").current, 600);
  assert.equal(analytics.diagnostics.metrics.find((item) => item.key === "new_members").current, 1);
  assert.equal(analytics.channels[0].channelId, "1507737783404462130");
  assert.equal(analytics.channels[0].name, "雑談");
  assert.equal(analytics.readMeta.provider, "supabase");
  assert.equal(analytics.readMeta.rawAnalyticsQueries, 0);
});

test("Dashboard response preserves the existing chart contract", () => {
  const dashboard = buildProjectionDashboardStatus(bundle, range, false, {
    channelNames: {
      "1507737783404462130": { name: "general", deleted: false },
    },
  });
  assert.deepEqual(dashboard.chartPoints, [10]);
  assert.deepEqual(dashboard.reactionPoints, [40]);
  assert.equal(dashboard.latestMemberCount, 100);
  assert.equal(dashboard.previousMemberCount, 99);
  assert.equal(dashboard.voiceTotalSeconds, 600);
  assert.equal(dashboard.channelInsights[0].channelName, "general");
  assert.equal(dashboard.readMeta.freshness, "fresh");
});

test("unresolved channel IDs are replaced with a human-readable fallback", () => {
  const dashboard = buildProjectionDashboardStatus(bundle, range, false);
  assert.equal(dashboard.channelInsights[0].channelName, "不明なチャンネル (…462130)");
  assert.doesNotMatch(dashboard.channelInsights[0].channelName, /1507737783404462130/);
  assert.ok(dashboard.readMeta.limitations.includes("channel_names_partially_resolved"));
});

test("dashboard server insights are localized and never contain internal keys or raw JSON", () => {
  const highActivityBundle = {
    ...bundle,
    snapshots: [
      projection(`v2:guild:${guildId}:daily:2026-08-27`, {
        projection: "guild_daily",
        dateUtc: "2026-08-27",
        messageCount: 0,
        voiceSeconds: 0,
        activeMembers: 0,
      }),
      projection(`v2:guild:${guildId}:daily:2026-08-28`, {
        projection: "guild_daily",
        dateUtc: "2026-08-28",
        messageCount: 228,
        voiceSeconds: 45_604,
        voiceSessions: 4,
        activeMembers: 12,
      }),
      projection(`v2:guild:${guildId}:channel:1507737783404462130:daily:2026-08-28`, {
        projection: "channel_daily",
        dateUtc: "2026-08-28",
        channelId: "1507737783404462130",
        messageCount: 228,
        voiceSeconds: 45_604,
        voiceSessions: 4,
        activeMembers: 12,
      }),
    ],
  };
  const dashboard = buildProjectionDashboardStatus(highActivityBundle, range, false, {
    channelNames: {
      "1507737783404462130": { name: "雑談", deleted: false },
    },
  });
  const rendered = JSON.stringify({ insight: dashboard.insight, cards: dashboard.insightCards });
  assert.equal(dashboard.insight.title, "#雑談 の利用が増えています");
  assert.match(rendered, /通話活動が増えています/);
  assert.match(rendered, /約12時間40分/);
  assert.doesNotMatch(rendered, /activity_increased|voice_increased|channel_increased|"current"|"previous"|"percent"/);
});

test("Goal progress uses the same monthly Projection rows", () => {
  const goals = buildProjectionGoalMetrics(bundle, "2026-08-01", "2026-08-28");
  assert.deepEqual(goals.values, {
    member_growth: 0,
    messages: 18,
    voice_seconds: 900,
  });
  assert.equal(goals.readMeta.rawAnalyticsQueries, 0);
});

test("unavailable providers produce a safe empty degraded model", () => {
  const unavailable = {
    available: false,
    current: null,
    snapshots: [],
    metadata: {
      provider: null,
      snapshotVersion: null,
      checksum: null,
      lastUpdatedAt: null,
      nextUpdateAt: null,
      freshness: "unavailable",
      degraded: true,
    },
  };
  const analytics = buildProjectionCommunityAnalytics(unavailable, range);
  assert.equal(analytics.readMeta.available, false);
  assert.equal(analytics.readMeta.freshness, "unavailable");
  assert.equal(analytics.diagnostics.metrics.find((item) => item.key === "messages").current, 0);
});
