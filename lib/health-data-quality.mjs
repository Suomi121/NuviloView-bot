function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function category({ qualityState, reason, observationDays, confidence, usable = true }) {
  return {
    score: null,
    confidence,
    observationDays: Math.max(0, finite(observationDays)),
    qualityState,
    reason,
    usable,
  };
}

function confidenceForSample(sample, medium, high) {
  if (sample >= high) return "high";
  if (sample >= medium) return "medium";
  if (sample > 0) return "low";
  return "none";
}

export function createHealthDataQualityGate(input) {
  const observationDays = Math.max(0, finite(input.observationDays));
  const messageSourcesAvailable = input.messageSources?.available === true;
  const messageLive = Math.max(0, finite(input.messageSources?.live));
  const messageHistoryImport = Math.max(0, finite(input.messageSources?.historyImport));
  const messageExisting = Math.max(0, finite(input.messageSources?.existing));
  const messageUnknown = Math.max(0, finite(input.messageSources?.unknown));
  const messageSourceTotal = messageLive + messageHistoryImport + messageExisting + messageUnknown;
  const retentionLive = finite(input.retention?.sources?.discordLive);
  const retentionSync = finite(input.retention?.sources?.discordSync);
  const retentionHistorical = finite(input.retention?.sources?.historicalImport);
  const retentionUnknown = finite(input.retention?.sources?.unknown);
  const retentionEligible = finite(input.retention?.eligible7);
  const retentionExcluded = retentionSync + retentionHistorical + retentionUnknown;

  let retention;
  if (retentionLive === 0 && retentionExcluded > 0) {
    retention = category({
      qualityState: "Unavailable",
      reason: "sync_or_unverified_join_sources_only",
      observationDays,
      confidence: "none",
      usable: false,
    });
  } else if (retentionEligible === 0) {
    retention = category({
      qualityState: observationDays < 7 ? "Immature" : "Unavailable",
      reason: observationDays < 7 ? "retention_window_immature" : "no_eligible_live_join_cohort",
      observationDays,
      confidence: "none",
      usable: false,
    });
  } else if (retentionEligible < 5) {
    retention = category({
      qualityState: "LowConfidence",
      reason: "small_live_join_cohort",
      observationDays,
      confidence: "low",
    });
  } else {
    retention = category({
      qualityState: "Available",
      reason: retentionExcluded > 0 ? "unverified_sources_excluded" : "live_join_sources_only",
      observationDays,
      confidence: confidenceForSample(retentionEligible, 5, 30),
    });
  }

  const validVoiceSessions = finite(input.voice?.validSessions);
  const voiceAnomalies = Object.values(input.voice?.anomalies || {}).reduce(
    (sum, value) => sum + Math.max(0, finite(value)),
    0,
  );
  const voiceTotal = validVoiceSessions + voiceAnomalies;
  const voiceAnomalyRate = voiceTotal > 0 ? voiceAnomalies / voiceTotal : 0;
  let voice;
  if (!input.voice?.trackingSince) {
    voice = category({ qualityState: "Unavailable", reason: "voice_not_observed", observationDays: 0, confidence: "none", usable: false });
  } else if (validVoiceSessions === 0 && voiceAnomalies > 0) {
    voice = category({ qualityState: "Unavailable", reason: "voice_sessions_all_invalid", observationDays: input.voice.observationDays, confidence: "none", usable: false });
  } else if (observationDays < 7) {
    voice = category({ qualityState: "Immature", reason: "voice_window_immature", observationDays: input.voice.observationDays, confidence: "low", usable: false });
  } else if (voiceAnomalies > 0) {
    voice = category({ qualityState: "LowConfidence", reason: "voice_outliers_excluded", observationDays: input.voice.observationDays, confidence: confidenceForSample(validVoiceSessions, 5, 30) });
  } else if (validVoiceSessions < 5) {
    voice = category({ qualityState: "LowConfidence", reason: "small_voice_sample", observationDays: input.voice.observationDays, confidence: confidenceForSample(validVoiceSessions, 5, 30) });
  } else {
    voice = category({ qualityState: "Available", reason: "voice_sessions_valid", observationDays: input.voice.observationDays, confidence: confidenceForSample(validVoiceSessions, 5, 30) });
  }

  const reactionObservationDays = Math.max(0, finite(input.reaction?.observationDays));
  const reactionEvents = Math.max(0, finite(input.reaction?.events));
  let reaction;
  if (!input.reaction?.trackingSince) {
    reaction = category({ qualityState: "Unavailable", reason: "reaction_not_observed", observationDays: 0, confidence: "none", usable: false });
  } else if (reactionObservationDays < 14) {
    reaction = category({ qualityState: "Immature", reason: "reaction_collection_immature", observationDays: reactionObservationDays, confidence: "low", usable: false });
  } else if (reactionEvents < 10 || reactionObservationDays < 30) {
    reaction = category({ qualityState: "LowConfidence", reason: reactionEvents < 10 ? "small_reaction_sample" : "reaction_collection_recent", observationDays: reactionObservationDays, confidence: confidenceForSample(reactionEvents, 10, 100) });
  } else {
    reaction = category({ qualityState: "Available", reason: "reaction_collection_mature", observationDays: reactionObservationDays, confidence: confidenceForSample(reactionEvents, 10, 100) });
  }

  const messages = Math.max(0, finite(input.messages));
  const activeUsers = Math.max(0, finite(input.activeUsers));
  const engagement = category({
    qualityState: observationDays < 7 ? "Immature" : messages === 0 ? "LowConfidence" : "Available",
    reason: observationDays < 7 ? "engagement_window_immature" : messages === 0 ? "no_message_activity" : "message_activity_observed",
    observationDays,
    confidence: confidenceForSample(messages + activeUsers, 10, 300),
  });
  const uniqueAuthors = Math.max(0, finite(input.uniqueAuthors));
  const distribution = category({
    qualityState: uniqueAuthors >= 10 ? "Available" : "LowConfidence",
    reason: uniqueAuthors >= 10 ? "author_sample_sufficient" : "insufficient_unique_authors",
    observationDays,
    confidence: confidenceForSample(uniqueAuthors, 10, 30),
    usable: uniqueAuthors >= 10,
  });
  const membershipEvents = Math.max(0, finite(input.joins)) + Math.max(0, finite(input.leaves));
  const growth = category({
    qualityState: membershipEvents === 0 ? "Unavailable" : membershipEvents < 5 ? "LowConfidence" : "Available",
    reason: membershipEvents === 0 ? "no_membership_events" : membershipEvents < 5 ? "small_membership_sample" : "membership_sample_sufficient",
    observationDays,
    confidence: confidenceForSample(membershipEvents, 5, 30),
    usable: membershipEvents > 0,
  });

  const blockingReasons = [];
  if (retentionLive === 0 && retentionExcluded > 0) blockingReasons.push("retention_unverified_sources_only");
  if (voiceAnomalyRate >= 0.2 && voiceAnomalies >= 2) blockingReasons.push("voice_outlier_rate_high");

  return {
    schemaVersion: 1,
    passes: blockingReasons.length === 0,
    blockingReasons,
    sanitization: {
      retentionUsable: retention.usable,
      voiceUsable: voice.usable,
      reactionUsable: reaction.usable,
    },
    categories: { engagement, retention, distribution, voice, growth },
    components: { reaction },
    evidence: {
      messageSources: {
        available: messageSourcesAvailable,
        live: messageLive,
        historyImport: messageHistoryImport,
        existing: messageExisting,
        unknown: messageUnknown,
        total: messageSourceTotal,
        historyImportShare: messageSourceTotal > 0
          ? Math.round((messageHistoryImport / messageSourceTotal) * 1_000) / 1_000
          : 0,
      },
      retentionSources: {
        discordLive: retentionLive,
        discordSync: retentionSync,
        historicalImport: retentionHistorical,
        unknown: retentionUnknown,
      },
      voice: {
        validSessions: validVoiceSessions,
        invalidSessions: voiceAnomalies,
        anomalyRate: Math.round(voiceAnomalyRate * 1_000) / 1_000,
        anomalies: input.voice?.anomalies || {},
      },
      reaction: { events: reactionEvents, observationDays: reactionObservationDays },
    },
  };
}

export function attachHealthScoresToQualityGate(gate, health) {
  const categories = Object.fromEntries(
    Object.entries(gate.categories).map(([key, value]) => [key, { ...value, score: health.categories[key] ?? null }]),
  );
  return {
    ...gate,
    categories,
    components: {
      ...gate.components,
      reaction: {
        ...gate.components.reaction,
        score: health.inputs.reactionRate,
      },
    },
  };
}
