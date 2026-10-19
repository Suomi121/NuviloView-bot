"use client";

import {
  ChevronLeft,
  Clock3,
  Globe2,
  LoaderCircle,
  Save,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import { useSession } from "@/lib/auth-client";
import { AccountLogout } from "@/components/account-logout";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { MessageHistoryImportPanel } from "@/components/message-history-import-panel";

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

export default function SettingsPage() {
  const { locale, setLocale } = useLocale();
  const { data: session } = useSession();
  const sessionUserId = session?.user?.id;
  const [timeZone, setTimeZone] = useState("Asia/Tokyo");
  const [language, setLanguage] = useState<Locale>("ja");
  const [savedTimeZone, setSavedTimeZone] = useState("Asia/Tokyo");
  const [savedLanguage, setSavedLanguage] = useState<Locale>("ja");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [guilds, setGuilds] = useState<Guild[]>([]);

  useEffect(() => {
    fetch("/api/settings/timezone")
      .then((res) => { if (!res.ok) throw new Error("preferences unavailable"); return res.json(); })
      .then((data) => {
        if (data.timeZone) {
          setTimeZone(data.timeZone);
          setSavedTimeZone(data.timeZone);
        }
        if (data.language === "ja" || data.language === "en") {
          setLanguage(data.language);
          setSavedLanguage(data.language);
        }
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!sessionUserId) return;
    let active = true;
    let retryTimer: number | undefined;
    const loadGuilds = async (attempt = 0) => {
      try {
        const response = await fetch("/api/guilds", { cache: "no-store" });
        if (!response.ok) throw new Error("guild request failed");
        const data = await response.json();
        if (!active) return;
        const nextGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        setGuilds(nextGuilds);
        if (nextGuilds.length === 0 && attempt < 2) {
          retryTimer = window.setTimeout(
            () => void loadGuilds(attempt + 1),
            800 * (attempt + 1),
          );
        }
      } catch {
        if (!active) return;
        if (attempt < 2) {
          retryTimer = window.setTimeout(
            () => void loadGuilds(attempt + 1),
            800 * (attempt + 1),
          );
        } else {
          // The import panel will remain disabled while the Guild list is unavailable.
        }
      }
    };
    void loadGuilds();
    return () => {
      active = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [sessionUserId]);

  const save = async () => {
    if (saveInFlight.current || loading || loadError) return;
    saveInFlight.current = true;
    setSaving(true);
    setSaved("");
    setSaveError("");
    // Capture only the preferences submitted by this request. Inputs may change
    // while it is pending; those later edits must remain unsaved.
    const submitted = { timeZone, language };
    try {
      const response = await fetch("/api/settings/timezone", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted),
      });
      if (!response.ok) throw new Error("preferences save failed");
      setLocale(submitted.language);
      setSavedTimeZone(submitted.timeZone);
      setSavedLanguage(submitted.language);
      setSaved(submitted.language === "en" ? "Display settings saved" : "表示設定を保存しました");
    } catch {
      setSaveError(locale === "en" ? "Could not save display settings. Your changes are kept. Please retry." : "表示設定を保存できませんでした。変更内容は保持しています。再試行してください。");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const en = locale === "en";
  const preferencesChanged = timeZone !== savedTimeZone || language !== savedLanguage;

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
            {loadError && <p role="alert" className="mb-3 text-sm text-destructive">{en ? "Could not load display settings. Reload before editing." : "表示設定を読み込めませんでした。再読み込みしてから編集してください。"}</p>}
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
                  disabled={loading || loadError}
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
                  disabled={loading || loadError}
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
          {(preferencesChanged || saved || saveError) && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background/40 p-4" aria-busy={saving}>
            <p role={saveError ? "alert" : "status"} className={`text-sm ${saveError ? "text-destructive" : "text-muted-foreground"}`}>{saveError || (preferencesChanged ? (en ? "You have unsaved display changes" : "表示設定に未保存の変更があります") : saved)}</p>
            {preferencesChanged && <button type="button" disabled={loading || loadError || saving} onClick={() => void save()} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saving ? (en ? "Saving…" : "保存中…") : (en ? "Save display settings" : "表示設定を保存")}</button>}
          </div>}
          <MessageHistoryImportPanel guilds={guilds} locale={locale} />
          <ThemeCustomizer guilds={guilds} />
          {session?.user && <AccountLogout />}
        </div>
      </section>
    </main>
  );
}
