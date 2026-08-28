"use client";

import { AlertTriangle, CheckCircle2, Database } from "lucide-react";

export type ProjectionReadMeta = {
  available: boolean;
  provider: string | null;
  freshness: "fresh" | "stale" | "very_stale" | "unavailable";
  degraded: boolean;
  truncated?: boolean;
  lastUpdatedAt: number | null;
  nextUpdateAt: number | null;
  limitations?: string[];
  rawAnalyticsQueries?: number;
};

function providerName(provider: string | null) {
  if (provider === "supabase") return "Supabase";
  if (provider === "turso") return "Turso";
  if (provider === "neon") return "Neon compatibility";
  return "Unavailable";
}

function limitationLabel(value: string, en: boolean) {
  const labels: Record<string, [string, string]> = {
    bot_filter_not_projected: ["Bot除外はProjection v1では未対応", "Bot exclusion is not projected in v1"],
    role_filter_not_projected: ["ロール絞り込みはProjection v1では未対応", "Role filtering is not projected in v1"],
    hourly_heatmap_not_projected: ["時間別ヒートマップは未集約", "Hourly heatmaps are not projected"],
    event_time_role_breakdown_not_projected: ["発言時点ロール内訳は未集約", "Event-time role breakdown is not projected"],
    subday_onboarding_not_projected: ["1時間単位の初動分析は未集約", "Sub-day onboarding is not projected"],
    projection_row_limit_reached: ["Projection行上限に達したため一部集計です", "Projection row limit reached; totals are partial"],
    channel_names_not_projected: ["チャンネル名は未集約のためID表示です", "Channel names are not projected; IDs are shown"],
  };
  const label = labels[value];
  return label ? label[en ? 1 : 0] : value;
}

export function ProjectionReadNotice({
  meta,
  locale,
  compact = false,
}: {
  meta: ProjectionReadMeta | null;
  locale: "ja" | "en";
  compact?: boolean;
}) {
  if (!meta) return null;
  const en = locale === "en";
  const healthy = meta.available && meta.freshness === "fresh" && !meta.degraded;
  const Icon = healthy ? CheckCircle2 : AlertTriangle;
  const updated = meta.lastUpdatedAt
    ? new Intl.DateTimeFormat(en ? "en-US" : "ja-JP", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(meta.lastUpdatedAt)
    : null;
  const message = healthy
    ? (en
        ? `Fresh Projection from ${providerName(meta.provider)}`
        : `${providerName(meta.provider)} の最新Projectionを表示中`)
    : meta.freshness === "stale" || meta.freshness === "very_stale"
      ? (en
          ? `Cloud Analytics is degraded. Showing an older ${providerName(meta.provider)} snapshot.`
          : `Cloud分析が劣化中です。${providerName(meta.provider)} の古いスナップショットを表示しています。`)
      : (en
          ? "Analytics data is temporarily unavailable. No current snapshot is being shown."
          : "分析データを一時的に取得できません。現在のスナップショットは表示していません。");
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 text-xs ${healthy ? "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-200" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{message}</p>
        {!compact && (
          <p className="mt-1 text-[11px] opacity-75">
            <Database className="mr-1 inline h-3 w-3" />
            {updated
              ? (en ? `Last projection: ${updated}` : `最終Projection: ${updated}`)
              : (en ? "No last-known timestamp" : "最終更新時刻なし")}
            {meta.rawAnalyticsQueries === 0
              ? (en ? " · Raw Cloud analytics queries: 0" : "・Raw Cloud分析クエリ: 0")
              : ""}
          </p>
        )}
        {!compact && Boolean(meta.limitations?.length) && (
          <p className="mt-1 text-[11px] opacity-75">
            {meta.limitations?.map((item) => limitationLabel(item, en)).join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
}
