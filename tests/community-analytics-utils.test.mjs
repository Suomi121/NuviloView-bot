import assert from "node:assert/strict";
import test from "node:test";

import {
  HEALTH_SCORE_THRESHOLDS,
  HEALTH_SCORE_WEIGHTS,
  buildInsights,
  calculateHealthScore,
  channelStatus,
  comparison,
  contribution,
  isAuthorizedGuild,
  percentagePointChange,
  safeRate,
  scoreStatus,
} from "../lib/community-analytics-utils.mjs";

function healthInput(overrides = {}) {
  return {
    memberCount: 100,
    activeUsers: 20,
    activityUsers: 20,
    messages: 280,
    reactions: 140,
    retention7: 50,
    retention30: 50,
    topMemberShare: 40,
    uniqueMessageAuthors: 20,
    voiceUsers: 10,
    voiceSeconds: 16_800,
    voiceSessions: 20,
    joins: 5,
    leaves: 2,
    earlyLeaves: 1,
    observationDays: 7,
    ...overrides,
  };
}

test("retention-style rates distinguish zero percent from no eligible cohort", () => {
  assert.equal(safeRate(0, 10), 0);
  assert.equal(safeRate(0, 0), null);
  assert.equal(safeRate(1, 1), 100);
});

test("comparisons never emit infinity when the previous period is zero", () => {
  assert.deepEqual(comparison(0, 0), {
    current: 0, previous: 0, absolute: 0, percent: null, direction: "flat", enoughSample: true, significant: false,
  });
  const started = comparison(25, 0, { minimumSample: 10 });
  assert.equal(started.percent, null);
  assert.equal(started.absolute, 25);
  assert.equal(started.significant, true);
});

test("percentage-point changes are not confused with percent changes", () => {
  assert.equal(percentagePointChange(42.8, 37.5), 5.3);
  assert.equal(percentagePointChange(null, 10), null);
});

test("contribution uses absolute contributor delta over absolute total delta", () => {
  assert.equal(contribution(-430, -1000), 43);
  assert.equal(contribution(20, 0), null);
});

test("health weights total 100 and missing categories are re-normalized", () => {
  assert.equal(Object.values(HEALTH_SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
  const score = calculateHealthScore({
    memberCount: 100, activeUsers: 30, messages: 180, reactions: 54,
    retention7: 50, retention30: null, topMemberShare: 35, uniqueMessageAuthors: 30,
    voiceUsers: 0, voiceSeconds: 0, joins: 10, leaves: 2, earlyLeaves: 1,
    observationDays: 30,
  });
  assert.ok(score.score !== null && score.score > 0 && score.score <= 100);
  assert.equal(score.categories.retention, 50);
  assert.equal(score.availableWeight, 100);

  const noVoiceData = calculateHealthScore({
    memberCount: 100, activeUsers: 30, messages: 180, reactions: 54,
    retention7: 50, retention30: null, topMemberShare: 35, uniqueMessageAuthors: 30,
    voiceUsers: null, voiceSeconds: null, joins: 10, leaves: 2, earlyLeaves: 1,
    observationDays: 30,
  });
  assert.ok(noVoiceData.score !== null);
  assert.equal(noVoiceData.categories.voice, null);
  assert.equal(noVoiceData.availableWeight, 85);
});

test("activity retention distinguishes immature cohorts and clamps invalid rates", () => {
  assert.equal(safeRate(0, 0), null, "an immature or unobservable cohort is missing, not zero");
  assert.equal(safeRate(0, 10), 0);
  assert.equal(safeRate(10, 10), 100);

  const score = calculateHealthScore(healthInput({ retention7: -25, retention30: 140 }));
  assert.equal(score.categories.retention, 50);
  const invalid = calculateHealthScore(healthInput({ retention7: Number.NaN, retention30: Number.POSITIVE_INFINITY }));
  assert.equal(invalid.categories.retention, null);
});

test("daily message normalization is stable across 7-day and 30-day ranges", () => {
  const sevenDays = calculateHealthScore(healthInput({ activeUsers: 20, messages: 280, reactions: 140, observationDays: 7 }));
  const thirtyDays = calculateHealthScore(healthInput({ activeUsers: 20, messages: 1_200, reactions: 600, observationDays: 30 }));
  assert.equal(sevenDays.inputs.messagesPerActivePerDay, 2);
  assert.equal(thirtyDays.inputs.messagesPerActivePerDay, 2);
  assert.equal(sevenDays.categories.engagement, thirtyDays.categories.engagement);
});

test("30-day growth normalization is stable across period lengths", () => {
  const sevenDays = calculateHealthScore(healthInput({ memberCount: 6_000, joins: 7, leaves: 0, earlyLeaves: 0, observationDays: 7 }));
  const thirtyDays = calculateHealthScore(healthInput({ memberCount: 6_000, joins: 30, leaves: 0, earlyLeaves: 0, observationDays: 30 }));
  assert.equal(sevenDays.inputs.normalized30DayGrowthRate, thirtyDays.inputs.normalized30DayGrowthRate);
  assert.equal(sevenDays.categories.growth, thirtyDays.categories.growth);
});

test("voice intensity uses voice users and daily normalization", () => {
  const base = { voiceUsers: 10, voiceSeconds: 72_000, observationDays: 30 };
  const fewMessageAuthors = calculateHealthScore(healthInput({ ...base, activeUsers: 2 }));
  const manyMessageAuthors = calculateHealthScore(healthInput({ ...base, activeUsers: 90 }));
  assert.equal(fewMessageAuthors.inputs.voiceHoursPerVoiceUserPerDay, manyMessageAuthors.inputs.voiceHoursPerVoiceUserPerDay);
  assert.equal(fewMessageAuthors.categories.voice, manyMessageAuthors.categories.voice);

  const noVoiceUsers = calculateHealthScore(healthInput({ voiceUsers: 0, voiceSeconds: 0 }));
  assert.equal(noVoiceUsers.categories.voice, 0);
  const beforeTracking = calculateHealthScore(healthInput({ voiceUsers: null, voiceSeconds: null }));
  assert.equal(beforeTracking.categories.voice, null);
});

test("formal health availability enforces category, confidence, and observation minimums", () => {
  const categoryBase = healthInput({
    memberCount: 0, activeUsers: 0, messages: 0, reactions: 0,
    retention7: 80, retention30: 80, topMemberShare: 40, uniqueMessageAuthors: 10,
    voiceUsers: null, voiceSeconds: null, joins: 0, leaves: 0, earlyLeaves: 0,
    activityUsers: 30, voiceSessions: 300, observationDays: 7,
  });
  const twoCategories = calculateHealthScore(categoryBase);
  assert.equal(twoCategories.availableCategoryCount, 2);
  assert.equal(twoCategories.isAvailable, false);
  assert.equal(twoCategories.score, null);
  assert.notEqual(twoCategories.provisionalScore, null);

  const threeCategories = calculateHealthScore({ ...categoryBase, joins: 1 });
  assert.equal(threeCategories.availableCategoryCount, 3);
  assert.equal(threeCategories.isAvailable, true);

  const confidence39 = calculateHealthScore({ ...categoryBase, joins: 1, activityUsers: 0, voiceSessions: 295 });
  assert.equal(confidence39.confidenceScore, 39);
  assert.equal(confidence39.isAvailable, false);
  const confidence40 = calculateHealthScore({ ...categoryBase, joins: 1, activityUsers: 1, voiceSessions: 299 });
  assert.equal(confidence40.confidenceScore, 40);
  assert.equal(confidence40.isAvailable, true);

  const sixDays = calculateHealthScore(healthInput({ observationDays: 6, activityUsers: 30, voiceSessions: 300 }));
  assert.equal(sixDays.isAvailable, false);
  const sevenDays = calculateHealthScore(healthInput({ observationDays: 7, activityUsers: 30, voiceSessions: 300 }));
  assert.equal(sevenDays.isAvailable, true);
});

test("distribution requires ten unique message authors and preserves share boundaries", () => {
  assert.equal(HEALTH_SCORE_THRESHOLDS.minimumDistributionAuthors, 10);
  assert.equal(calculateHealthScore(healthInput({ uniqueMessageAuthors: 9 })).categories.distribution, null);
  assert.equal(calculateHealthScore(healthInput({ uniqueMessageAuthors: 10, topMemberShare: 10 })).categories.distribution, 100);
  assert.equal(calculateHealthScore(healthInput({ uniqueMessageAuthors: 10, topMemberShare: 55 })).categories.distribution, 50);
  assert.equal(calculateHealthScore(healthInput({ uniqueMessageAuthors: 10, topMemberShare: 100 })).categories.distribution, 0);
});

test("confidence includes voice sessions, joins, and leaves", () => {
  const empty = calculateHealthScore(healthInput({ observationDays: 0, activeUsers: 0, activityUsers: 0, messages: 0, reactions: 0, voiceSessions: 0, joins: 0, leaves: 0 }));
  assert.equal(empty.inputs.totalObservedEvents, 0);
  assert.equal(empty.confidenceScore, 0);

  const voiceOnly = calculateHealthScore(healthInput({ observationDays: 0, activeUsers: 0, activityUsers: 1, messages: 0, reactions: 0, voiceSessions: 10, joins: 0, leaves: 0 }));
  assert.equal(voiceOnly.inputs.totalObservedEvents, 10);
  assert.ok(voiceOnly.confidenceScore > 0);

  const membershipOnly = calculateHealthScore(healthInput({ observationDays: 0, activeUsers: 0, activityUsers: 0, messages: 0, reactions: 0, voiceSessions: 0, joins: 6, leaves: 4 }));
  assert.equal(membershipOnly.inputs.totalObservedEvents, 10);
  assert.ok(membershipOnly.confidenceScore > 0);
});

test("health inputs safely reject non-finite values and zero denominators", () => {
  const result = calculateHealthScore(healthInput({
    memberCount: 0,
    activeUsers: 0,
    messages: Number.NaN,
    reactions: Number.POSITIVE_INFINITY,
    voiceUsers: Number.NaN,
    voiceSeconds: Number.POSITIVE_INFINITY,
    observationDays: 0,
  }));
  assert.equal(result.inputs.activeRate, null);
  assert.equal(result.inputs.messagesPerActivePerDay, null);
  assert.equal(result.inputs.voiceParticipation, null);
  assert.ok(Number.isFinite(result.inputs.totalObservedEvents));
  assert.ok(result.provisionalScore === null || Number.isFinite(result.provisionalScore));
});

test("Health Score v2 preserves legacy response fields while adding availability metadata", () => {
  const result = calculateHealthScore(healthInput());
  for (const key of ["score", "status", "confidence", "confidenceScore", "categories", "availableWeight", "inputs"]) {
    assert.ok(Object.hasOwn(result, key));
  }
  for (const key of ["isAvailable", "isProvisional", "availabilityReason", "availableCategoryCount", "provisionalScore"]) {
    assert.ok(Object.hasOwn(result, key));
  }
});

test("health status boundaries are stable", () => {
  assert.equal(scoreStatus(90), "excellent");
  assert.equal(scoreStatus(75), "healthy");
  assert.equal(scoreStatus(60), "fair");
  assert.equal(scoreStatus(40), "weak");
  assert.equal(scoreStatus(39), "critical");
  assert.equal(scoreStatus(null), "unavailable");
});

test("channel status respects minimum sample and inactivity", () => {
  assert.equal(channelStatus({ current: 0, previous: 20, uniqueUsers: 3 }), "inactive");
  assert.equal(channelStatus({ current: 3, previous: 1, uniqueUsers: 1 }), "limited_data");
  assert.equal(channelStatus({ current: 30, previous: 20, uniqueUsers: 5 }), "growing");
  assert.equal(channelStatus({ current: 10, previous: 20, uniqueUsers: 5 }), "declining");
});

test("insight rules suppress duplicate activity and channel observations", () => {
  const insights = buildInsights({
    messages: { current: 50, previous: 100 },
    retention: { current: 30, previous: 45, eligible: 20 },
    topChannel: { name: "general", share: 70, change: comparison(25, 80, { minimumSample: 5 }) },
    topMemberShare: 75,
    voice: { current: 1000, previous: 2000 },
  });
  assert.equal(insights.filter((item) => item.group === "activity").length, 1);
  assert.ok(insights.some((item) => item.category === "retention"));
  assert.ok(insights.every((item, index) => index === 0 || insights[index - 1].importance >= item.importance));
});

test("guild authorization rejects cross-guild and malformed IDs", () => {
  const guilds = [{ id: "123456789012345678" }];
  assert.equal(isAuthorizedGuild(guilds, "123456789012345678"), true);
  assert.equal(isAuthorizedGuild(guilds, "999999999999999999"), false);
  assert.equal(isAuthorizedGuild(guilds, "not-a-guild"), false);
});
