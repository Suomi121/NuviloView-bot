"use client";

import {
  Activity,
  AlertTriangle,
  Database,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale } from "@/components/locale-provider";

type Guild = { id: string; name: string };
type ImportStatus =
  | "queued"
  | "preparing"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "stalled";

type ImportJob = {
  id: number;
  days: number;
  mode: "standard" | "developer";
  version?: number;
  status: ImportStatus;
  processedMessages: number;
  totalChannels?: number;
  completedChannels?: number;
  failedChannels: number;
  skippedChannels?: number;
  fetchedMessages?: number;
  insertedMessages?: number;
  duplicateMessages?: number;
  failedMessages?: number;
  currentChannelId?: string | null;
  safeErrorCode?: string | null;
  safeErrorSummary?: string | null;
  retryState?: string | null;
  retryAfterAt?: string | null;
  lastApiResponseAt?: string | null;
  lastDbWriteAt?: string | null;
  lastProgressAt?: string | null;
  lastWorkerHeartbeatAt?: string | null;
  requestedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  failedAt?: string | null;
  resetAt?: string | null;
  error?: string | null;
};

type ImportChannel = {
  id: number;
  channelId: string;
  channelName: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "skipped" | "cancelled";
  skipReason?: string | null;
  fetchedCount: number;
  insertedCount: number;
  duplicateCount: number;
  failedCount: number;
  retryCount: number;
  safeErrorCode?: string | null;
  safeErrorSummary?: string | null;
  lastProgressAt?: string | null;
};

type ImportState = {
  featureEnabled: boolean;
  job: ImportJob | null;
  channels?: ImportChannel[];
  history?: ImportJob[];
  permissionPreview?: {
    channels: Array<{ channelId: string; channelName: string; canRead: boolean; skipReason?: string | null }>;
    accessible: number;
    skipped: number;
    checkedAt: string | null;
  };
  importedDataCount?: number;
  diagnostics?: {
    discordApi: "healthy" | "waiting";
    database: "healthy" | "waiting";
    worker: "idle" | "running" | "stalled";
    lastApiResponseAt: string | null;
    lastDbWriteAt: string | null;
    lastProgressAt: string | null;
    lastWorkerHeartbeatAt: string | null;
  };
};

const activeStatuses = new Set<ImportStatus>(["queued", "preparing", "running", "pausing", "cancelling"]);
const statusTone: Record<ImportStatus, string> = {
  queued: "bg-sky-500/10 text-sky-300",
  preparing: "bg-sky-500/10 text-sky-300",
  running: "bg-emerald-500/10 text-emerald-300",
  pausing: "bg-amber-500/10 text-amber-300",
  paused: "bg-amber-500/10 text-amber-300",
  cancelling: "bg-amber-500/10 text-amber-300",
  cancelled: "bg-muted text-muted-foreground",
  completed: "bg-emerald-500/10 text-emerald-300",
  failed: "bg-destructive/10 text-destructive",
  stalled: "bg-destructive/10 text-destructive",
};

function formatCount(value: number | undefined) {
  return Math.max(0, Number(value ?? 0)).toLocaleString();
}

function relativeTime(value: string | null | undefined, en: boolean, now: number) {
  if (!value) return en ? "Not yet" : "未確認";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return en ? `${seconds}s ago` : `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return en ? `${minutes}m ago` : `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  return en ? `${hours}h ago` : `${hours}時間前`;
}

function statusLabel(status: ImportStatus, en: boolean) {
  const labels: Record<ImportStatus, [string, string]> = {
    queued: ["Queued", "処理待ち"],
    preparing: ["Preparing", "準備中"],
    running: ["Running", "取り込み中"],
    pausing: ["Pausing", "一時停止中"],
    paused: ["Paused", "一時停止"],
    cancelling: ["Cancelling", "停止処理中"],
    cancelled: ["Cancelled", "停止済み"],
    completed: ["Completed", "完了"],
    failed: ["Failed", "失敗"],
    stalled: ["Stalled", "応答停止"],
  };
  return labels[status]?.[en ? 0 : 1] ?? status;
}

export function MessageHistoryImportPanel({ guilds, locale }: { guilds: Guild[]; locale: Locale }) {
  const en = locale === "en";
  const [guildId, setGuildId] = useState("");
  const [days, setDays] = useState(30);
  const [developerMode, setDeveloperMode] = useState(false);
  const [state, setState] = useState<ImportState | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [message, setMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [sampledAt, setSampledAt] = useState(0);

  useEffect(() => {
    setGuildId((current) => current || guilds[0]?.id || "");
  }, [guilds]);

  const load = useCallback(async (quiet = false) => {
    if (!guildId) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/history-import?guildId=${encodeURIComponent(guildId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Unable to load import state");
      setState(data);
      setSampledAt(Date.now());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (en ? "Unable to load import state." : "取り込み状態を取得できませんでした。"));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [en, guildId]);

  useEffect(() => {
    setState(null);
    setMessage("");
    setPreviewOpen(false);
    setDeleteConfirmation("");
    void load();
  }, [load]);

  useEffect(() => {
    if (!guildId || !state?.job || !activeStatuses.has(state.job.status)) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [guildId, load, state?.job]);

  const mutate = async (nextAction: string, extra: Record<string, unknown> = {}) => {
    if (!guildId) return;
    setAction(nextAction);
    setMessage("");
    try {
      const response = await fetch("/api/history-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: nextAction,
          guildId,
          ...(nextAction === "start" ? { days, mode: developerMode ? "developer" : "standard" } : { jobId: state?.job?.id }),
          ...extra,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Import action failed");
      setPreviewOpen(false);
      setMessage(en ? "Import state updated." : "取り込み状態を更新しました。");
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (en ? "Import action failed." : "操作に失敗しました。"));
    } finally {
      setAction("");
    }
  };

  const deleteImportedData = async () => {
    if (!guildId || deleteConfirmation !== "RESET IMPORTED DATA") return;
    setAction("delete-data");
    setMessage("");
    try {
      const response = await fetch("/api/history-import", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, confirmation: deleteConfirmation }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Delete failed");
      setDeleteConfirmation("");
      setMessage(data.deletionQueued
        ? (en
          ? "Imported-history deletion was queued. The Bot will process it locally."
          : "履歴取り込みデータの削除を受け付けました。Botがローカルで安全に処理します。")
        : (en
          ? `${formatCount(data.deletedCount)} imported messages deleted.`
          : `履歴取り込み由来の${formatCount(data.deletedCount)}件を削除しました。`));
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (en ? "Delete failed." : "削除に失敗しました。"));
    } finally {
      setAction("");
    }
  };

  const job = state?.job ?? null;
  const channels = state?.channels ?? [];
  const currentChannel = channels.find((channel) => channel.channelId === job?.currentChannelId);
  const completedChannelCount = (job?.completedChannels ?? 0) + (job?.skippedChannels ?? 0) + (job?.failedChannels ?? 0);
  const channelProgress = job?.totalChannels ? Math.min(100, Math.round((completedChannelCount / job.totalChannels) * 100)) : null;
  const messagesPerSecond = useMemo(() => {
    if (!job?.startedAt || !job.fetchedMessages) return null;
    const seconds = Math.max(1, (sampledAt - new Date(job.startedAt).getTime()) / 1_000);
    return job.fetchedMessages / seconds;
  }, [job, sampledAt]);
  const importActive = job ? activeStatuses.has(job.status) || job.status === "paused" || job.status === "stalled" : false;
  const canStartNew = !job || ["cancelled", "completed", "failed"].includes(job.status);
  const stalledChannel = channels.find((channel) => channel.channelId === job?.currentChannelId);

  return (
    <div className="mt-4 rounded-xl border border-border bg-background/40 p-4">
      <div className="flex gap-3">
        <Database className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold">Message History Import</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {en
                  ? "Imports messages the Bot can read. Member and voice history are never reconstructed."
                  : "Botが閲覧できる過去メッセージを取り込みます。メンバー推移や通話履歴は推測しません。"}
              </p>
            </div>
            {job && <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${statusTone[job.status]}`}>{statusLabel(job.status, en)}</span>}
          </div>

          <select
            disabled={!guilds.length || importActive || Boolean(action)}
            value={guildId}
            onChange={(event) => setGuildId(event.target.value)}
            className="mt-4 h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary disabled:opacity-60"
          >
            {guilds.length ? guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>) : <option>{en ? "No manageable servers" : "管理できるサーバーがありません"}</option>}
          </select>

          {loading && !state ? (
            <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{en ? "Loading import state…" : "取り込み状態を確認中…"}</div>
          ) : state?.featureEnabled ? (
            <>
              {canStartNew && (
                <div className="mt-4 border-t border-border pt-4">
                  <div className="flex flex-wrap gap-2">
                    {[7, 30, 90, 0].map((value) => (
                      <button key={value} type="button" onClick={() => setDays(value)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${days === value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                        {value === 0 ? (en ? "All time" : "全期間") : (en ? `${value} days` : `過去${value}日`)}
                      </button>
                    ))}
                  </div>
                  {!previewOpen ? (
                    <button type="button" disabled={!guildId || Boolean(action)} onClick={() => setPreviewOpen(true)} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">
                      <ShieldCheck className="h-4 w-4" />{en ? "Review import" : "開始前に確認"}
                    </button>
                  ) : (
                    <div className="mt-4 rounded-lg border border-primary/30 bg-primary/[0.05] p-3">
                      <p className="text-sm font-bold">{en ? "Import preview" : "取り込みプレビュー"}</p>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <span>{en ? "Accessible channels" : "取得可能"}: <strong className="text-foreground">{state.permissionPreview?.accessible ?? 0}</strong></span>
                        <span>{en ? "Skipped channels" : "権限不足"}: <strong className="text-foreground">{state.permissionPreview?.skipped ?? 0}</strong></span>
                      </div>
                      {Boolean(state.permissionPreview?.skipped) && <div className="mt-2 max-h-24 overflow-y-auto rounded-md border border-border bg-background/40 p-2 text-[11px] text-muted-foreground">{state.permissionPreview?.channels.filter((channel) => !channel.canRead).slice(0, 20).map((channel) => <p key={channel.channelId}>#{channel.channelName} · View Channel / Read Message History</p>)}</div>}
                      <p className="mt-2 text-[11px] text-muted-foreground">{en ? "Permissions are checked again by the Bot before import. No message total is guessed." : "開始時にBotが権限を再確認します。総メッセージ数は推測表示しません。"}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" disabled={action === "start"} onClick={() => void mutate("start")} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60">
                          {action === "start" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{en ? "Start" : "開始"}
                        </button>
                        <button type="button" onClick={() => setPreviewOpen(false)} className="rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground">{en ? "Back" : "戻る"}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {job && (
                <div className="mt-5 space-y-5 border-t border-border pt-5">
                  <section>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-bold">{en ? "Channel progress" : "チャンネル進捗"}</span>
                      <span className="text-muted-foreground">{formatCount(completedChannelCount)} / {formatCount(job.totalChannels)}</span>
                    </div>
                    {channelProgress === null ? <p className="mt-2 text-xs text-muted-foreground">{en ? "Preparing the channel list. No estimated percentage is shown." : "チャンネル一覧を準備中です。推定パーセントは表示しません。"}</p> : <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${channelProgress}%` }} /></div>}
                    <p className="mt-2 text-xs text-muted-foreground">{en ? "Current" : "現在"}: <span className="text-foreground">{currentChannel ? `#${currentChannel.channelName}` : (en ? "Waiting" : "待機中")}</span></p>
                  </section>

                  <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      [en ? "Fetched" : "取得", job.fetchedMessages ?? job.processedMessages],
                      [en ? "Inserted" : "保存", job.insertedMessages],
                      [en ? "Duplicates" : "重複", job.duplicateMessages],
                      [en ? "Failed" : "失敗", job.failedMessages],
                    ].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-border bg-card/45 p-3"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 text-lg font-extrabold">{formatCount(value as number)}</p></div>)}
                  </section>

                  <section className="flex flex-wrap gap-2">
                    {["queued", "preparing", "running"].includes(job.status) && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("pause")} className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-300 disabled:opacity-60"><Pause className="h-4 w-4" />{en ? "Pause" : "一時停止"}</button>}
                    {job.status === "paused" && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("resume")} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60"><Play className="h-4 w-4" />{en ? "Resume" : "再開"}</button>}
                    {job.status === "stalled" && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("resume")} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60"><RefreshCw className="h-4 w-4" />{en ? "Retry from checkpoint" : "続きから再試行"}</button>}
                    {["queued", "preparing", "running", "pausing", "paused", "stalled"].includes(job.status) && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("cancel")} className="inline-flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-2 text-xs font-bold text-destructive disabled:opacity-60"><Square className="h-4 w-4" />{en ? "Stop import" : "取り込みを停止"}</button>}
                    {!activeStatuses.has(job.status) && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("reset")} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground disabled:opacity-60"><RotateCcw className="h-4 w-4" />{en ? "Reset import state" : "取り込み状態をリセット"}</button>}
                  </section>
                  {!activeStatuses.has(job.status) && <p className="-mt-3 text-[11px] text-muted-foreground">{en ? "State reset clears checkpoints and errors. It does not delete imported analytics data." : "状態リセットはcheckpointとエラーだけを消します。取り込み済みAnalyticsデータは削除しません。"}</p>}

                  {(job.status === "stalled" || job.safeErrorSummary) && <div className="rounded-lg border border-destructive/30 bg-destructive/[0.05] p-3 text-xs"><p className="font-bold text-destructive">{job.status === "stalled" ? (en ? "Import appears to be stalled." : "取り込みWorkerの応答が止まっています。") : (en ? "Import warning" : "取り込み警告")}</p><p className="mt-1 text-muted-foreground">{job.safeErrorSummary ?? `${en ? "Last progress" : "最終進捗"}: ${relativeTime(job.lastProgressAt, en, sampledAt)}`}</p>{job.status === "stalled" && stalledChannel && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("skip-channel", { channelId: stalledChannel.channelId })} className="mt-2 rounded-lg border border-destructive/35 px-3 py-2 font-bold text-destructive disabled:opacity-60">{en ? `Skip #${stalledChannel.channelName}` : `#${stalledChannel.channelName}をスキップ`}</button>}</div>}

                  <section>
                    <h3 className="text-xs font-bold">{en ? "Channel progress" : "チャンネル別の状況"}</h3>
                    <div className="mt-2 max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                      {channels.length ? channels.map((channel) => (
                        <div key={channel.channelId} className="flex items-start justify-between gap-3 p-3 text-xs">
                          <div className="min-w-0"><p className="truncate font-bold">#{channel.channelName}</p><p className="mt-1 text-muted-foreground">{statusLabel(channel.status as ImportStatus, en)} · {formatCount(channel.fetchedCount)} {en ? "fetched" : "取得"}{channel.safeErrorSummary ? ` · ${channel.safeErrorSummary}` : ""}</p></div>
                          <div className="flex shrink-0 gap-1.5">
                            {channel.status === "failed" && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("retry-channel", { channelId: channel.channelId })} className="rounded-md border border-primary/35 px-2 py-1 font-bold text-primary disabled:opacity-60">{en ? "Retry" : "再試行"}</button>}
                            {["pending", "running", "paused", "failed"].includes(channel.status) && <button type="button" disabled={Boolean(action)} onClick={() => void mutate("skip-channel", { channelId: channel.channelId })} className="rounded-md border border-border px-2 py-1 font-bold text-muted-foreground disabled:opacity-60">{en ? "Skip" : "スキップ"}</button>}
                          </div>
                        </div>
                      )) : <p className="p-3 text-xs text-muted-foreground">{en ? "No channel checkpoints yet." : "チャンネルcheckpointはまだありません。"}</p>}
                    </div>
                  </section>

                  <section>
                    <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h3 className="text-xs font-bold">Diagnostics</h3></div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      {[
                        ["Discord API", state.diagnostics?.discordApi, state.diagnostics?.lastApiResponseAt],
                        ["Database", state.diagnostics?.database, state.diagnostics?.lastDbWriteAt],
                        ["Import Worker", state.diagnostics?.worker, state.diagnostics?.lastWorkerHeartbeatAt],
                      ].map(([label, health, timestamp]) => <div key={String(label)} className="rounded-lg border border-border p-3 text-xs"><p className="font-bold">{label}</p><p className={`mt-1 ${health === "stalled" ? "text-destructive" : health === "healthy" || health === "running" ? "text-emerald-300" : "text-muted-foreground"}`}>{health ?? "waiting"}</p><p className="mt-1 text-[11px] text-muted-foreground">{relativeTime(timestamp, en, sampledAt)}</p></div>)}
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{messagesPerSecond === null ? (en ? "Messages/sec appears after real fetch progress." : "実際に取得が始まると毎秒件数を表示します。") : `${messagesPerSecond.toFixed(1)} messages/sec`}</p>
                  </section>
                </div>
              )}

              <section className="mt-5 border-t border-border pt-5">
                <h3 className="text-xs font-bold">{en ? "Import history" : "取り込み履歴"}</h3>
                <div className="mt-2 space-y-2">
                  {state.history?.length ? state.history.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs"><div className="min-w-0"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${statusTone[item.status]}`}>{statusLabel(item.status, en)}</span><p className="mt-2 text-muted-foreground">{item.requestedAt ? new Date(item.requestedAt).toLocaleString(en ? "en" : "ja-JP") : `Job #${item.id}`}</p>{item.safeErrorSummary && <p className="mt-1 truncate text-destructive">{item.safeErrorSummary}</p>}</div><div className="shrink-0 text-right text-muted-foreground"><p>{formatCount(item.fetchedMessages)} {en ? "fetched" : "取得"}</p><p>{formatCount(item.insertedMessages)} {en ? "inserted" : "保存"}</p></div></div>) : <p className="text-xs text-muted-foreground">{en ? "No import history." : "取り込み履歴はありません。"}</p>}
                </div>
              </section>

              <section className="mt-5 border-t border-destructive/25 pt-5">
                <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-destructive" /><h3 className="text-xs font-bold text-destructive">Danger Zone</h3></div>
                <p className="mt-2 text-xs text-muted-foreground">{en ? `Delete ${formatCount(state.importedDataCount)} history-imported messages. Live data is never selected.` : `履歴取り込み由来の${formatCount(state.importedDataCount)}件だけを削除します。リアルタイム収集データは対象外です。`}</p>
                <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder="RESET IMPORTED DATA" className="mt-3 h-10 w-full rounded-lg border border-destructive/30 bg-card px-3 text-xs outline-none focus:border-destructive" />
                <button type="button" disabled={deleteConfirmation !== "RESET IMPORTED DATA" || !state.importedDataCount || Boolean(action)} onClick={() => void deleteImportedData()} className="mt-2 inline-flex items-center gap-2 rounded-lg border border-destructive/45 bg-destructive/[0.06] px-3 py-2 text-xs font-bold text-destructive disabled:opacity-50"><Trash2 className="h-4 w-4" />{en ? "Delete imported history data" : "履歴取り込みデータを削除"}</button>
              </section>
            </>
          ) : (
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">{en ? "Import v2 is staged off. The existing importer remains available until rollout." : "Import v2は段階導入前のため無効です。正式切替までは既存の取り込みを利用できます。"}</p>
              <div className="mt-3 flex flex-wrap gap-2">{[7, 30, 90, 0].map((value) => <button key={value} type="button" disabled={importActive} onClick={() => setDays(value)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${days === value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>{value === 0 ? (en ? "All time" : "全期間") : (en ? `${value} days` : `過去${value}日`)}</button>)}</div>
              <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={developerMode} disabled={importActive} onChange={(event) => setDeveloperMode(event.target.checked)} className="accent-primary" />{en ? "Legacy developer mode" : "既存の開発者モード"}</label>
              <button type="button" disabled={!guildId || importActive || Boolean(action)} onClick={() => void mutate("start")} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">{action === "start" || importActive ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}{importActive ? (en ? "Importing…" : "取り込み中…") : (en ? "Start import" : "取り込みを開始")}</button>
              {job && <p className="mt-3 text-xs text-muted-foreground">{statusLabel(job.status, en)} · {formatCount(job.processedMessages)} {en ? "processed" : "処理済み"}{job.error ? ` · ${job.error}` : ""}</p>}
            </div>
          )}

          {message && <p className={`mt-4 text-xs ${/failed|unable|invalid|cannot|too many|失敗|できません/i.test(message) ? "text-destructive" : "text-emerald-300"}`}>{message}</p>}
        </div>
      </div>
    </div>
  );
}
