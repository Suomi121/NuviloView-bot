import {
  buildInsights,
  calculateHealthScore,
  channelStatus,
  comparison,
  contribution,
  percentagePointChange,
  safeRate,
} from "./community-analytics-utils.mjs";
import {
  formatInsightPresentation,
  resolveChannelDisplayName,
  type ChannelEntityMetadata,
} from "./insight-presentation.mjs";

type ProjectionSnapshot = {
  aggregateId: string;
  snapshotVersion: number;
  payload: Record<string, unknown>;
  checksum: string;
  generatedAt: number;
  syncedAt: number;
};

export type ProjectionReadMetadata = {
  provider: string | null;
  snapshotVersion: number | null;
  checksum: string | null;
  lastUpdatedAt: number | null;
  observedAt: number | null;
  observationSource: "sync_status" | null;
  nextUpdateAt: number | null;
  freshness: "fresh" | "stale" | "very_stale" | "unavailable";
  degraded: boolean;
  lastKnownGood?: boolean;
  truncated?: boolean;
};

export type ProjectionBundle = {
  available: boolean;
  current: ProjectionSnapshot | null;
  snapshots: readonly ProjectionSnapshot[];
  metadata: ProjectionReadMetadata;
};

export type ProjectionAnalyticsRange = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  days: number;
  timeZone: string;
  roleId: string | null;
  channelId: string | null;
  excludeBots: boolean;
};

type Payload = Record<string, any>;

type ProjectionPresentationOptions = {
  locale?: "ja" | "en";
  channelNames?: Readonly<Record<string, ChannelEntityMetadata>> | null;
};

const number = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const rate = (numerator: unknown, denominator: unknown) =>
  safeRate(number(numerator), number(denominator));

const addDays = (date: string, amount: number) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
};

const datesBetween = (start: string, end: string) => {
  const result: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) result.push(date);
  return result;
};

const inRange = (date: unknown, start: string, end: string) =>
  typeof date === "string" && date >= start && date <= end;

const snapshotPayloads = (bundle: ProjectionBundle) =>
  bundle.snapshots.map((snapshot) => ({
    ...snapshot.payload,
    __aggregateId: snapshot.aggregateId,
    __generatedAt: snapshot.generatedAt,
  })) as Payload[];

function projectionRows(
  rows: Payload[],
  projection: string,
  startDate: string,
  endDate: string,
) {
  return rows.filter(
    (row) => row.projection === projection && inRange(row.dateUtc, startDate, endDate),
  );
}

function activity(row: Payload | undefined) {
  return Boolean(
    row
    && (number(row.messageCount) > 0
      || number(row.reactionCount) > 0
      || number(row.voiceSeconds) > 0),
  );
}

function sumRows(rows: Payload[]) {
  return rows.reduce(
    (total, row) => ({
      messages: total.messages + number(row.messageCount),
      reactions: total.reactions + number(row.reactionCount),
      voiceSeconds: total.voiceSeconds + number(row.voiceSeconds),
      voiceSessions: total.voiceSessions + number(row.voiceSessions),
      joins: total.joins + number(row.joins),
      leaves: total.leaves + number(row.leaves),
      activeMembers: Math.max(total.activeMembers, number(row.activeMembers)),
      voiceUsers: Math.max(total.voiceUsers, number(row.uniqueVoiceMembers)),
      peakConcurrent: Math.max(total.peakConcurrent, number(row.peakConcurrent)),
    }),
    {
      messages: 0,
      reactions: 0,
      voiceSeconds: 0,
      voiceSessions: 0,
      joins: 0,
      leaves: 0,
      activeMembers: 0,
      voiceUsers: 0,
      peakConcurrent: 0,
    },
  );
}

function userRowsById(rows: Payload[]) {
  const map = new Map<string, Map<string, Payload>>();
  for (const row of rows.filter((item) => item.projection === "user_daily")) {
    if (!row.userId || !row.dateUtc) continue;
    const dates = map.get(String(row.userId)) ?? new Map<string, Payload>();
    dates.set(String(row.dateUtc), row);
    map.set(String(row.userId), dates);
  }
  return map;
}

function projectionRetention(
  rows: Payload[],
  startDate: string,
  endDate: string,
) {
  const users = userRowsById(rows);
  const joined: Array<{ userId: string; date: string; dates: Map<string, Payload> }> = [];
  for (const [userId, dates] of users) {
    for (const [date, row] of dates) {
      if (inRange(date, startDate, endDate) && number(row.joins) > 0) {
        joined.push({ userId, date, dates });
      }
    }
  }
  const milestone = (days: number) => {
    const eligible = joined.filter((item) => addDays(item.date, days) <= endDate);
    const retained = eligible.filter((item) => activity(item.dates.get(addDays(item.date, days))));
    return { eligible: eligible.length, retained: retained.length, rate: rate(retained.length, eligible.length) };
  };
  const hasWithin = (item: (typeof joined)[number], key: string, days: number) =>
    Array.from({ length: days }, (_, index) => item.dates.get(addDays(item.date, index)))
      .some((row) => number(row?.[key]) > 0);
  const firstMessage24 = joined.filter((item) => hasWithin(item, "messageCount", 1)).length;
  const firstMessage7 = joined.filter((item) => hasWithin(item, "messageCount", 7)).length;
  const firstVoice24 = joined.filter((item) => hasWithin(item, "voiceSeconds", 1)).length;
  const firstVoice7 = joined.filter((item) => hasWithin(item, "voiceSeconds", 7)).length;
  const reacted = joined.filter((item) => hasWithin(item, "reactionCount", 31)).length;
  const departures = (days: number) => joined.filter((item) =>
    Array.from({ length: days }, (_, index) => item.dates.get(addDays(item.date, index)))
      .some((row) => number(row?.leaves) > 0),
  ).length;
  const retention7 = milestone(7);
  const retention30 = milestone(30);
  const behavior = [
    ["message", "messageCount"],
    ["voice", "voiceSeconds"],
    ["reaction", "reactionCount"],
  ].map(([key, field]) => {
    const eligible = joined.filter((item) => addDays(item.date, 7) <= endDate);
    const withActivity = eligible.filter((item) => hasWithin(item, field, 7));
    const withoutActivity = eligible.filter((item) => !hasWithin(item, field, 7));
    const retained = (items: typeof eligible) => items.filter((item) =>
      activity(item.dates.get(addDays(item.date, 7))),
    ).length;
    return {
      key,
      withRate: rate(retained(withActivity), withActivity.length),
      withoutRate: rate(retained(withoutActivity), withoutActivity.length),
      withSample: withActivity.length,
      withoutSample: withoutActivity.length,
    };
  });
  return {
    joined: joined.length,
    sourceQuality: {
      discordLive: joined.length,
      discordSync: 0,
      historicalImport: 0,
      unknown: 0,
    },
    retention7,
    retention30,
    firstMessage: {
      within1Hour: null,
      within24Hours: firstMessage24,
      within7Days: firstMessage7,
      never: joined.length - firstMessage7,
      rate: rate(firstMessage7, joined.length),
    },
    firstVoice: {
      within24Hours: firstVoice24,
      within7Days: firstVoice7,
      never: joined.length - firstVoice7,
      averageSeconds: null,
      rate: rate(firstVoice7, joined.length),
    },
    reactions: {
      made: reacted,
      received: null,
      any: reacted,
      rate: rate(reacted, joined.length),
    },
    departures: {
      within24Hours: departures(1),
      within3Days: departures(3),
      within7Days: departures(7),
      within30Days: departures(30),
      averageTenureSeconds: null,
    },
    behavior,
    joinedRows: joined,
  };
}

function weeklyCohorts(retention: ReturnType<typeof projectionRetention>, endDate: string) {
  const cohorts = new Map<string, typeof retention.joinedRows>();
  for (const item of retention.joinedRows) {
    const date = new Date(`${item.date}T00:00:00.000Z`);
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - day + 1);
    const key = date.toISOString().slice(0, 10);
    const list = cohorts.get(key) ?? [];
    list.push(item);
    cohorts.set(key, list);
  }
  const cell = (items: typeof retention.joinedRows, days: number) => {
    const eligible = items.filter((item) => addDays(item.date, days) <= endDate);
    const retained = eligible.filter((item) => activity(item.dates.get(addDays(item.date, days))));
    return { eligible: eligible.length, retained: retained.length, rate: rate(retained.length, eligible.length) };
  };
  return [...cohorts.entries()].sort().map(([cohort, items]) => ({
    cohort,
    joined: items.length,
    day1: cell(items, 1),
    day7: cell(items, 7),
    day30: cell(items, 30),
  }));
}

function topMemberShare(rows: Payload[], startDate: string, endDate: string) {
  const counts = projectionRows(rows, "user_daily", startDate, endDate)
    .reduce((map, row) => {
      map.set(String(row.userId), (map.get(String(row.userId)) ?? 0) + number(row.messageCount));
      return map;
    }, new Map<string, number>());
  const values = [...counts.values()].filter((value) => value > 0).sort((a, b) => b - a);
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const top = values.slice(0, Math.max(1, Math.ceil(values.length * 0.1)));
  return Math.round((top.reduce((sum, value) => sum + value, 0) / total) * 1_000) / 10;
}

function makeChannels(
  rows: Payload[],
  range: ProjectionAnalyticsRange,
  options: ProjectionPresentationOptions,
) {
  const channelRows = rows.filter((row) => row.projection === "channel_daily" && row.channelId);
  const grouped = new Map<string, Payload[]>();
  for (const row of channelRows) {
    const list = grouped.get(String(row.channelId)) ?? [];
    list.push(row);
    grouped.set(String(row.channelId), list);
  }
  return [...grouped.entries()].map(([channelId, list]) => {
    const projectedName = list
      .map((row) => row.channelName ?? row.channel_name)
      .find((value) => typeof value === "string" && value !== channelId);
    const resolvedMetadata = options.channelNames?.[channelId];
    const current = sumRows(list.filter((row) => inRange(row.dateUtc, range.startDate, range.endDate)));
    const previous = sumRows(list.filter((row) => inRange(row.dateUtc, range.previousStartDate, range.previousEndDate)));
    const change = comparison(current.messages || current.voiceSeconds, previous.messages || previous.voiceSeconds, {
      minimumSample: current.messages ? 5 : 300,
    });
    return {
      channelId,
      name: resolveChannelDisplayName({
        channelId,
        projectedName,
        channelNames: options.channelNames,
        locale: options.locale,
      }),
      type: "unknown",
      deleted: typeof resolvedMetadata === "object" && resolvedMetadata !== null
        ? Boolean(resolvedMetadata.deleted)
        : !projectedName && !resolvedMetadata,
      messages: current.messages,
      previousMessages: previous.messages,
      uniqueAuthors: current.activeMembers,
      reactions: current.reactions,
      voiceUsers: current.voiceUsers,
      voiceSeconds: current.voiceSeconds,
      previousVoiceSeconds: previous.voiceSeconds,
      voiceSessions: current.voiceSessions,
      peakConcurrentUsers: current.peakConcurrent,
      reactionRate: rate(current.reactions, current.messages),
      messagesPerActiveUser: current.activeMembers
        ? Math.round((current.messages / current.activeMembers) * 10) / 10
        : null,
      share: null as number | null,
      trendPercent: change.percent,
      status: channelStatus({
        current: current.messages || current.voiceSeconds,
        previous: previous.messages || previous.voiceSeconds,
        uniqueUsers: current.activeMembers || current.voiceUsers,
      }),
      averageVoiceSessionSeconds: current.voiceSessions
        ? Math.round(current.voiceSeconds / current.voiceSessions)
        : null,
    };
  }).filter((item) => !range.channelId || item.channelId === range.channelId)
    .sort((left, right) => (right.messages + right.voiceSeconds / 60) - (left.messages + left.voiceSeconds / 60))
    .map((item, _index, all) => ({
      ...item,
      share: rate(item.messages, all.reduce((sum, row) => sum + row.messages, 0)),
    }));
}

function diagnostics(core: any, retention: any, previousRetention: any, channels: any[], rows: Payload[]) {
  const totalDelta = core.messages - core.previousMessages;
  const decorate = (current: number, previous: number) => {
    const change = comparison(current, previous, { minimumSample: 5 });
    return {
      current,
      previous,
      delta: change.absolute,
      percent: change.percent,
      contribution: contribution(change.absolute, totalDelta),
      significant: change.significant,
    };
  };
  const userCurrent = projectionRows(rows, "user_daily", core.range.startDate, core.range.endDate);
  const userPrevious = projectionRows(rows, "user_daily", core.range.previousStartDate, core.range.previousEndDate);
  const userCounts = (items: Payload[]) => items.reduce((map, row) => {
    map.set(String(row.userId), (map.get(String(row.userId)) ?? 0) + number(row.messageCount));
    return map;
  }, new Map<string, number>());
  const currentUsers = userCounts(userCurrent);
  const previousUsers = userCounts(userPrevious);
  const ids = new Set([...currentUsers.keys(), ...previousUsers.keys()]);
  return {
    metrics: [
      { key: "messages", ...comparison(core.messages, core.previousMessages, { minimumSample: 10 }) },
      { key: "active_members", ...comparison(core.activeUsers, core.previousActiveUsers, { minimumSample: 3 }) },
      {
        key: "reaction_rate",
        current: rate(core.reactions, core.messages),
        previous: rate(core.previousReactions, core.previousMessages),
        absolute: percentagePointChange(rate(core.reactions, core.messages), rate(core.previousReactions, core.previousMessages)),
        percent: null,
      },
      { key: "voice_activity", ...comparison(core.voiceSeconds, core.previousVoiceSeconds, { minimumSample: 300 }) },
      { key: "new_members", ...comparison(core.joins, core.previousJoins, { minimumSample: 3 }) },
      { key: "leave_count", ...comparison(core.leaves, core.previousLeaves, { minimumSample: 3 }) },
      {
        key: "retention",
        current: retention.retention7.rate,
        previous: previousRetention.retention7.rate,
        absolute: percentagePointChange(retention.retention7.rate, previousRetention.retention7.rate),
        percent: null,
      },
    ],
    channels: channels.map((item) => ({
      id: item.channelId,
      label: `#${item.name}`,
      ...decorate(item.messages, item.previousMessages),
    })).slice(0, 10),
    roles: [],
    times: [],
    members: [...ids].map((id) => ({
      id,
      label: `User …${id.slice(-6)}`,
      ...decorate(currentUsers.get(id) ?? 0, previousUsers.get(id) ?? 0),
    })).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta)).slice(0, 10),
    lifecycle: [],
  };
}

function coreMetrics(rows: Payload[], range: ProjectionAnalyticsRange, currentPayload: Payload) {
  const projection = range.channelId ? "channel_daily" : "guild_daily";
  const all = projectionRows(rows, projection, range.previousStartDate, range.endDate)
    .filter((row) => !range.channelId || String(row.channelId) === range.channelId);
  const currentRows = all.filter((row) => inRange(row.dateUtc, range.startDate, range.endDate));
  const previousRows = all.filter((row) => inRange(row.dateUtc, range.previousStartDate, range.previousEndDate));
  const current = sumRows(currentRows);
  const previous = sumRows(previousRows);
  const currentUsers = new Set(
    projectionRows(rows, "user_daily", range.startDate, range.endDate)
      .filter(activity)
      .map((row) => String(row.userId)),
  );
  const previousUsers = new Set(
    projectionRows(rows, "user_daily", range.previousStartDate, range.previousEndDate)
      .filter(activity)
      .map((row) => String(row.userId)),
  );
  return {
    range,
    rows: currentRows,
    messages: current.messages,
    previousMessages: previous.messages,
    activeUsers: range.channelId ? current.activeMembers : currentUsers.size,
    previousActiveUsers: range.channelId ? previous.activeMembers : previousUsers.size,
    activityUsers: range.channelId ? current.activeMembers : currentUsers.size,
    previousActivityUsers: range.channelId ? previous.activeMembers : previousUsers.size,
    reactions: current.reactions,
    previousReactions: previous.reactions,
    voiceUsers: current.voiceUsers,
    previousVoiceUsers: previous.voiceUsers,
    voiceSeconds: current.voiceSeconds,
    previousVoiceSeconds: previous.voiceSeconds,
    voiceSessions: current.voiceSessions,
    previousVoiceSessions: previous.voiceSessions,
    joins: current.joins,
    previousJoins: previous.joins,
    leaves: current.leaves,
    previousLeaves: previous.leaves,
    memberCount: number(currentPayload.currentMemberCount ?? currentPayload.members?.currentCount),
    previousMemberCount: previousRows.at(-1)
      ? number(previousRows.at(-1)?.currentMemberCount ?? previousRows.at(-1)?.members?.currentCount)
      : 0,
  };
}

export function buildProjectionCommunityAnalytics(
  bundle: ProjectionBundle,
  range: ProjectionAnalyticsRange,
  options: ProjectionPresentationOptions = {},
) {
  const presentation = {
    locale: options.locale === "en" ? "en" as const : "ja" as const,
    channelNames: options.channelNames ?? null,
  };
  const rows = snapshotPayloads(bundle);
  const currentPayload = (bundle.current?.payload ?? {}) as Payload;
  const core = coreMetrics(rows, range, currentPayload);
  const retention = projectionRetention(rows, range.startDate, range.endDate);
  const previousRetention = projectionRetention(rows, range.previousStartDate, range.previousEndDate);
  const currentTopShare = topMemberShare(rows, range.startDate, range.endDate);
  const previousTopShare = topMemberShare(rows, range.previousStartDate, range.previousEndDate);
  const channels = makeChannels(rows, range, presentation);
  const currentHealth = calculateHealthScore({
    memberCount: core.memberCount,
    activeUsers: core.activeUsers,
    activityUsers: core.activityUsers,
    messages: core.messages,
    reactions: core.reactions,
    reactionAvailable: true,
    retention7: retention.retention7.rate,
    retention30: retention.retention30.rate,
    topMemberShare: currentTopShare,
    uniqueMessageAuthors: core.activeUsers,
    voiceUsers: core.voiceUsers,
    voiceSeconds: core.voiceSeconds,
    voiceSessions: core.voiceSessions,
    joins: core.joins,
    leaves: core.leaves,
    earlyLeaves: retention.departures.within7Days,
    observationDays: core.rows.length,
  });
  const previousHealth = calculateHealthScore({
    memberCount: core.previousMemberCount || core.memberCount,
    activeUsers: core.previousActiveUsers,
    activityUsers: core.previousActivityUsers,
    messages: core.previousMessages,
    reactions: core.previousReactions,
    reactionAvailable: true,
    retention7: previousRetention.retention7.rate,
    retention30: previousRetention.retention30.rate,
    topMemberShare: previousTopShare,
    uniqueMessageAuthors: core.previousActiveUsers,
    voiceUsers: core.previousVoiceUsers,
    voiceSeconds: core.previousVoiceSeconds,
    voiceSessions: core.previousVoiceSessions,
    joins: core.previousJoins,
    leaves: core.previousLeaves,
    earlyLeaves: previousRetention.departures.within7Days,
    observationDays: projectionRows(rows, "guild_daily", range.previousStartDate, range.previousEndDate).length,
  });
  const topChannel = channels.find((channel) => channel.messages > 0) ?? null;
  const insights = buildInsights({
    messages: { current: core.messages, previous: core.previousMessages },
    retention: {
      current: retention.retention7.rate,
      previous: previousRetention.retention7.rate,
      eligible: retention.retention7.eligible,
    },
    topChannel: topChannel
      ? {
          id: topChannel.channelId,
          name: topChannel.name,
          share: topChannel.share,
          change: comparison(topChannel.messages, topChannel.previousMessages, { minimumSample: 5 }),
        }
      : null,
    topMemberShare: currentTopShare,
    voice: { current: core.voiceSeconds, previous: core.previousVoiceSeconds },
  });
  const limitations = [
    ...(bundle.metadata.truncated ? ["projection_row_limit_reached"] : []),
    ...(range.excludeBots ? ["bot_filter_not_projected"] : []),
    ...(range.roleId ? ["role_filter_not_projected"] : []),
    "hourly_heatmap_not_projected",
    "event_time_role_breakdown_not_projected",
    "subday_onboarding_not_projected",
    ...(channels.some((channel) => channel.name.startsWith(
      presentation.locale === "en" ? "Unknown channel" : "不明なチャンネル",
    )) ? ["channel_names_partially_resolved"] : []),
  ];
  const health = {
    ...currentHealth,
    release: { stage: "preview", mode: "shadow", official: false },
    previousScore: previousHealth.score,
    change: currentHealth.score == null || previousHealth.score == null
      ? null
      : currentHealth.score - previousHealth.score,
    history: [],
  };
  return {
    range,
    readMeta: {
      available: bundle.available,
      ...bundle.metadata,
      limitations,
      projectionRows: rows.length + Number(Boolean(bundle.current)),
      rawAnalyticsQueries: 0,
    },
    coverage: {
      observationDays: core.rows.length,
      memberTrackingSince: rows.filter((row) => row.projection === "guild_daily" && number(row.joins) > 0)
        .map((row) => row.dateUtc).sort()[0] ?? null,
      voiceTrackingSince: rows.filter((row) => row.projection === "guild_daily" && number(row.voiceSessions) > 0)
        .map((row) => row.dateUtc).sort()[0] ?? null,
      reactionTrackingSince: rows.filter((row) => row.projection === "guild_daily" && number(row.reactionCount) > 0)
        .map((row) => row.dateUtc).sort()[0] ?? null,
      storedMessages: number(currentPayload.messageCount),
      messagesWithChannelId: channels.reduce((sum, item) => sum + item.messages, 0),
      messagesWithRoles: 0,
      retentionAvailable: retention.joined > 0,
      roleHistoryMode: "not_projected",
      messageSources: { available: false, live: 0, historyImport: 0, existing: 0, unknown: 0, total: 0, historyImportShare: 0 },
    },
    retention: {
      ...retention,
      previous: previousRetention,
      funnel: [
        { key: "joined", count: retention.joined, rate: retention.joined ? 100 : null },
        { key: "first_message", count: retention.firstMessage.within7Days, rate: retention.firstMessage.rate },
        { key: "reaction", count: retention.reactions.any, rate: retention.reactions.rate },
        { key: "voice", count: retention.firstVoice.within7Days, rate: retention.firstVoice.rate },
        { key: "day7", count: retention.retention7.retained, rate: retention.retention7.rate, eligible: retention.retention7.eligible },
        { key: "day30", count: retention.retention30.retained, rate: retention.retention30.rate, eligible: retention.retention30.eligible },
      ],
      cohorts: weeklyCohorts(retention, range.endDate),
    },
    health,
    diagnostics: diagnostics(core, retention, previousRetention, channels, rows),
    insights,
    channels,
    roles: [],
    channelDetail: { channelId: range.channelId ?? topChannel?.channelId ?? null, heatmap: [] },
  };
}

export function buildProjectionDashboardStatus(
  bundle: ProjectionBundle,
  range: ProjectionAnalyticsRange,
  english = false,
  options: Omit<ProjectionPresentationOptions, "locale"> = {},
) {
  const locale = english ? "en" as const : "ja" as const;
  const analytics = buildProjectionCommunityAnalytics(bundle, range, {
    ...options,
    locale,
  });
  const rows = snapshotPayloads(bundle);
  const dates = datesBetween(range.startDate, range.endDate);
  const daily = new Map(
    projectionRows(rows, "guild_daily", range.startDate, range.endDate)
      .map((row) => [String(row.dateUtc), row]),
  );
  const previousDailyRows = projectionRows(
    rows,
    "guild_daily",
    range.previousStartDate,
    range.previousEndDate,
  ).sort((left, right) => String(left.dateUtc).localeCompare(String(right.dateUtc)));
  const previousLast = previousDailyRows.at(-1);
  const labels = dates.map((date) => date.slice(5).replace("-", "/"));
  const chartPoints = dates.map((date) => number(daily.get(date)?.messageCount));
  const memberPoints = dates.map((date) => number(daily.get(date)?.currentMemberCount ?? daily.get(date)?.members?.currentCount));
  const activeMemberPoints = dates.map((date) => number(daily.get(date)?.activeMembers));
  const reactionPoints = dates.map((date) => {
    const row = daily.get(date);
    return number(row?.messageCount) > 0
      ? Math.round((number(row?.reactionCount) / number(row?.messageCount)) * 1_000) / 10
      : 0;
  });
  const currentPayload = (bundle.current?.payload ?? {}) as Payload;
  const health = analytics.health;
  const presentedInsights = analytics.insights.map((insight: any) => ({
    insight,
    copy: formatInsightPresentation(insight, {
      locale,
      channelNames: options.channelNames,
    }),
  }));
  // The leading insight is already rendered as the hero. Cards intentionally
  // start at the next item so the same observation is not shown twice.
  const insightCards = presentedInsights.slice(1, 4).map(({ insight, copy }: any) => ({
    kind: insight.category === "channel"
      ? "channel"
      : insight.category === "voice" || insight.category === "activity"
        ? "engagement"
        : "members",
    title: copy.title,
    body: copy.detail,
  }));
  return {
    labels,
    chartPoints,
    memberPoints,
    activeMemberPoints,
    reactionPoints,
    latestMemberCount: number(currentPayload.currentMemberCount ?? currentPayload.members?.currentCount),
    latestMessageCount: chartPoints.at(-1) ?? 0,
    totalMessageCount: number(currentPayload.messageCount),
    activeMemberCount: activeMemberPoints.at(-1) ?? 0,
    previousMemberCount: number(previousLast?.currentMemberCount ?? previousLast?.members?.currentCount),
    previousActiveMemberCount: analytics.diagnostics.metrics.find((item: any) => item.key === "active_members")?.previous ?? 0,
    periodMessageCount: chartPoints.reduce((sum, value) => sum + value, 0),
    periodReactionRate: rate(
      dates.reduce((sum, date) => sum + number(daily.get(date)?.reactionCount), 0),
      chartPoints.reduce((sum, value) => sum + value, 0),
    ) ?? 0,
    previousMessageCount: analytics.diagnostics.metrics.find((item: any) => item.key === "messages")?.previous ?? 0,
    previousReactionRate: analytics.diagnostics.metrics.find((item: any) => item.key === "reaction_rate")?.previous ?? 0,
    previousMaxVoiceSessionSeconds: 0,
    reactionRate: reactionPoints.at(-1) ?? 0,
    voiceTotalSeconds: dates.reduce((sum, date) => sum + number(daily.get(date)?.voiceSeconds), 0),
    maxVoiceSessionSeconds: 0,
    health,
    insight: presentedInsights[0]
      ? { title: presentedInsights[0].copy.title, body: presentedInsights[0].copy.detail }
      : {
          title: english ? "Collecting projected data" : "Projectionデータを収集中です",
          body: english ? "Insights appear after enough projected history is available." : "十分なProjection履歴が揃うとインサイトを表示します。",
        },
    insightCards,
    channelInsights: analytics.channels.slice(0, 20).map((channel: any) => ({
      channelName: channel.name,
      messageCount: channel.messages,
      previousMessageCount: channel.previousMessages,
    })),
    coverage: {
      statsDays: dates.filter((date) => daily.has(date)).length,
      messageDays: chartPoints.filter((value) => value > 0).length,
      insightRequiredDays: 10,
      insightRemainingDays: Math.max(0, 10 - dates.filter((date) => daily.has(date)).length),
    },
    activities: [],
    botStatus: {
      lastRecordedAt: bundle.metadata.lastUpdatedAt
        ? new Date(bundle.metadata.lastUpdatedAt).toISOString()
        : null,
      lastPermissionCheckAt: null,
      unreadableChannelCount: 0,
      unreadableChannelNames: [],
    },
    readMeta: analytics.readMeta,
  };
}

export function buildProjectionGoalMetrics(
  bundle: ProjectionBundle,
  startDate: string,
  endDate: string,
) {
  const daily = projectionRows(
    snapshotPayloads(bundle),
    "guild_daily",
    startDate,
    endDate,
  );
  return {
    values: {
      member_growth: Math.max(
        0,
        daily.reduce((sum, row) => sum + number(row.memberDelta ?? row.members?.delta), 0),
      ),
      messages: daily.reduce((sum, row) => sum + number(row.messageCount), 0),
      voice_seconds: daily.reduce(
        (sum, row) => sum + number(row.voiceSeconds ?? row.voice?.seconds),
        0,
      ),
    },
    readMeta: {
      available: bundle.available,
      ...bundle.metadata,
      projectionRows: daily.length,
      rawAnalyticsQueries: 0,
    },
  };
}
