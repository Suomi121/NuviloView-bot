const INTERNAL_CHANNEL_ID = /^\d{16,22}$/;

const TITLES = {
  activity_increased: ["サーバー全体の活動が増えています", "Server activity is increasing"],
  activity_decreased: ["サーバー全体の活動が減少しています", "Server activity is decreasing"],
  retention_increased: ["新規メンバーの定着率が上昇しています", "New-member retention is improving"],
  retention_decreased: ["新規メンバーの定着率が低下しています", "New-member retention is declining"],
  activity_concentrated: ["活動が一部のメンバーに集中しています", "Activity is concentrated among a small group"],
  voice_increased: ["通話活動が増えています", "Voice activity is increasing"],
  voice_decreased: ["通話活動が減少しています", "Voice activity is decreasing"],
  member_increased: ["参加メンバーが増えています", "Member participation is increasing"],
  member_decreased: ["参加メンバーが減少しています", "Member participation is decreasing"],
};

const RECOMMENDATIONS = {
  review_activity_drivers: ["減少寄与の大きいチャンネルや時間帯を確認してみてください。", "Consider reviewing the channels and time windows with the largest decline."],
  review_successful_channels: ["伸びたチャンネルの運用パターンを、ほかの場所でも活用できるか確認してみてください。", "Consider whether successful channel patterns can be applied elsewhere."],
  review_onboarding: ["案内チャンネルや初回投稿までの導線を確認してみてください。", "Consider reviewing onboarding guidance and the path to a first post."],
  review_retained_behaviors: ["定着した参加者に共通する行動傾向を確認してみてください。", "Consider reviewing behaviors shared by retained members."],
  review_channel_context: ["該当チャンネルの予定・話題・権限変更と同じ時期か確認してみてください。", "Consider checking whether schedules, topics, or permissions changed in the same period."],
  broaden_participation: ["新規・低頻度メンバーが参加しやすい話題や導線を検討してください。", "Consider ways to make participation easier for new or infrequent members."],
  review_voice_schedule: ["通話の開催時間やイベントの有無を同じ期間で確認してみてください。", "Consider checking voice schedules and events during the same period."],
};

const CATEGORY_LABELS = {
  activity: ["活動", "Activity"],
  channel: ["チャンネル", "Channel"],
  retention: ["定着率", "Retention"],
  distribution: ["参加分布", "Participation"],
  voice: ["通話", "Voice"],
  member: ["メンバー", "Members"],
  members: ["メンバー", "Members"],
};

const SEVERITY_LABELS = {
  positive: ["良好", "Positive"],
  attention: ["要確認", "Review"],
  critical: ["重要", "Critical"],
};

function languageIndex(locale) {
  return locale === "en" ? 1 : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localizedNumber(value, locale) {
  const number = finiteNumber(value) ?? 0;
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "ja-JP", {
    maximumFractionDigits: Number.isInteger(number) ? 0 : 1,
  }).format(number);
}

function trimChannelName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^#+/, "");
  if (!name || INTERNAL_CHANNEL_ID.test(name)) return null;
  return name.slice(0, 100);
}

function metadataName(channelNames, channelId) {
  if (!channelNames || !channelId) return null;
  const entry = channelNames instanceof Map
    ? channelNames.get(channelId)
    : channelNames[channelId];
  return trimChannelName(typeof entry === "string" ? entry : entry?.name);
}

export function unknownChannelLabel(channelId, locale = "ja") {
  const suffix = typeof channelId === "string" && channelId
    ? ` (…${channelId.slice(-6)})`
    : "";
  return locale === "en" ? `Unknown channel${suffix}` : `不明なチャンネル${suffix}`;
}

export function resolveChannelDisplayName({
  channelId,
  projectedName = null,
  channelNames = null,
  locale = "ja",
} = {}) {
  const normalizedId = typeof channelId === "string" ? channelId : "";
  return metadataName(channelNames, normalizedId)
    ?? trimChannelName(projectedName)
    ?? unknownChannelLabel(normalizedId, locale);
}

export function formatVoiceDuration(seconds, locale = "ja") {
  const totalMinutes = Math.max(0, Math.floor((finiteNumber(seconds) ?? 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (locale === "en") {
    if (hours && minutes) return `about ${hours}h ${minutes}m`;
    if (hours) return `about ${hours}h`;
    return `${minutes}m`;
  }
  if (hours && minutes) return `約${hours}時間${minutes}分`;
  if (hours) return `約${hours}時間`;
  return `${minutes}分`;
}

function formatPercent(value) {
  const percent = finiteNumber(value);
  if (percent === null) return null;
  return `${percent >= 0 ? "+" : ""}${localizedNumber(percent, "ja")}%`;
}

function countDetail(values, locale, unit) {
  const current = finiteNumber(values.current) ?? 0;
  const previous = finiteNumber(values.previous) ?? 0;
  const percent = formatPercent(values.percent);
  const currentText = localizedNumber(current, locale);
  const previousText = localizedNumber(previous, locale);
  if (previous === 0 && current > 0) {
    return locale === "en"
      ? `No activity was recorded in the previous period; the current period has ${currentText} ${unit.en}.`
      : `前期間は記録がなく、現在${currentText}${unit.ja}です。`;
  }
  if (locale === "en") {
    return `Previous ${previousText} ${unit.en} → current ${currentText} ${unit.en}${percent ? ` (${percent})` : ""}.`;
  }
  return `前期間${previousText}${unit.ja} → 現在${currentText}${unit.ja}${percent ? `（${percent}）` : ""}`;
}

function voiceDetail(values, locale) {
  const current = finiteNumber(values.current) ?? 0;
  const previous = finiteNumber(values.previous) ?? 0;
  const percent = formatPercent(values.percent);
  const currentText = formatVoiceDuration(current, locale);
  if (previous === 0 && current > 0) {
    return locale === "en"
      ? `No voice activity was recorded in the previous period; the current period has ${currentText}.`
      : `前期間は通話記録がなく、現在${currentText}です。`;
  }
  const previousText = formatVoiceDuration(previous, locale);
  return locale === "en"
    ? `Previous ${previousText} → current ${currentText}${percent ? ` (${percent})` : ""}.`
    : `前期間${previousText} → 現在${currentText}${percent ? `（${percent}）` : ""}`;
}

function retentionDetail(values, locale) {
  const current = finiteNumber(values.current);
  const previous = finiteNumber(values.previous);
  const delta = finiteNumber(values.delta);
  if (current === null || previous === null) {
    return locale === "en" ? "The comparison value is not available yet." : "比較に必要な値がまだ揃っていません。";
  }
  const deltaText = delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${localizedNumber(delta, locale)}pt)`;
  return locale === "en"
    ? `Previous ${localizedNumber(previous, locale)}% → current ${localizedNumber(current, locale)}%${deltaText}.`
    : `前期間${localizedNumber(previous, locale)}% → 現在${localizedNumber(current, locale)}%${deltaText}`;
}

function channelPresentation(insight, locale, channelNames) {
  const values = insight?.values ?? {};
  const change = values.change ?? {};
  const channelName = resolveChannelDisplayName({
    channelId: typeof values.id === "string" ? values.id : "",
    projectedName: values.name,
    channelNames,
    locale,
  });
  const increased = insight?.titleKey === "channel_increased";
  const title = locale === "en"
    ? `#${channelName} usage is ${increased ? "increasing" : "decreasing"}`
    : `#${channelName} の利用が${increased ? "増えています" : "減少しています"}`;
  return {
    title,
    detail: countDetail(change, locale, { ja: "件", en: "messages" }),
  };
}
export function formatInsightPresentation(insight, {
  locale = "ja",
  channelNames = null,
} = {}) {
  const normalizedLocale = locale === "en" ? "en" : "ja";
  const index = languageIndex(normalizedLocale);
  const values = insight?.values ?? {};
  const key = typeof insight?.titleKey === "string" ? insight.titleKey : "";
  let title = TITLES[key]?.[index]
    ?? (normalizedLocale === "en" ? "A server change was detected" : "サーバーの変化を確認しました");
  let detail;
  if (key === "channel_increased" || key === "channel_decreased") {
    ({ title, detail } = channelPresentation(insight, normalizedLocale, channelNames));
  } else if (key === "voice_increased" || key === "voice_decreased") {
    detail = voiceDetail(values, normalizedLocale);
  } else if (key === "retention_increased" || key === "retention_decreased") {
    detail = retentionDetail(values, normalizedLocale);
  } else if (key === "activity_concentrated") {
    const share = finiteNumber(values.share);
    detail = share === null
      ? (normalizedLocale === "en" ? "The participation share is not available yet." : "参加割合の値がまだ揃っていません。")
      : (normalizedLocale === "en"
          ? `The top 10% account for ${localizedNumber(share, normalizedLocale)}% of messages.`
          : `上位10%のメンバーが投稿の${localizedNumber(share, normalizedLocale)}%を占めています。`);
  } else {
    const member = key === "member_increased" || key === "member_decreased";
    detail = countDetail(values, normalizedLocale, member
      ? { ja: "人", en: "members" }
      : { ja: "件", en: "activities" });
  }
  return {
    title,
    detail,
    recommendation: RECOMMENDATIONS[insight?.recommendationKey]?.[index] ?? (normalizedLocale === "en" ? "Review the related period and context." : "関連する期間と状況を確認してみてください。"),
    categoryLabel: CATEGORY_LABELS[insight?.category]?.[index] ?? (normalizedLocale === "en" ? "Insight" : "インサイト"),
    severityLabel: SEVERITY_LABELS[insight?.severity]?.[index] ?? (normalizedLocale === "en" ? "Review" : "要確認"),
  };
}
