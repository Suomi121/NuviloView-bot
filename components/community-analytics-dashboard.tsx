"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, BarChart3, Clock3, Hash, HeartPulse, LoaderCircle, MessageSquareText, Mic2, Sparkles, TrendingDown, TrendingUp, Users } from "lucide-react";
import { AnalyticsRefreshCountdown } from "@/components/analytics-refresh-countdown";
import { ProjectionReadNotice, type ProjectionReadMeta } from "@/components/projection-read-notice";

export type CommunityAnalyticsView = "retention" | "health" | "diagnostics" | "channels" | "roles" | "insights";

type AnalyticsData = {
  readMeta: ProjectionReadMeta;
  range: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string; days: number };
  coverage: { observationDays: number; memberTrackingSince: string | null; storedMessages: number; messagesWithChannelId: number; messagesWithRoles: number; retentionAvailable: boolean; roleHistoryMode: string };
  retention: any;
  health: any;
  diagnostics: any;
  insights: any[];
  channels: any[];
  roles: any[];
  channelDetail: { channelId: string | null; heatmap: Array<{ day: number; hour: number; value: number }> };
};

type Props = {
  view: CommunityAnalyticsView | "overview";
  guildId: string;
  days: number;
  timeZone: string;
  locale: "ja" | "en";
};

const metricLabels: Record<string, [string, string]> = {
  messages: ["メッセージ", "Messages"], active_members: ["アクティブメンバー", "Active members"], reaction_rate: ["リアクション率", "Reaction rate"],
  voice_activity: ["VC利用時間", "Voice activity"], new_members: ["新規メンバー", "New members"], leave_count: ["退出数", "Leave count"], retention: ["7日アクティビティ定着率", "7-day activity retention"],
};

export function CommunityAnalyticsDashboard({ view, guildId, days: initialDays, timeZone, locale }: Props) {
  const en = locale === "en";
  const [presetDays, setPresetDays] = useState(initialDays === 14 || initialDays === 150 ? 30 : initialDays);
  const [custom, setCustom] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [excludeBots, setExcludeBots] = useState(true);
  const [roleId, setRoleId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [options, setOptions] = useState<{ roles: any[]; channels: any[] }>({ roles: [], channels: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);

  useEffect(() => {
    if (!guildId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ guildId, timeZone, excludeBots: String(excludeBots) });
    if (custom && startDate && endDate) {
      params.set("startDate", startDate);
      params.set("endDate", endDate);
    } else {
      params.set("days", String(presetDays));
    }
    if (roleId) params.set("roleId", roleId);
    if (channelId) params.set("channelId", channelId);
    setLoading(true);
    setError(false);
    fetch(`/api/analytics/community?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("analytics request failed");
        return response.json();
      })
      .then((next: AnalyticsData) => {
        setData(next);
        if (!roleId && !channelId) setOptions({ roles: next.roles, channels: next.channels });
      })
      .catch((requestError) => {
        if (requestError?.name !== "AbortError") setError(true);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [channelId, custom, endDate, excludeBots, guildId, presetDays, refreshSequence, roleId, startDate, timeZone]);

  if (view === "overview") {
    return <>
      {data?.readMeta && <div className="mt-5"><ProjectionReadNotice meta={data.readMeta} locale={locale} compact /></div>}
      <AnalyticsOverview data={data} loading={loading} error={error} en={en} />
    </>;
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border bg-card/55 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {[7, 30, 90].map((value) => <button key={value} type="button" onClick={() => { setCustom(false); setPresetDays(value); }} className={`rounded-lg px-3 py-2 text-xs font-bold ${!custom && presetDays === value ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>{en ? `${value} days` : `${value}日`}</button>)}
          <button type="button" onClick={() => setCustom(true)} className={`rounded-lg px-3 py-2 text-xs font-bold ${custom ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>{en ? "Custom" : "カスタム"}</button>
          {custom && <><input aria-label={en ? "Start date" : "開始日"} type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs" /><span className="text-muted-foreground">–</span><input aria-label={en ? "End date" : "終了日"} type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs" /></>}
          <select aria-label={en ? "Role filter" : "ロール絞り込み"} value={roleId} onChange={(event) => setRoleId(event.target.value)} className="min-w-36 rounded-lg border border-border bg-background px-3 py-2 text-xs"><option value="">{en ? "All roles" : "すべてのロール"}</option>{options.roles.filter((role) => !role.deleted).map((role) => <option value={role.roleId} key={role.roleId}>{role.name}</option>)}</select>
          <select aria-label={en ? "Channel filter" : "チャンネル絞り込み"} value={channelId} onChange={(event) => setChannelId(event.target.value)} className="min-w-36 rounded-lg border border-border bg-background px-3 py-2 text-xs"><option value="">{en ? "All channels" : "すべてのチャンネル"}</option>{options.channels.filter((channel) => channel.channelId && !channel.deleted).map((channel) => <option value={channel.channelId} key={channel.channelId}>#{channel.name}</option>)}</select>
          <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-muted-foreground" title={en ? "Bot filtering is not available in Projection v1" : "Bot除外はProjection v1では未対応です"}><input type="checkbox" checked={excludeBots} disabled onChange={(event) => setExcludeBots(event.target.checked)} className="accent-primary disabled:opacity-50" />{en ? "Bot filter unavailable" : "Bot除外は未対応"}</label>
          <AnalyticsRefreshCountdown
            guildId={guildId}
            locale={locale}
            onRefresh={() => setRefreshSequence((value) => value + 1)}
          />
        </div>
      </section>
      {loading && !data ? <LoadingState en={en} /> : error && !data ? <ErrorState en={en} /> : data ? <>
        <ProjectionReadNotice meta={data.readMeta} locale={locale} />
        <CoverageNotice data={data} en={en} />
        {view === "retention" && <RetentionView data={data} en={en} />}
        {view === "health" && <HealthView data={data} en={en} />}
        {view === "diagnostics" && <DiagnosticsView data={data} en={en} />}
        {view === "channels" && <ChannelsView data={data} en={en} onSelectChannel={setChannelId} />}
        {view === "roles" && <RolesView data={data} en={en} />}
        {view === "insights" && <InsightsView data={data} en={en} />}
      </> : null}
      {loading && data && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{en ? "Refreshing…" : "更新中…"}</p>}
    </div>
  );
}

function AnalyticsOverview({ data, loading, error, en }: { data: AnalyticsData | null; loading: boolean; error: boolean; en: boolean }) {
  if (loading && !data) return <LoadingState en={en} />;
  if (error || !data) return null;
  const health = data.health;
  const healthAvailable = health.isAvailable !== false && health.score !== null;
  return <section className="mt-5 grid gap-5 xl:grid-cols-[.75fr_1.25fr]">
    <div className="rounded-2xl border border-primary/20 bg-card/55 p-5"><div className="flex items-center justify-between"><div><p className="text-xs font-bold tracking-wider text-primary">HEALTH V2 · PREVIEW</p><h2 className="mt-1 text-lg font-bold">{en ? "Shadow candidate score" : "Shadow候補スコア"}</h2></div><HeartPulse className="h-5 w-5 text-primary" /></div>{healthAvailable ? <div className="mt-5 flex items-end gap-3"><span className="text-5xl font-black">{health.score}</span><span className="pb-1 text-sm text-muted-foreground">/ 100</span><StatusPill value={health.status} en={en} /></div> : <div className="mt-5"><p className="text-2xl font-black">{en ? "Insufficient Data" : "データ不足"}</p>{health.provisionalScore != null && <p className="mt-1 text-xs text-muted-foreground">{en ? `Provisional score: ${health.provisionalScore}` : `暫定スコア: ${health.provisionalScore}`}</p>}</div>}<p className="mt-3 text-xs text-muted-foreground">{en ? `Confidence: ${health.confidence} · ${data.coverage.observationDays} observed days` : `信頼度: ${confidenceLabel(health.confidence, false)}・観測${data.coverage.observationDays}日`}</p><p className="mt-1 text-xs text-primary">{en ? "Preview only — does not replace the current dashboard signal." : "プレビュー専用です。既存のダッシュボード指標は置き換えません。"}</p>{!healthAvailable && <p className="mt-1 text-xs text-amber-400">{availabilityReasonText(health, en)}</p>}</div>
    <div className="rounded-2xl border border-border bg-card/55 p-5"><div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /><h2 className="font-bold">{en ? "Top insights" : "重要インサイト"}</h2></div>{data.insights.length ? <div className="mt-4 grid gap-3 sm:grid-cols-3">{data.insights.slice(0, 3).map((insight) => <InsightCard key={insight.id} insight={insight} en={en} compact />)}</div> : <p className="mt-4 text-sm text-muted-foreground">{en ? "No significant changes detected in this period." : "この期間に重要な変化は検出されませんでした。"}</p>}</div>
  </section>;
}

function CoverageNotice({ data, en }: { data: AnalyticsData; en: boolean }) {
  const coverage = data.coverage;
  const incompleteChannels = coverage.storedMessages > coverage.messagesWithChannelId;
  const incompleteRoles = coverage.storedMessages > coverage.messagesWithRoles;
  if (coverage.retentionAvailable && !incompleteChannels && !incompleteRoles) return null;
  return <div className="flex gap-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-4 text-xs text-amber-200"><AlertTriangle className="h-4 w-4 shrink-0" /><p>{en ? "Historical coverage is partial. Retention begins when member-event collection starts; channel IDs and event-time roles are not retroactively inferred for older messages." : "過去データの一部は観測対象外です。定着率は参加イベント収集開始後のみで、古い投稿へチャンネルIDや現在ロールを遡及適用していません。0%ではなく「データなし」として扱います。"}</p></div>;
}

function RetentionView({ data, en }: { data: AnalyticsData; en: boolean }) {
  const value = data.retention;
  return <>
    <PageHeading eyebrow="RETENTION" title={en ? "Retention overview" : "定着率分析"} description={en ? "New-member onboarding, continued activity, and departures." : "新規参加者の初回行動・継続活動・離脱を分析します。"} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard icon={<Users />} label={en ? "New members" : "新規参加者"} value={formatCount(value.joined, en)} /><MetricCard icon={<Activity />} label={en ? "7-day activity retention" : "7日アクティビティ定着率"} value={formatRate(value.retention7.rate, value.retention7.eligible, en)} detail={eligibleText(value.retention7.eligible, en)} /><MetricCard icon={<HeartPulse />} label={en ? "30-day activity retention" : "30日アクティビティ定着率"} value={formatRate(value.retention30.rate, value.retention30.eligible, en)} detail={eligibleText(value.retention30.eligible, en)} /><MetricCard icon={<MessageSquareText />} label={en ? "First-message rate" : "初投稿率"} value={formatRate(value.firstMessage.rate, value.joined, en)} /></div>
    <SectionCard title={en ? "Retention funnel" : "定着ファネル"} description={en ? "Day 7/30 means message, voice, or reaction activity in the 24-hour window after that milestone; only eligible cohorts are included." : "7日・30日は、その時点から24時間以内の投稿・VC・リアクション活動を示します。判定可能な参加者だけが分母です。"}><div className="space-y-3">{value.funnel.map((stage: any, index: number) => <div key={stage.key} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm"><span className="font-semibold">{funnelLabel(stage.key, en)}</span><div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-gradient-to-r from-primary to-violet-400" style={{ width: `${stage.rate ?? 0}%` }} /></div><span className="w-28 text-right font-bold">{stage.count.toLocaleString()} · {stage.rate === null ? "—" : `${stage.rate}%`}</span>{index < value.funnel.length - 1 && <span className="col-span-3 mx-auto text-muted-foreground">↓</span>}</div>)}</div></SectionCard>
    <div className="grid gap-5 xl:grid-cols-2"><SectionCard title={en ? "First actions" : "初回アクション"}><div className="grid gap-3 sm:grid-cols-2"><SmallStat label={en ? "Posted within 1 hour" : "1時間以内に投稿"} value={value.firstMessage.within1Hour} /><SmallStat label={en ? "Posted within 24 hours" : "24時間以内に投稿"} value={value.firstMessage.within24Hours} /><SmallStat label={en ? "Joined VC within 24 hours" : "24時間以内にVC参加"} value={value.firstVoice.within24Hours} /><SmallStat label={en ? "Made / received reactions" : "リアクションした / された"} value={`${value.reactions.made} / ${value.reactions.received}`} /></div></SectionCard><SectionCard title={en ? "Departure windows" : "離脱タイミング"}><div className="grid gap-3 sm:grid-cols-2"><SmallStat label={en ? "Within 24 hours" : "24時間以内"} value={value.departures.within24Hours} /><SmallStat label={en ? "Within 3 days" : "3日以内"} value={value.departures.within3Days} /><SmallStat label={en ? "Within 7 days" : "7日以内"} value={value.departures.within7Days} /><SmallStat label={en ? "Average observed tenure" : "観測できた平均在籍期間"} value={formatDuration(value.departures.averageTenureSeconds, en)} /></div></SectionCard></div>
    <SectionCard title={en ? "Behavior association" : "行動と定着の関連"} description={en ? "Correlation only; this does not establish causation." : "相関の表示であり、因果関係を示すものではありません。"}><div className="grid gap-3 sm:grid-cols-3">{value.behavior.map((item: any) => <div key={item.key} className="rounded-xl bg-secondary/45 p-4"><p className="font-bold">{behaviorLabel(item.key, en)}</p><p className="mt-3 text-sm text-muted-foreground">{en ? "With activity" : "経験あり"}: <b className="text-foreground">{formatRate(item.withRate, item.withSample, en)}</b> ({item.withSample})</p><p className="mt-1 text-sm text-muted-foreground">{en ? "Without activity" : "経験なし"}: <b className="text-foreground">{formatRate(item.withoutRate, item.withoutSample, en)}</b> ({item.withoutSample})</p></div>)}</div></SectionCard>
    <SectionCard title={en ? "Weekly cohorts" : "週次コホート"}><div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-3">Cohort</th><th className="p-3">Joined</th><th className="p-3">Day 1</th><th className="p-3">Day 7</th><th className="p-3">Day 30</th></tr></thead><tbody>{value.cohorts.map((cohort: any) => <tr key={cohort.cohort} className="border-t border-border"><td className="p-3 font-semibold">{cohort.cohort}</td><td className="p-3">{cohort.joined}</td>{[cohort.day1, cohort.day7, cohort.day30].map((cell: any, index: number) => <td key={index} className="p-3"><span className="inline-flex min-w-16 justify-center rounded-lg px-2 py-1 font-bold" style={{ backgroundColor: cell.rate === null ? "rgba(120,120,130,.12)" : `color-mix(in srgb, var(--primary) ${Math.max(12, cell.rate)}%, transparent)` }}>{formatRate(cell.rate, cell.eligible, en)}</span></td>)}</tr>)}</tbody></table>{!value.cohorts.length && <EmptyState en={en} />}</div></SectionCard>
  </>;
}

function HealthView({ data, en }: { data: AnalyticsData; en: boolean }) {
  const health = data.health;
  const healthAvailable = health.isAvailable !== false && health.score !== null;
  const categories = Object.entries(health.categories) as Array<[string, number | null]>;
  return <><PageHeading eyebrow="HEALTH V2 · PREVIEW" title={en ? "Server Health Score v2" : "サーバーヘルススコア v2"} description={en ? "Preview / Shadow scoring based on available observations. It is not the official Health release." : "観測データを使ったPreview / Shadow計算です。正式版Healthではありません。"} /><div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/10 p-4 text-xs text-muted-foreground"><Sparkles className="h-4 w-4 shrink-0 text-primary" /><p>{en ? "Shadow mode records candidate values separately and does not replace the existing live activity signal, alerts, or operational decisions." : "Shadowモードでは候補値を別扱いで記録します。既存のリアルタイム活動パルス、通知、運用判定には影響しません。"}</p></div><div className="grid gap-5 xl:grid-cols-[.7fr_1.3fr]"><SectionCard title={en ? "Candidate score" : "候補スコア"}>{healthAvailable ? <><div className="flex items-end gap-3"><span className="text-7xl font-black">{health.score}</span><span className="pb-2 text-muted-foreground">/ 100</span></div><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-primary/15 px-3 py-1 text-xs font-bold text-primary">PREVIEW</span><StatusPill value={health.status} en={en} /><span className="rounded-full bg-secondary px-3 py-1 text-xs font-bold">{en ? `Confidence: ${health.confidence}` : `信頼度: ${confidenceLabel(health.confidence, false)}`}</span></div></> : <><p className="text-3xl font-black">{en ? "Insufficient Data" : "データ不足"}</p><p className="mt-2 text-sm text-amber-400">{availabilityReasonText(health, en)}</p><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-primary/15 px-3 py-1 text-xs font-bold text-primary">PREVIEW</span><span className="rounded-full bg-secondary px-3 py-1 text-xs font-bold">{en ? `Confidence: ${health.confidence}` : `信頼度: ${confidenceLabel(health.confidence, false)}`}</span>{health.provisionalScore != null && <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">{en ? `Provisional: ${health.provisionalScore}` : `暫定値: ${health.provisionalScore}`}</span>}</div></>}<p className="mt-4 text-sm text-muted-foreground">{health.change === null ? (en ? "Previous candidate score unavailable" : "前期間の候補スコアはデータ不足") : `${health.change >= 0 ? "+" : ""}${health.change} ${en ? "candidate points vs previous period" : "候補ポイント（前期間比）"}`}</p></SectionCard><SectionCard title={en ? "Category scores" : "カテゴリ別スコア"} description={en ? "Missing categories are excluded and weights are re-normalized." : "欠測カテゴリは0点にせず、利用可能な重みだけで再正規化します。"}><div className="space-y-4">{categories.map(([key, value]) => <div key={key}><div className="mb-1.5 flex justify-between text-sm"><span className="font-semibold">{categoryLabel(key, en)}</span><b>{value === null ? (en ? "No data" : "データなし") : Math.round(value)}</b></div><div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${value ?? 0}%` }} /></div></div>)}</div></SectionCard></div><HealthDataQualityPanel health={health} en={en} /><SectionCard title={en ? "Shadow score history" : "Shadowスコア履歴"} description={en ? "Preview candidates are stored in metadata; the official score column remains empty until a stable release." : "Preview候補値はメタデータへ保存し、正式リリースまではDBの正式score列を空のまま維持します。"}><MiniBars rows={health.history.map((item: any) => ({ label: item.date, value: item.score }))} en={en} /></SectionCard><SectionCard title={en ? "Preview calculation" : "Preview計算内容"}><p className="text-sm leading-7 text-muted-foreground">{en ? "Engagement 25% (active rate, daily messages per active member, reaction rate); Activity Retention 25% (day 7/day 30 activity windows); Distribution 20% (top 10% concentration with at least 10 authors); Voice 15% (participation and daily time per voice user); Growth 15% (30-day-normalized net growth and early departures). A candidate score requires at least 3 categories, Confidence 40+, and 7 observed days." : "Engagement 25%（アクティブ率・1人1日あたり投稿・リアクション率）、Activity Retention 25%（7日後・30日後の活動）、Distribution 20%（投稿者10人以上での上位10%集中度）、Voice 15%（参加率・VC利用者1人1日あたり時間）、Growth 15%（30日換算純増・早期離脱）です。候補値の通常表示には3カテゴリ以上・Confidence 40以上・観測7日以上が必要です。"}</p></SectionCard></>;
}

function HealthDataQualityPanel({ health, en }: { health: any; en: boolean }) {
  const quality = health.dataQuality;
  if (!quality) return null;
  const rows = [
    ...Object.entries(quality.categories ?? {}),
    ["reaction", quality.components?.reaction],
  ].filter((entry) => entry[1]) as Array<[string, any]>;
  const retentionEvidence = quality.evidence?.retentionSources ?? {};
  const excludedRetention = Number(retentionEvidence.discordSync ?? 0) + Number(retentionEvidence.historicalImport ?? 0) + Number(retentionEvidence.unknown ?? 0);
  const invalidVoice = Number(quality.evidence?.voice?.invalidSessions ?? 0);
  return <SectionCard title={en ? "Data quality gate" : "データ品質ゲート"} description={en ? "Every category shows its source confidence and observation maturity. Missing or immature data is not converted to zero." : "カテゴリごとにデータ源の信頼度と観測成熟度を表示します。欠測・未成熟データを0点には変換しません。"}>
    <div className={`mb-4 rounded-xl border px-4 py-3 text-xs ${quality.passes ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>
      <b>{quality.passes ? (en ? "Gate passed" : "品質ゲート通過") : (en ? "Provisional only" : "暫定値のみ")}</b>
      {!quality.passes && <p className="mt-1 opacity-80">{(quality.blockingReasons ?? []).map((reason: string) => qualityReasonText(reason, en)).join(" · ")}</p>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map(([key, item]) => <div key={key} className="min-w-0 rounded-xl border border-border bg-secondary/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><b className="text-sm">{key === "reaction" ? (en ? "Reaction input" : "リアクション入力") : categoryLabel(key, en)}</b><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${qualityStateTone(item.qualityState)}`}>{qualityStateLabel(item.qualityState, en)}</span></div>
        <p className="mt-3 text-xs text-muted-foreground">{en ? `Score ${item.score == null ? "—" : Math.round(item.score)} · Confidence ${item.confidence}` : `スコア ${item.score == null ? "—" : Math.round(item.score)}・信頼度 ${confidenceLabel(item.confidence, false)}`}</p>
        <p className="mt-1 text-xs text-muted-foreground">{en ? `${Math.round(item.observationDays ?? 0)} observed days` : `観測 ${Math.round(item.observationDays ?? 0)}日`}</p>
        <p className="mt-2 break-words text-[11px] leading-relaxed text-muted-foreground">{qualityReasonText(item.reason, en)}</p>
      </div>)}
    </div>
    <div className="mt-4 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3"><p>{en ? `Unverified retention events excluded: ${excludedRetention}` : `Retention除外イベント: ${excludedRetention}件`}</p><p>{en ? `Invalid Voice sessions excluded: ${invalidVoice}` : `Voice異常除外: ${invalidVoice}件`}</p><p>{en ? `Reaction observation: ${Number(quality.evidence?.reaction?.observationDays ?? 0)} days` : `Reaction観測: ${Number(quality.evidence?.reaction?.observationDays ?? 0)}日`}</p></div>
  </SectionCard>;
}

function qualityStateTone(value: string) {
  if (value === "Available") return "bg-emerald-400/15 text-emerald-300";
  if (value === "LowConfidence") return "bg-amber-400/15 text-amber-300";
  if (value === "Immature") return "bg-sky-400/15 text-sky-300";
  return "bg-secondary text-muted-foreground";
}

function qualityStateLabel(value: string, en: boolean) {
  if (en) return value || "Unavailable";
  return ({ Available: "利用可能", LowConfidence: "低信頼", Immature: "観測未成熟", Unavailable: "利用不可" } as Record<string, string>)[value] ?? "利用不可";
}

function qualityReasonText(value: string, en: boolean) {
  if (en) return String(value || "not_available").replaceAll("_", " ");
  const labels: Record<string, string> = {
    message_activity_observed: "投稿活動を観測済み",
    no_message_activity: "期間内の投稿活動なし",
    engagement_window_immature: "Engagementの観測期間が不足",
    live_join_sources_only: "ライブ加入イベントのみを使用",
    unverified_sources_excluded: "同期・未検証の加入イベントを除外",
    sync_or_unverified_join_sources_only: "同期・未検証の加入イベントしかありません",
    retention_unverified_sources_only: "Retentionを検証可能なライブ加入データがありません",
    retention_window_immature: "Retentionの観測期間が不足",
    no_eligible_live_join_cohort: "判定可能なライブ加入コホートなし",
    small_live_join_cohort: "ライブ加入コホートが少数",
    author_sample_sufficient: "投稿者サンプルは十分",
    insufficient_unique_authors: "投稿者サンプルが不足",
    voice_sessions_valid: "Voiceセッションは正常",
    voice_not_observed: "Voiceデータ未観測",
    voice_sessions_all_invalid: "Voiceセッションがすべて無効",
    voice_window_immature: "Voiceの観測期間が不足",
    voice_outliers_excluded: "Voice異常セッションを除外",
    voice_outlier_rate_high: "Voice異常率が高いため暫定値のみ",
    small_voice_sample: "Voiceセッションが少数",
    membership_sample_sufficient: "参加・退出サンプルは十分",
    small_membership_sample: "参加・退出サンプルが少数",
    no_membership_events: "参加・退出イベントなし",
    reaction_collection_mature: "Reaction収集期間は成熟",
    reaction_collection_recent: "Reaction収集期間が30日未満",
    reaction_collection_immature: "Reaction収集期間が14日未満",
    reaction_not_observed: "Reactionデータ未観測",
    small_reaction_sample: "Reactionイベントが少数",
  };
  return labels[value] ?? String(value || "利用できる根拠データがありません");
}

function DiagnosticsView({ data, en }: { data: AnalyticsData; en: boolean }) {
  const [metricKey, setMetricKey] = useState("messages");
  const metric = data.diagnostics.metrics.find((item: any) => item.key === metricKey) ?? data.diagnostics.metrics[0];
  const isRate = metricKey === "reaction_rate" || metricKey === "retention";
  return <><PageHeading eyebrow="DIAGNOSTICS" title={en ? "Why did this change?" : "数値変化の要因分析"} description={en ? "Contributors and associated changes, not causal claims." : "因果を断定せず、変化へ寄与した集計軸を表示します。"} /><SectionCard title={en ? "Metric comparison" : "指標比較"}><div className="flex flex-wrap items-center gap-3"><select value={metricKey} onChange={(event) => setMetricKey(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">{data.diagnostics.metrics.map((item: any) => <option value={item.key} key={item.key}>{metricLabels[item.key]?.[en ? 1 : 0] ?? item.key}</option>)}</select><div className="ml-auto text-right"><p className="text-3xl font-black">{metric.current === null ? "—" : `${Number(metric.current).toLocaleString()}${isRate ? "%" : ""}`}</p><p className={`text-xs font-bold ${Number(metric.absolute) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{metric.absolute === null ? (en ? "No comparison" : "比較データなし") : `${Number(metric.absolute) >= 0 ? "+" : ""}${metric.absolute}${isRate ? "pt" : ""} ${en ? "vs previous period" : "（前期間比）"}`}</p></div></div></SectionCard><div className="grid gap-5 xl:grid-cols-2"><ContributorList title={en ? "Channel contributors" : "チャンネル別寄与"} rows={data.diagnostics.channels} en={en} /><ContributorList title={en ? "Time contributors" : "時間帯別寄与"} rows={data.diagnostics.times} en={en} /><ContributorList title={en ? "Role contributors" : "ロール別寄与"} rows={data.diagnostics.roles} en={en} /><ContributorList title={en ? "New vs existing members" : "新規・既存メンバー別"} rows={data.diagnostics.lifecycle} en={en} /></div><SectionCard title={en ? "Member-level detail" : "メンバー別詳細"} description={en ? "Visible only to an authorized server manager; neutral wording is used." : "権限確認済みの管理者向け詳細です。個人を原因と断定しません。"}><ContributorRows rows={data.diagnostics.members} en={en} /></SectionCard></>;
}

function ChannelsView({ data, en, onSelectChannel }: { data: AnalyticsData; en: boolean; onSelectChannel: (id: string) => void }) {
  const [sort, setSort] = useState("messages");
  const rows = useMemo(() => [...data.channels].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0)), [data.channels, sort]);
  const active = data.channels.filter((item) => item.messages > 0 || item.voiceSeconds > 0);
  const growing = [...data.channels].filter((item) => item.trendPercent !== null).sort((a, b) => b.trendPercent - a.trendPercent)[0];
  return <><PageHeading eyebrow="CHANNELS" title={en ? "Channel analytics" : "チャンネル分析"} description={en ? "Activity, engagement, voice usage, distribution, and trends." : "投稿・反応・VC・活動分布・前期間比をチャンネル単位で確認します。"} /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard icon={<Hash />} label={en ? "Tracked channels" : "追跡チャンネル"} value={String(data.channels.length)} /><MetricCard icon={<Activity />} label={en ? "Active channels" : "アクティブ"} value={String(active.length)} /><MetricCard icon={<MessageSquareText />} label={en ? "Most active" : "最多投稿"} value={data.channels[0] ? `#${data.channels[0].name}` : "—"} /><MetricCard icon={<TrendingUp />} label={en ? "Fastest growing" : "最も伸長"} value={growing ? `#${growing.name}` : "—"} /></div><SectionCard title={en ? "Channel table" : "チャンネル一覧"} description={en ? "Click a channel to open its filtered detail." : "行を押すと、そのチャンネルに絞った詳細を表示します。"}><div className="mb-3 flex justify-end"><select value={sort} onChange={(event) => setSort(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-xs"><option value="messages">Messages</option><option value="uniqueAuthors">Users</option><option value="reactionRate">Engagement</option><option value="trendPercent">Trend</option><option value="voiceSeconds">Voice</option></select></div><div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-3">Channel</th><th className="p-3">Messages</th><th className="p-3">Users</th><th className="p-3">Reactions</th><th className="p-3">Share</th><th className="p-3">Trend</th><th className="p-3">Voice</th><th className="p-3">Status</th></tr></thead><tbody>{rows.map((item) => <tr key={item.channelId ?? item.name} onClick={() => item.channelId && onSelectChannel(item.channelId)} className="cursor-pointer border-t border-border hover:bg-secondary/35"><td className="p-3 font-bold">#{item.name}{item.deleted && <span className="ml-2 text-[10px] text-rose-400">DELETED</span>}</td><td className="p-3">{item.messages.toLocaleString()}</td><td className="p-3">{item.uniqueAuthors}</td><td className="p-3">{item.reactions} ({item.reactionRate ?? "—"}%)</td><td className="p-3">{item.share ?? "—"}%</td><td className="p-3"><Trend value={item.trendPercent} /></td><td className="p-3">{formatDuration(item.voiceSeconds, en)}</td><td className="p-3"><span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-bold">{statusLabel(item.status, en)}</span></td></tr>)}</tbody></table>{!rows.length && <EmptyState en={en} />}</div></SectionCard><SectionCard title={en ? "Day × hour heatmap" : "曜日 × 時間帯ヒートマップ"} description={`${timeZoneDescription(data, en)} · ${data.channelDetail.channelId ? (en ? "selected/top channel" : "選択中または最多投稿チャンネル") : (en ? "No channel selected" : "チャンネル未選択")}`}><Heatmap values={data.channelDetail.heatmap} en={en} /></SectionCard><SectionCard title={en ? "Activity distribution" : "活動分布"}><div className="space-y-3">{data.channels.filter((item) => item.share).slice(0, 8).map((item) => <div key={item.channelId ?? item.name} className="grid grid-cols-[140px_1fr_55px] items-center gap-3 text-sm"><span className="truncate">#{item.name}</span><div className="h-2 rounded-full bg-secondary"><div className="h-2 rounded-full bg-primary" style={{ width: `${item.share}%` }} /></div><b className="text-right">{item.share}%</b></div>)}</div></SectionCard></>;
}

function RolesView({ data, en }: { data: AnalyticsData; en: boolean }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("messages");
  const rows = useMemo(() => data.roles.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0)), [data.roles, query, sort]);
  return <><PageHeading eyebrow="ROLES" title={en ? "Role analytics" : "ロール分析"} description={en ? "Event-time roles are used; overlapping roles must not be summed as a server total." : "イベント発生時点のロールを使用します。複数ロールは重複するため、単純合計はサーバー全体と一致しません。"} /><div className="grid gap-3 sm:grid-cols-3"><MetricCard icon={<Users />} label={en ? "Tracked roles" : "追跡ロール"} value={String(data.roles.length)} /><MetricCard icon={<Activity />} label={en ? "Highest active rate" : "最高アクティブ率"} value={formatRate(Math.max(...data.roles.map((item) => item.activeRate ?? 0), 0), data.roles.length, en)} /><MetricCard icon={<MessageSquareText />} label={en ? "Most active role" : "最多投稿ロール"} value={data.roles[0]?.name ?? "—"} /></div><SectionCard title={en ? "Role comparison" : "ロール比較"}><div className="mb-4 flex flex-wrap gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={en ? "Search roles" : "ロールを検索"} className="rounded-lg border border-border bg-background px-3 py-2 text-xs" /><select value={sort} onChange={(event) => setSort(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-xs"><option value="messages">Messages</option><option value="memberCount">Members</option><option value="activeRate">Active rate</option><option value="voiceSeconds">Voice</option></select></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-3">Role</th><th className="p-3">Members</th><th className="p-3">Active</th><th className="p-3">Active rate</th><th className="p-3">Messages</th><th className="p-3">Reactions</th><th className="p-3">Voice</th><th className="p-3">Trend</th></tr></thead><tbody>{rows.map((item) => <tr key={item.roleId} className="border-t border-border"><td className="p-3 font-bold">{item.name}{item.isEveryone && <span className="ml-2 text-[10px] text-primary">SERVER TOTAL</span>}{item.deleted && <span className="ml-2 text-[10px] text-rose-400">DELETED</span>}</td><td className="p-3">{item.memberCount}</td><td className="p-3">{item.activeMembers}</td><td className="p-3">{item.activeRate ?? "—"}%</td><td className="p-3">{item.messages}</td><td className="p-3">{item.reactions}</td><td className="p-3">{formatDuration(item.voiceSeconds, en)}</td><td className="p-3"><Trend value={item.trendPercent} /></td></tr>)}</tbody></table>{!rows.length && <EmptyState en={en} />}</div></SectionCard><div className="rounded-xl border border-primary/20 bg-primary/10 p-4 text-xs text-muted-foreground">{en ? "Role history is not retroactively inferred. Older messages without an event-time role snapshot remain unassigned; current roles are never applied backwards." : "ロール履歴は推測で補完しません。イベント時点のロール記録がない過去投稿は未分類のままとし、現在ロールを過去へ遡って適用しません。"}</div></>;
}

function InsightsView({ data, en }: { data: AnalyticsData; en: boolean }) {
  return <><PageHeading eyebrow="NUVILOVIEW INSIGHTS" title={en ? "What deserves attention now" : "今、確認すべき変化"} description={en ? "Rules rank significant, well-supported observations and suppress duplicates." : "有意な変化をルールで評価し、重複を抑えて重要度順に表示します。"} /><div className="grid gap-4 lg:grid-cols-2">{data.insights.map((insight) => <InsightCard key={insight.id} insight={insight} en={en} />)}</div>{!data.insights.length && <SectionCard title={en ? "No significant changes" : "重要な変化はありません"}><p className="text-sm text-muted-foreground">{en ? "No rule met both the change threshold and minimum sample for this period." : "この期間は変化幅と最小サンプルの両方を満たすルールがありませんでした。問題を無理に生成していません。"}</p></SectionCard>}</>;
}

function InsightCard({ insight, en, compact = false }: { insight: any; en: boolean; compact?: boolean }) {
  const copy = insightCopy(insight, en);
  const tone = insight.severity === "positive" ? "border-emerald-400/25 bg-emerald-400/10" : insight.severity === "critical" ? "border-rose-400/30 bg-rose-400/10" : "border-amber-400/25 bg-amber-400/10";
  return <article className={`rounded-xl border p-4 ${tone}`}><div className="flex items-center justify-between gap-3"><span className="text-[10px] font-black tracking-wider uppercase">{insight.category} · {insight.severity}</span><span className="text-[10px] text-muted-foreground">{Math.round(insight.importance)}</span></div><h3 className="mt-2 font-bold">{copy.title}</h3><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{copy.detail}</p>{!compact && <div className="mt-3 rounded-lg bg-background/35 p-3 text-xs"><b>{en ? "Suggested review" : "検討候補"}</b><p className="mt-1 text-muted-foreground">{copy.recommendation}</p></div>}</article>;
}

function insightCopy(insight: any, en: boolean) {
  const values = insight.values ?? {};
  const titleMap: Record<string, [string, string]> = {
    activity_increased: ["サーバー活動が増加しました", "Server activity increased"], activity_decreased: ["サーバー活動が減少しました", "Server activity decreased"],
    retention_increased: ["新規メンバー定着率が上昇しました", "New-member retention improved"], retention_decreased: ["新規メンバー定着率が低下しました", "New-member retention declined"],
    channel_increased: ["主要チャンネルの活動が増加しました", "A leading channel grew"], channel_decreased: ["主要チャンネルの活動が減少しました", "A leading channel declined"],
    activity_concentrated: ["活動が一部メンバーへ集中しています", "Activity is concentrated"], voice_increased: ["VC活動が増加しました", "Voice activity increased"], voice_decreased: ["VC活動が減少しました", "Voice activity decreased"],
  };
  const recommendationMap: Record<string, [string, string]> = {
    review_activity_drivers: ["減少寄与の大きいチャンネル・時間帯を確認してみてください。", "Consider reviewing the channels and time windows with the largest decline."],
    review_successful_channels: ["伸びたチャンネルの運用パターンを他の場所でも参考にできるか検討してください。", "Consider reviewing whether successful channel patterns are transferable."],
    review_onboarding: ["案内チャンネルや初回投稿までの導線を確認してみてください。", "Consider reviewing onboarding guidance and the path to a first post."],
    review_retained_behaviors: ["定着した参加者に共通する行動傾向を確認してみてください。", "Consider reviewing behaviors associated with retained members."],
    review_channel_context: ["該当チャンネルの予定・話題・権限変更と同時期か確認してください。", "Consider checking whether schedules, topics, or permissions changed in the same period."],
    broaden_participation: ["新規・低頻度メンバーが参加しやすい話題や導線を検討してください。", "Consider ways to make participation easier for new or infrequent members."],
    review_voice_schedule: ["VCの開催時間やイベント有無を同期間で確認してください。", "Consider checking voice schedules and events during the same period."],
  };
  let detail = `${values.current ?? "—"} → ${values.previous ?? "—"}`;
  if (values.percent !== undefined && values.percent !== null) detail = `${values.previous ?? 0} → ${values.current ?? 0} (${values.percent >= 0 ? "+" : ""}${values.percent}%)`;
  if (values.delta !== undefined) detail = `${values.previous ?? 0}% → ${values.current ?? 0}% (${values.delta >= 0 ? "+" : ""}${values.delta}pt)`;
  if (values.name) detail = `#${values.name} · ${values.change?.percent ?? "—"}%`;
  if (values.share !== undefined && !values.name) detail = en ? `Top 10% account for ${values.share}% of messages.` : `上位10%が投稿の${values.share}%を占めています。`;
  return { title: titleMap[insight.titleKey]?.[en ? 1 : 0] ?? insight.titleKey, detail, recommendation: recommendationMap[insight.recommendationKey]?.[en ? 1 : 0] ?? "—" };
}

function ContributorList({ title, rows, en }: { title: string; rows: any[]; en: boolean }) { return <SectionCard title={title}><ContributorRows rows={rows} en={en} /></SectionCard>; }
function ContributorRows({ rows, en }: { rows: any[]; en: boolean }) { return <div className="space-y-2">{rows.slice(0, 7).map((row) => <div key={row.id} className="flex items-center gap-3 rounded-lg bg-secondary/40 px-3 py-2.5 text-sm"><span className="min-w-0 flex-1 truncate font-semibold" title={row.label}>{row.label}</span><span className={row.delta >= 0 ? "text-emerald-400" : "text-rose-400"}>{row.delta >= 0 ? "+" : ""}{row.delta}</span><span className="w-20 text-right text-xs text-muted-foreground">{row.contribution === null ? "—" : `${row.contribution}% ${en ? "share" : "寄与"}`}</span></div>)}{!rows.length && <EmptyState en={en} />}</div>; }
function Heatmap({ values, en }: { values: Array<{ day: number; hour: number; value: number }>; en: boolean }) { const map = new Map(values.map((value) => [`${value.day}-${value.hour}`, value.value])); const max = Math.max(...values.map((value) => value.value), 1); const days = en ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["月", "火", "水", "木", "金", "土", "日"]; return <div className="overflow-x-auto"><div className="grid min-w-[720px] grid-cols-[38px_repeat(24,minmax(20px,1fr))] gap-1 text-[9px]"><span />{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="text-center text-muted-foreground">{hour}</span>)}{days.flatMap((day, index) => [<span key={`${day}-label`} className="self-center text-muted-foreground">{day}</span>, ...Array.from({ length: 24 }, (_, hour) => { const value = map.get(`${index + 1}-${hour}`) ?? 0; return <span key={`${day}-${hour}`} title={`${day} ${hour}:00 · ${value}`} className="aspect-square rounded-sm border border-border/30" style={{ backgroundColor: value ? `color-mix(in srgb, var(--primary) ${Math.max(12, (value / max) * 100)}%, transparent)` : "rgba(120,120,130,.06)" }} />; })])}</div>{!values.length && <p className="mt-3 text-xs text-muted-foreground">{en ? "No activity in the selected channel and period." : "選択チャンネル・期間の活動データがありません。"}</p>}</div>; }
function MiniBars({ rows, en }: { rows: Array<{ label: string; value: number | null }>; en: boolean }) { const max = Math.max(...rows.map((row) => row.value ?? 0), 1); if (!rows.length) return <EmptyState en={en} />; return <div><div className="flex h-36 items-end gap-1">{rows.map((row) => <div key={row.label} title={`${row.label}: ${row.value ?? "—"}`} className="min-w-2 flex-1 rounded-t bg-primary/75" style={{ height: `${Math.max(3, ((row.value ?? 0) / max) * 100)}%` }} />)}</div><div className="mt-2 flex justify-between text-[10px] text-muted-foreground"><span>{rows[0]?.label}</span><span>{rows.at(-1)?.label}</span></div></div>; }
function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <header><p className="text-xs font-black tracking-[.16em] text-primary">{eyebrow}</p><h1 className="mt-1 text-2xl font-black sm:text-3xl">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{description}</p></header>; }
function SectionCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) { return <section className="rounded-2xl border border-border bg-card/55 p-5 sm:p-6"><h2 className="font-bold">{title}</h2>{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}<div className="mt-5">{children}</div></section>; }
function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) { return <div className="rounded-2xl border border-border bg-card/55 p-4"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary [&>svg]:h-4 [&>svg]:w-4">{icon}</div><p className="mt-4 text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-2xl font-black" title={value}>{value}</p>{detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}</div>; }
function SmallStat({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl bg-secondary/45 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-black">{value}</p></div>; }
function Trend({ value }: { value: number | null }) { if (value === null) return <span className="text-muted-foreground">—</span>; return <span className={`inline-flex items-center gap-1 font-bold ${value >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{value >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{value >= 0 ? "+" : ""}{value}%</span>; }
function StatusPill({ value, en }: { value: string; en: boolean }) { return <span className="rounded-full bg-primary/15 px-3 py-1 text-xs font-bold text-primary">{statusLabel(value, en)}</span>; }
function LoadingState({ en }: { en: boolean }) { return <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card/55 p-10 text-sm text-muted-foreground"><LoaderCircle className="h-5 w-5 animate-spin" />{en ? "Aggregating server data…" : "サーバーデータを集計しています…"}</div>; }
function ErrorState({ en }: { en: boolean }) { return <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-6 text-sm text-rose-300">{en ? "Analytics could not be loaded. Please retry shortly." : "分析データを読み込めませんでした。少し待って再試行してください。"}</div>; }
function EmptyState({ en }: { en: boolean }) { return <p className="p-4 text-center text-xs text-muted-foreground">{en ? "No observed data for this selection." : "この条件で観測済みデータがありません。"}</p>; }
function formatRate(rate: number | null, eligible: number, en: boolean) { return rate === null ? (eligible === 0 ? (en ? "Not observed" : "観測期間不足") : (en ? "No data" : "データなし")) : `${rate}%`; }
function eligibleText(eligible: number, en: boolean) { return en ? `${eligible.toLocaleString()} eligible members` : `判定対象 ${eligible.toLocaleString()}人`; }
function formatCount(value: number, en: boolean) { return `${Number(value).toLocaleString()}${en ? "" : "人"}`; }
function formatDuration(seconds: number | null, en: boolean) { if (seconds === null || seconds === undefined) return en ? "No data" : "データなし"; const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); return en ? `${hours}h ${minutes}m` : `${hours}時間${minutes}分`; }
function funnelLabel(key: string, en: boolean) { const labels: Record<string, [string, string]> = { joined: ["参加", "Joined"], first_message: ["初投稿", "First post"], reaction: ["反応", "Reaction"], voice: ["VC参加", "Voice"], day7: ["7日後活動", "Day 7 activity"], day30: ["30日後活動", "Day 30 activity"] }; return labels[key]?.[en ? 1 : 0] ?? key; }
function behaviorLabel(key: string, en: boolean) { const labels: Record<string, [string, string]> = { message: ["メッセージ投稿", "Message posting"], voice: ["VC参加", "Voice participation"], reaction: ["リアクション", "Reaction activity"] }; return labels[key]?.[en ? 1 : 0] ?? key; }
function categoryLabel(key: string, en: boolean) { const labels: Record<string, [string, string]> = { engagement: ["エンゲージメント", "Engagement"], retention: ["定着", "Retention"], distribution: ["活動分布", "Distribution"], voice: ["VC活動", "Voice"], growth: ["成長・安定性", "Growth / stability"] }; return labels[key]?.[en ? 1 : 0] ?? key; }
function confidenceLabel(value: string, en: boolean) { const labels: Record<string, [string, string]> = { high: ["高", "High"], medium: ["中", "Medium"], low: ["低（データ少）", "Low data"] }; return labels[value]?.[en ? 1 : 0] ?? value; }
function availabilityReasonText(health: any, en: boolean) { const reasons = Array.isArray(health.availabilityReasons) ? health.availabilityReasons : [health.availabilityReason].filter(Boolean); const labels: Record<string, [string, string]> = { insufficient_categories: ["利用可能なカテゴリが3つ未満です。", "Fewer than 3 categories are available."], low_confidence: ["Confidenceが40未満です。", "Confidence is below 40."], insufficient_observation_days: ["観測期間が7日未満です。", "Fewer than 7 days have been observed."] }; return reasons.length ? reasons.map((reason: string) => labels[reason]?.[en ? 1 : 0] ?? reason).join(en ? " " : "") : (en ? "More observed data is required." : "正式表示には追加の観測データが必要です。"); }
function statusLabel(value: string, en: boolean) { const labels: Record<string, [string, string]> = { excellent: ["非常に良好", "Excellent"], healthy: ["良好", "Healthy"], fair: ["標準", "Fair"], weak: ["弱め", "Weak"], critical: ["要確認", "Critical"], unavailable: ["算出不可", "Unavailable"], growing: ["成長中", "Growing"], declining: ["減少傾向", "Declining"], inactive: ["非アクティブ", "Inactive"], limited_data: ["データ少", "Limited data"] }; return labels[value]?.[en ? 1 : 0] ?? value; }
function timeZoneDescription(data: AnalyticsData, en: boolean) { return en ? `Displayed in the configured server time zone (${data.range.startDate}–${data.range.endDate})` : `設定タイムゾーンで表示（${data.range.startDate}〜${data.range.endDate}）`; }
