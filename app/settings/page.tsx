"use client";

import {
  Check,
  ChevronLeft,
  Clock3,
  Database,
  Globe2,
  LoaderCircle,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";

const timeZones = [
  ["Asia/Tokyo", "日本（東京）"],
  ["Asia/Seoul", "韓国（ソウル）"],
  ["Asia/Shanghai", "中国（上海）"],
  ["Asia/Singapore", "シンガポール"],
  ["Asia/Bangkok", "タイ（バンコク）"],
  ["Asia/Dubai", "アラブ首長国連邦（ドバイ）"],
  ["Europe/London", "イギリス（ロンドン）"],
  ["Europe/Paris", "フランス（パリ）"],
  ["Europe/Berlin", "ドイツ（ベルリン）"],
  ["America/New_York", "アメリカ（ニューヨーク）"],
  ["America/Chicago", "アメリカ（シカゴ）"],
  ["America/Los_Angeles", "アメリカ（ロサンゼルス）"],
  ["America/Sao_Paulo", "ブラジル（サンパウロ）"],
  ["Australia/Sydney", "オーストラリア（シドニー）"],
  ["Pacific/Auckland", "ニュージーランド（オークランド）"],
] as const;

type Guild = { id: string; name: string };
type HistoryImportJob = {
  id: number;
  days: number;
  mode: "standard" | "developer";
  status: "queued" | "running" | "completed" | "failed";
  processedMessages: number;
  failedChannels: number;
  error: string | null;
};

export default function SettingsPage() {
  const { locale, setLocale } = useLocale();
  const [timeZone, setTimeZone] = useState("Asia/Tokyo");
  const [language, setLanguage] = useState<Locale>("ja");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [historyGuildId, setHistoryGuildId] = useState("");
  const [historyDays, setHistoryDays] = useState(30);
  const [historyDeveloperMode, setHistoryDeveloperMode] = useState(false);
  const [historyJob, setHistoryJob] = useState<HistoryImportJob | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMessage, setHistoryMessage] = useState("");

  useEffect(() => {
    fetch("/api/settings/timezone")
      .then((res) => res.json())
      .then((data) => {
        if (data.timeZone) setTimeZone(data.timeZone);
        if (data.language === "ja" || data.language === "en")
          setLanguage(data.language);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/guilds")
      .then((res) => res.json())
      .then((data) => {
        const nextGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        setGuilds(nextGuilds);
        setHistoryGuildId(nextGuilds[0]?.id ?? "");
      })
      .catch(() => setHistoryMessage("サーバー一覧を取得できませんでした。"));
  }, []);

  useEffect(() => {
    if (!historyGuildId) {
      setHistoryJob(null);
      return;
    }
    let active = true;
    const load = async () => {
      const response = await fetch(
        `/api/history-import?guildId=${encodeURIComponent(historyGuildId)}`,
      );
      const data = await response.json().catch(() => ({}));
      if (active && response.ok) setHistoryJob(data.job ?? null);
    };
    void load();
    const timer = window.setInterval(() => {
      if (historyJob?.status === "queued" || historyJob?.status === "running")
        void load();
    }, 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [historyGuildId, historyJob?.status]);

  const startHistoryImport = async () => {
    if (!historyGuildId) return;
    setHistoryLoading(true);
    setHistoryMessage("");
    const response = await fetch("/api/history-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guildId: historyGuildId,
        days: historyDays,
        mode: historyDeveloperMode ? "developer" : "standard",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) setHistoryJob(data.job);
    else
      setHistoryMessage(data.error ?? "履歴インポートを開始できませんでした。");
    setHistoryLoading(false);
  };

  const save = async () => {
    setSaving(true);
    setSaved("");
    const response = await fetch("/api/settings/timezone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeZone, language }),
    });
    if (response.ok) {
      setLocale(language);
      setSaved(language === "en" ? "Saved" : "保存しました");
    }
    setSaving(false);
  };

  const en = locale === "en";
  const importActive =
    historyJob?.status === "queued" || historyJob?.status === "running";
  const historyStatus =
    historyJob?.status === "queued"
      ? en
        ? "Waiting for the bot to start."
        : "Botの処理待ちです。"
      : historyJob?.status === "running"
        ? en
          ? `${historyJob.processedMessages.toLocaleString()} messages processed…`
          : `${historyJob.processedMessages.toLocaleString()}件を確認中…`
        : historyJob?.status === "completed"
          ? en
            ? `${historyJob.processedMessages.toLocaleString()} messages imported.`
            : `${historyJob.processedMessages.toLocaleString()}件を検索用に取り込みました。`
          : historyJob?.status === "failed"
            ? (historyJob.error ??
              (en ? "Import failed." : "インポートに失敗しました。"))
            : "";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-1/3 top-0 h-96 w-96 rounded-full bg-primary/[0.1] blur-[130px]" />
      </div>
      <section className="relative mx-auto max-w-2xl px-5 py-10 sm:py-16">
        <a
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {en ? "Back to dashboard" : "ダッシュボードに戻る"}
        </a>
        <div className="mt-10 rounded-2xl border border-border bg-card/65 p-6 shadow-2xl shadow-black/10 backdrop-blur-xl sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Globe2 className="h-5 w-5" />
          </div>
          <h1 className="mt-5 text-2xl font-extrabold tracking-tight">
            {en ? "Display settings" : "表示設定"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {en
              ? "These preferences are saved only to your account and never affect other members."
              : "時間帯と言語はあなたのアカウントだけに保存されます。他のメンバーの表示には影響しません。"}
          </p>
          <div className="mt-8 rounded-xl border border-border bg-background/40 p-4">
            <div className="flex gap-3">
              <Globe2 className="mt-0.5 h-5 w-5 text-primary" />
              <div className="flex-1">
                <label htmlFor="language" className="text-sm font-bold">
                  {en ? "Language" : "言語"}
                </label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {en
                    ? "Choose the language used in the dashboard."
                    : "ダッシュボードで使用する言語を選択します。"}
                </p>
                <select
                  id="language"
                  disabled={loading}
                  value={language}
                  onChange={(event) =>
                    setLanguage(event.target.value as Locale)
                  }
                  className="mt-4 h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary"
                >
                  <option value="ja">日本語</option>
                  <option value="en">English</option>
                </select>
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-border bg-background/40 p-4">
            <div className="flex gap-3">
              <Clock3 className="mt-0.5 h-5 w-5 text-primary" />
              <div className="flex-1">
                <label htmlFor="timezone" className="text-sm font-bold">
                  {en ? "Time zone" : "時間帯"}
                </label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {en
                    ? "Activity times use this time zone."
                    : "アクティビティの時刻をこの地域の時刻で表示します。"}
                </p>
                <select
                  id="timezone"
                  disabled={loading}
                  value={timeZone}
                  onChange={(event) => setTimeZone(event.target.value)}
                  className="mt-4 h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary"
                >
                  {timeZones.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-border bg-background/40 p-4">
            <div className="flex gap-3">
              <Database className="mt-0.5 h-5 w-5 text-primary" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-bold">
                  {en ? "Message history import" : "過去メッセージの取り込み"}
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {en
                    ? "Imports messages into server search. Member and voice history are not reconstructed."
                    : "過去メッセージをサーバー内検索に追加します。メンバー推移・通話時間は推測して追加しません。"}
                </p>
                <select
                  disabled={!guilds.length || importActive}
                  value={historyGuildId}
                  onChange={(event) => setHistoryGuildId(event.target.value)}
                  className="mt-4 h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary"
                >
                  {guilds.length ? (
                    guilds.map((guild) => (
                      <option key={guild.id} value={guild.id}>
                        {guild.name}
                      </option>
                    ))
                  ) : (
                    <option>
                      {en
                        ? "No manageable servers"
                        : "管理できるサーバーがありません"}
                    </option>
                  )}
                </select>
                <div className="mt-2 flex gap-2">
                  {[7, 30, 90].map((days) => (
                    <button
                      key={days}
                      disabled={importActive}
                      onClick={() => setHistoryDays(days)}
                      className={`rounded-lg border px-3 py-2 text-xs font-bold ${historyDays === days ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"} disabled:opacity-60`}
                    >
                      {en ? `${days} days` : `過去${days}日`}
                    </button>
                  ))}
                </div>
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/50 p-3 text-left">
                  <input
                    type="checkbox"
                    checked={historyDeveloperMode}
                    disabled={importActive}
                    onChange={(event) =>
                      setHistoryDeveloperMode(event.target.checked)
                    }
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-bold">
                      {en ? "Developer mode" : "開発者モード"}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {en
                        ? "Use up to 3 parallel channel reads on this Bot host. Discord rate limits are still respected automatically."
                        : "最大3チャンネルを並行取得します。Discordの制限時は自動で待機します。"}
                    </span>
                  </span>
                </label>
                <button
                  disabled={
                    !historyGuildId ||
                    importActive ||
                    historyLoading
                  }
                  onClick={() => void startHistoryImport()}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60"
                >
                  {historyLoading || importActive ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Database className="h-4 w-4" />
                  )}
                  {importActive
                    ? en
                      ? "Importing…"
                      : "取り込み中…"
                    : en
                      ? "Start import"
                      : "取り込みを開始"}
                </button>
                <p
                  className={`mt-3 text-xs ${historyJob?.status === "failed" || historyMessage ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {historyMessage ||
                    historyStatus ||
                    (en
                      ? "Only messages in channels the bot can read are included."
                      : "Botが閲覧できるチャンネルのメッセージだけが対象です。")}
                </p>
              </div>
            </div>
          </div>
          <div className="mt-6 flex items-center justify-between gap-4">
            <p className="text-sm text-emerald-400">
              {saved && (
                <span className="inline-flex items-center gap-1">
                  <Check className="h-4 w-4" />
                  {saved}
                </span>
              )}
            </p>
            <button
              disabled={loading || saving}
              onClick={save}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60"
            >
              {saving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {en ? "Save changes" : "保存する"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
