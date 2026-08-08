export const HEALTH_SCORE_WEIGHTS = Object.freeze({
  engagement: 25,
  retention: 25,
  distribution: 20,
  voice: 15,
  growth: 15,
});

export const HEALTH_SCORE_THRESHOLDS = Object.freeze({
  minimumObservationDays: 7,
  minimumConfidence: 40,
  minimumAvailableCategories: 3,
  minimumDistributionAuthors: 10,
  activeRateFullScore: 35,
  messagesPerActivePerDayFullScore: 2,
  reactionRateFullScore: 50,
  voiceParticipationFullScore: 25,
  // Two hours per 30 days preserves the previous 30-day Voice target while
  // making shorter and longer analysis periods comparable.
  voiceHoursPerVoiceUserPerDayFullScore: 2 / 30,
  growthNormalizationDays: 30,
  minimumGrowthObservationDays: 1,
  confidenceObservationDaysFullScore: 30,
  confidenceActiveUsersFullScore: 30,
  confidenceObservedEventsFullScore: 300,
});

export const ANALYTICS_THRESHOLDS = Object.freeze({
  minimumComparisonEvents: 10,
  significantPercentChange: 15,
  significantAbsoluteChange: 5,
  // Backward-compatible aliases for consumers that import the original
  // analytics threshold names.
  activeRateTarget: HEALTH_SCORE_THRESHOLDS.activeRateFullScore,
  messagesPerActiveTarget: HEALTH_SCORE_THRESHOLDS.messagesPerActivePerDayFullScore,
  reactionRateTarget: HEALTH_SCORE_THRESHOLDS.reactionRateFullScore,
  voiceParticipationTarget: HEALTH_SCORE_THRESHOLDS.voiceParticipationFullScore,
  voiceHoursPerActiveTarget: HEALTH_SCORE_THRESHOLDS.voiceHoursPerVoiceUserPerDayFullScore,
});

export function clamp(value, minimum = 0, maximum = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
}

export function round(value, digits = 1) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
}

export function safeRate(numerator, denominator, digits = 1) {
  if (!Number.isFinite(Number(numerator)) || !Number.isFinite(Number(denominator)) || Number(denominator) <= 0) {
    return null;
  }
  return round((Number(numerator) / Number(denominator)) * 100, digits);
}

export function comparison(current, previous, { minimumSample = 0 } = {}) {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;
  const absolute = currentValue - previousValue;
  const percent = previousValue === 0 ? null : round((absolute / previousValue) * 100, 1);
  const enoughSample = Math.max(Math.abs(currentValue), Math.abs(previousValue)) >= minimumSample;
  return {
    current: currentValue,
    previous: previousValue,
    absolute,
    percent,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
    enoughSample,
    significant:
      enoughSample &&
      Math.abs(absolute) >= ANALYTICS_THRESHOLDS.significantAbsoluteChange &&
      (percent === null || Math.abs(percent) >= ANALYTICS_THRESHOLDS.significantPercentChange),
  };
}

export function percentagePointChange(currentRate, previousRate) {
  if (currentRate === null || previousRate === null || currentRate === undefined || previousRate === undefined) return null;
  return round(Number(currentRate) - Number(previousRate), 1);
}

export function contribution(delta, totalDelta) {
  if (!Number.isFinite(Number(delta)) || !Number.isFinite(Number(totalDelta)) || Number(totalDelta) === 0) return null;
  return round((Math.abs(Number(delta)) / Math.abs(Number(totalDelta))) * 100, 1);
}

export function scoreStatus(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return "unavailable";
  if (score >= 90) return "excellent";
  if (score >= 75) return "healthy";
  if (score >= 60) return "fair";
  if (score >= 40) return "weak";
  return "critical";
}

export function calculateHealthScore(input) {
  const rawObservationDays = Number(input.observationDays);
  const observationDays = Number.isFinite(rawObservationDays) ? Math.max(0, rawObservationDays) : 0;
  const hasUsableDailyWindow = observationDays >= HEALTH_SCORE_THRESHOLDS.minimumGrowthObservationDays;
  const activeRate = safeRate(input.activeUsers, input.memberCount);
  const messagesPerActive = input.activeUsers > 0 ? input.messages / input.activeUsers : null;
  const messagesPerActivePerDay = messagesPerActive !== null && hasUsableDailyWindow
    ? messagesPerActive / observationDays
    : null;
  const reactionRate = safeRate(input.reactions, input.messages);
  const engagementParts = [
    activeRate === null ? null : clamp((activeRate / HEALTH_SCORE_THRESHOLDS.activeRateFullScore) * 100),
    messagesPerActivePerDay === null ? null : clamp((messagesPerActivePerDay / HEALTH_SCORE_THRESHOLDS.messagesPerActivePerDayFullScore) * 100),
    reactionRate === null ? null : clamp((reactionRate / HEALTH_SCORE_THRESHOLDS.reactionRateFullScore) * 100),
  ].filter((value) => value !== null);

  const retentionParts = [input.retention7, input.retention30]
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map((value) => clamp(Number(value)));
  const topShare = input.topMemberShare;
  const uniqueMessageAuthors = Number(input.uniqueMessageAuthors);
  const distribution = topShare === null || topShare === undefined || !Number.isFinite(Number(topShare))
      || !Number.isFinite(uniqueMessageAuthors)
      || uniqueMessageAuthors < HEALTH_SCORE_THRESHOLDS.minimumDistributionAuthors
    ? null
    : clamp(((100 - Number(topShare)) / 90) * 100);
  const hasVoiceData = input.voiceUsers !== null && input.voiceUsers !== undefined
    && input.voiceSeconds !== null && input.voiceSeconds !== undefined
    && Number.isFinite(Number(input.voiceUsers)) && Number.isFinite(Number(input.voiceSeconds));
  const voiceParticipation = hasVoiceData ? safeRate(input.voiceUsers, input.memberCount) : null;
  const voiceHoursPerVoiceUser = hasVoiceData && Number(input.voiceUsers) > 0
    ? Number(input.voiceSeconds) / 3600 / Number(input.voiceUsers)
    : null;
  const voiceHoursPerVoiceUserPerDay = voiceHoursPerVoiceUser !== null && hasUsableDailyWindow
    ? voiceHoursPerVoiceUser / observationDays
    : null;
  const voiceParts = [
    voiceParticipation === null ? null : clamp((voiceParticipation / HEALTH_SCORE_THRESHOLDS.voiceParticipationFullScore) * 100),
    voiceHoursPerVoiceUserPerDay === null ? null : clamp((voiceHoursPerVoiceUserPerDay / HEALTH_SCORE_THRESHOLDS.voiceHoursPerVoiceUserPerDayFullScore) * 100),
  ].filter((value) => value !== null);
  const hasGrowthData = Number.isFinite(Number(input.joins)) && Number.isFinite(Number(input.leaves))
    && Number(input.joins) + Number(input.leaves) > 0;
  const netGrowthRate = hasGrowthData && input.memberCount > 0 ? ((input.joins - input.leaves) / input.memberCount) * 100 : null;
  const normalized30DayGrowthRate = netGrowthRate !== null && hasUsableDailyWindow
    ? netGrowthRate * (HEALTH_SCORE_THRESHOLDS.growthNormalizationDays / observationDays)
    : null;
  const earlyLeaveRate = safeRate(input.earlyLeaves, input.joins);
  const growthParts = [
    normalized30DayGrowthRate === null ? null : clamp(50 + normalized30DayGrowthRate * 10),
    earlyLeaveRate === null ? null : clamp(100 - earlyLeaveRate * 2),
  ].filter((value) => value !== null);

  const average = (values) => values.length ? round(values.reduce((sum, value) => sum + Number(value), 0) / values.length, 1) : null;
  const categories = {
    engagement: average(engagementParts),
    retention: average(retentionParts),
    distribution,
    voice: average(voiceParts),
    growth: average(growthParts),
  };
  const available = Object.entries(categories).filter(([, value]) => value !== null);
  const availableWeight = available.reduce((sum, [key]) => sum + HEALTH_SCORE_WEIGHTS[key], 0);
  const provisionalScore = availableWeight
    ? round(available.reduce((sum, [key, value]) => sum + Number(value) * HEALTH_SCORE_WEIGHTS[key], 0) / availableWeight, 0)
    : null;

  const confidenceActiveUsers = Number.isFinite(Number(input.activityUsers))
    ? Math.max(0, Number(input.activityUsers))
    : Math.max(0, Number(input.activeUsers) || 0);
  const eventCount = [input.messages, input.reactions, input.voiceSessions, input.joins, input.leaves]
    .reduce((sum, value) => {
      const numeric = Number(value);
      return sum + (Number.isFinite(numeric) ? Math.max(0, numeric) : 0);
    }, 0);
  const confidencePoints =
    clamp((observationDays / HEALTH_SCORE_THRESHOLDS.confidenceObservationDaysFullScore) * 40, 0, 40) +
    clamp((confidenceActiveUsers / HEALTH_SCORE_THRESHOLDS.confidenceActiveUsersFullScore) * 30, 0, 30) +
    clamp((eventCount / HEALTH_SCORE_THRESHOLDS.confidenceObservedEventsFullScore) * 30, 0, 30);
  const confidenceScore = round(confidencePoints, 0);
  const confidence = confidencePoints >= 75 ? "high" : confidencePoints >= 40 ? "medium" : "low";
  const availabilityReasons = [];
  if (available.length < HEALTH_SCORE_THRESHOLDS.minimumAvailableCategories) availabilityReasons.push("insufficient_categories");
  if (Number(confidenceScore) < HEALTH_SCORE_THRESHOLDS.minimumConfidence) availabilityReasons.push("low_confidence");
  if (observationDays < HEALTH_SCORE_THRESHOLDS.minimumObservationDays) availabilityReasons.push("insufficient_observation_days");
  const isAvailable = provisionalScore !== null && availabilityReasons.length === 0;
  const score = isAvailable ? provisionalScore : null;

  return {
    score,
    status: scoreStatus(score),
    provisionalScore,
    provisionalStatus: scoreStatus(provisionalScore),
    isAvailable,
    isProvisional: provisionalScore !== null && !isAvailable,
    availabilityReason: availabilityReasons[0] ?? null,
    availabilityReasons,
    availableCategoryCount: available.length,
    confidence,
    confidenceScore,
    categories,
    availableWeight,
    inputs: {
      activeRate,
      messagesPerActive: round(messagesPerActive),
      messagesPerActivePerDay: round(messagesPerActivePerDay),
      reactionRate,
      voiceParticipation,
      voiceHoursPerVoiceUser: round(voiceHoursPerVoiceUser),
      voiceHoursPerVoiceUserPerDay: round(voiceHoursPerVoiceUserPerDay),
      netGrowthRate: round(netGrowthRate),
      normalized30DayGrowthRate: round(normalized30DayGrowthRate),
      earlyLeaveRate,
      confidenceActiveUsers,
      totalObservedEvents: eventCount,
    },
  };
}

export function channelStatus({ current, previous, uniqueUsers }) {
  const change = comparison(current, previous, { minimumSample: 5 });
  if (current === 0) return "inactive";
  if (!change.enoughSample || uniqueUsers < 2) return "limited_data";
  if (change.percent !== null && change.percent >= 20) return "growing";
  if (change.percent !== null && change.percent <= -20) return "declining";
  return "healthy";
}

export function buildInsights(input) {
  const candidates = [];
  const activity = comparison(input.messages.current, input.messages.previous, { minimumSample: 10 });
  if (activity.significant) {
    candidates.push({
      id: "activity-change",
      group: "activity",
      category: "activity",
      severity: activity.direction === "up" ? "positive" : "attention",
      importance: clamp(Math.abs(activity.percent ?? 0) + Math.min(input.messages.current, 100) / 5),
      titleKey: activity.direction === "up" ? "activity_increased" : "activity_decreased",
      values: { current: activity.current, previous: activity.previous, percent: activity.percent },
      recommendationKey: activity.direction === "down" ? "review_activity_drivers" : "review_successful_channels",
    });
  }

  const retentionDelta = percentagePointChange(input.retention.current, input.retention.previous);
  if (retentionDelta !== null && input.retention.eligible >= 5 && Math.abs(retentionDelta) >= 5) {
    candidates.push({
      id: "retention-change",
      group: "retention",
      category: "retention",
      severity: retentionDelta > 0 ? "positive" : "attention",
      importance: clamp(Math.abs(retentionDelta) * 2 + input.retention.eligible / 5),
      titleKey: retentionDelta > 0 ? "retention_increased" : "retention_decreased",
      values: { current: input.retention.current, previous: input.retention.previous, delta: retentionDelta, eligible: input.retention.eligible },
      recommendationKey: retentionDelta < 0 ? "review_onboarding" : "review_retained_behaviors",
    });
  }

  if (input.topChannel?.change?.significant) {
    candidates.push({
      id: "channel-change",
      group: activity.direction === input.topChannel.change.direction ? "activity" : "channel",
      category: "channel",
      severity: input.topChannel.change.direction === "up" ? "positive" : "attention",
      importance: clamp(Math.abs(input.topChannel.change.percent ?? 0) + (input.topChannel.share ?? 0) / 2),
      titleKey: input.topChannel.change.direction === "up" ? "channel_increased" : "channel_decreased",
      values: { ...input.topChannel },
      recommendationKey: "review_channel_context",
    });
  }

  if (input.topMemberShare !== null && input.topMemberShare >= 60 && input.messages.current >= 20) {
    candidates.push({
      id: "distribution-concentration",
      group: "distribution",
      category: "distribution",
      severity: input.topMemberShare >= 80 ? "critical" : "attention",
      importance: clamp(input.topMemberShare),
      titleKey: "activity_concentrated",
      values: { share: round(input.topMemberShare), messages: input.messages.current },
      recommendationKey: "broaden_participation",
    });
  }

  const voice = comparison(input.voice.current, input.voice.previous, { minimumSample: 300 });
  if (voice.significant) {
    candidates.push({
      id: "voice-change",
      group: "voice",
      category: "voice",
      severity: voice.direction === "up" ? "positive" : "attention",
      importance: clamp(Math.abs(voice.percent ?? 0)),
      titleKey: voice.direction === "up" ? "voice_increased" : "voice_decreased",
      values: { current: voice.current, previous: voice.previous, percent: voice.percent },
      recommendationKey: "review_voice_schedule",
    });
  }

  const deduplicated = new Map();
  for (const insight of candidates) {
    const existing = deduplicated.get(insight.group);
    if (!existing || insight.importance > existing.importance) deduplicated.set(insight.group, insight);
  }
  return [...deduplicated.values()].sort((left, right) => right.importance - left.importance).slice(0, 8);
}

export function isAuthorizedGuild(managedGuilds, guildId) {
  return typeof guildId === "string" && /^\d{16,22}$/.test(guildId) && managedGuilds.some((guild) => guild.id === guildId);
}
