import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatInsightPresentation,
  formatVoiceDuration,
  resolveChannelDisplayName,
} from "../lib/insight-presentation.mjs";

const channelId = "1532925691111145644";

function insight(titleKey, values, overrides = {}) {
  return {
    titleKey,
    values,
    category: titleKey.startsWith("voice_") ? "voice" : titleKey.startsWith("channel_") ? "channel" : "activity",
    severity: titleKey.endsWith("increased") ? "positive" : "attention",
    recommendationKey: "review_activity_drivers",
    ...overrides,
  };
}

test("known and renamed channels resolve by stable channel ID", () => {
  assert.equal(resolveChannelDisplayName({
    channelId,
    projectedName: "old-name",
    channelNames: { [channelId]: { name: "新しい-雑談", deleted: false } },
  }), "新しい-雑談");
  assert.equal(resolveChannelDisplayName({
    channelId,
    projectedName: "🎵・音楽と雑談",
  }), "🎵・音楽と雑談");
});

test("deleted or unknown channels use a human-readable shortened fallback", () => {
  const label = resolveChannelDisplayName({ channelId, projectedName: channelId, locale: "ja" });
  assert.equal(label, "不明なチャンネル (…145644)");
  assert.doesNotMatch(label, new RegExp(channelId));
  assert.equal(resolveChannelDisplayName({ channelId, locale: "en" }), "Unknown channel (…145644)");
});

test("activity insight formats counts and does not expose null percent", () => {
  const copy = formatInsightPresentation(insight("activity_increased", {
    current: 228,
    previous: 0,
    percent: null,
  }));
  assert.equal(copy.title, "サーバー全体の活動が増えています");
  assert.equal(copy.detail, "前期間は記録がなく、現在228件です。");
  assert.doesNotMatch(JSON.stringify(copy), /activity_increased|"current"|null|NaN|Infinity/);
});

test("activity and member decrease values remain natural in Japanese and English", () => {
  const activity = formatInsightPresentation(insight("activity_decreased", {
    current: 80,
    previous: 120,
    percent: -33.3,
  }));
  assert.match(activity.detail, /前期間120件 → 現在80件（-33.3%）/);

  const member = formatInsightPresentation(insight("member_increased", {
    current: 12,
    previous: 8,
    percent: 50,
  }, { category: "member" }), { locale: "en" });
  assert.equal(member.title, "Member participation is increasing");
  assert.match(member.detail, /Previous 8 members → current 12 members \(\+50%\)/);
});

test("voice insight converts seconds into human-readable hours and minutes", () => {
  assert.equal(formatVoiceDuration(45_604, "ja"), "約12時間40分");
  const copy = formatInsightPresentation(insight("voice_increased", {
    current: 45_604,
    previous: 0,
    percent: null,
  }));
  assert.equal(copy.title, "通話活動が増えています");
  assert.match(copy.detail, /現在約12時間40分/);
  assert.doesNotMatch(copy.detail, /45604|null|NaN|Infinity/);
});

test("channel insight uses the resolved name while retaining the stable ID internally", () => {
  const original = insight("channel_increased", {
    id: channelId,
    name: channelId,
    change: { current: 34, previous: 10, percent: 240 },
  });
  const copy = formatInsightPresentation(original, {
    channelNames: { [channelId]: { name: "クリップとハイライト", deleted: false } },
  });
  assert.equal(copy.title, "#クリップとハイライト の利用が増えています");
  assert.match(copy.detail, /前期間10件 → 現在34件（\+240%）/);
  assert.equal(original.values.id, channelId);
});

test("retention, concentration, missing fields, and unknown keys never expose raw payloads", () => {
  const retention = formatInsightPresentation(insight("retention_decreased", {
    current: 32.5,
    previous: 45,
    delta: -12.5,
  }, { category: "retention" }));
  assert.match(retention.detail, /45% → 現在32.5% \(-12.5pt\)/);

  const concentration = formatInsightPresentation(insight("activity_concentrated", {
    share: 72.5,
  }, { category: "distribution" }));
  assert.match(concentration.detail, /72.5%/);

  const unknown = formatInsightPresentation(insight("future_internal_changed", {}));
  assert.equal(unknown.title, "サーバーの変化を確認しました");
  assert.doesNotMatch(Object.values(unknown).join(" "), /future_internal_changed|"current"|"previous"/);
});

test("production insight paths do not stringify raw insight values", async () => {
  const projection = await readFile(new URL("../lib/projection-analytics.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../components/community-analytics-dashboard.tsx", import.meta.url), "utf8");
  const metadata = await readFile(new URL("../lib/channel-metadata.ts", import.meta.url), "utf8");
  assert.doesNotMatch(projection, /JSON\.stringify\(insight\.values/);
  assert.doesNotMatch(dashboard, /JSON\.stringify\(insight\.values/);
  assert.doesNotMatch(dashboard, /\?\? insight\.titleKey/);
  assert.match(metadata, /import\("@\/lib\/db"\)/);
  assert.doesNotMatch(metadata, /auth-storage|INSERT|UPDATE|DELETE/);
});
