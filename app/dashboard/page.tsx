"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Coffee,
  ChevronDown,
  ChevronRight,
  Download,
  FileJson,
  FileText,
  Hash,
  LayoutDashboard,
  Laptop,
  LineChart,
  MessageSquareText,
  MoreHorizontal,
  Search,
  Settings,
  Sparkles,
  Smartphone,
  Users,
  X,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useLocale } from "@/components/locale-provider";

type Guild = { id: string; name: string; icon: string | null };
type RecentActivity = {
  type: "message" | "member_joined" | "member_left";
  actorName: string;
  channelName: string | null;
  occurredAt: string;
};
type Insight = { title: string; body: string };
type Health = {
  score: number;
  status: string;
  activeLabel: string;
  reactionLabel: string;
  conversationLabel: string;
  retentionLabel: string;
};
type SearchMessage = {
  id: string;
  channelName: string;
  authorName: string;
  content: string;
  createdAt: string;
};
type DashboardNotification = {
  id: number;
  guildId: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
};

const appFeatures = [
  {
    title: "ダッシュボード",
    description: "サーバー全体の分析を表示",
    href: "/dashboard",
  },
  {
    title: "アナリティクス",
    description: "メッセージ・メンバーの推移",
    href: "/dashboard",
  },
  { title: "表示設定", description: "時間帯を変更", href: "/settings" },
  {
    title: "ドキュメント",
    description: "Botとダッシュボードの使い方",
    href: "/docs",
  },
  { title: "サポート", description: "お問い合わせフォーム", href: "/support" },
];

export default function DashboardPage() {
  const { locale } = useLocale();
  const en = locale === "en";
  const router = useRouter();
  const { data: session } = useSession();
  const [period, setPeriod] = useState("過去14日間");
  const [serverOpen, setServerOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildId, setGuildId] = useState<string>("");
  const [chartPoints, setChartPoints] = useState<number[]>([]);
  const [memberPoints, setMemberPoints] = useState<number[]>([]);
  const [activeMemberPoints, setActiveMemberPoints] = useState<number[]>([]);
  const [reactionPoints, setReactionPoints] = useState<number[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [memberCount, setMemberCount] = useState<number>(0);
  const [messageCount, setMessageCount] = useState<number>(0);
  const [totalMessageCount, setTotalMessageCount] = useState<number>(0);
  const [activeMemberCount, setActiveMemberCount] = useState<number>(0);
  const [previousMemberCount, setPreviousMemberCount] = useState<number>(0);
  const [previousActiveMemberCount, setPreviousActiveMemberCount] =
    useState<number>(0);
  const [periodMessageCount, setPeriodMessageCount] = useState<number>(0);
  const [periodReactionRate, setPeriodReactionRate] = useState<number>(0);
  const [previousMessageCount, setPreviousMessageCount] = useState<number>(0);
  const [previousReactionRate, setPreviousReactionRate] = useState<number>(0);
  const [previousMaxVoiceSessionSeconds, setPreviousMaxVoiceSessionSeconds] =
    useState<number>(0);
  const [reactionRate, setReactionRate] = useState<number>(0);
  const [voiceTotalSeconds, setVoiceTotalSeconds] = useState<number>(0);
  const [maxVoiceSessionSeconds, setMaxVoiceSessionSeconds] =
    useState<number>(0);
  const [insight, setInsight] = useState<Insight>({
    title: "データを収集中です",
    body: "Botがデータを記録すると、実績に基づくインサイトを表示します。",
  });
  const [health, setHealth] = useState<Health>({
    score: 0,
    status: "データ収集中",
    activeLabel: "—",
    reactionLabel: "—",
    conversationLabel: "—",
    retentionLabel: "—",
  });
  const [activities, setActivities] = useState<RecentActivity[]>([]);
  const [timeZone, setTimeZone] = useState("Asia/Tokyo");
  const [dataError, setDataError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<"features" | "messages">(
    "features",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [messageResults, setMessageResults] = useState<SearchMessage[]>([]);
  const [searchingMessages, setSearchingMessages] = useState(false);
  const [notifications, setNotifications] = useState<DashboardNotification[]>(
    [],
  );
  const [chartMenuOpen, setChartMenuOpen] = useState(false);
  const [chartMetric, setChartMetric] = useState<
    "messages" | "cumulative" | "members"
  >("messages");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportFormat, setReportFormat] = useState<"csv" | "json" | "pdf">(
    "csv",
  );
  const [reportTarget, setReportTarget] = useState<"computer" | "mobile">(
    "computer",
  );
  const [aiGuideOpen, setAiGuideOpen] = useState(false);
  const [overviewMetric, setOverviewMetric] = useState<
    "members" | "active" | "messages" | "reactions" | "voice"
  >("members");

  const selectedGuild = guilds.find((guild) => guild.id === guildId);
  const userName = session?.user?.name || "Discordユーザー";
  const userInitials = userName.slice(0, 2).toUpperCase();
  const days =
    period === "過去7日間"
      ? 7
      : period === "過去30日間"
        ? 30
        : period === "過去3ヶ月"
          ? 90
          : period === "過去5ヶ月"
            ? 150
            : 14;
  const periodLabel = en
    ? days === 90
      ? "Last 3 months"
      : days === 150
        ? "Last 5 months"
        : `Last ${days} days`
    : period;
  const featureResults = appFeatures.filter((feature) =>
    `${feature.title}${feature.description}`
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
  );

  useEffect(() => {
    if (
      searchMode !== "messages" ||
      !guildId ||
      searchQuery.trim().length < 2
    ) {
      setMessageResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchingMessages(true);
      try {
        const response = await fetch(
          `/api/messages/search?guildId=${encodeURIComponent(guildId)}&q=${encodeURIComponent(searchQuery)}`,
          { signal: controller.signal },
        );
        const data = await response.json();
        setMessageResults(Array.isArray(data.messages) ? data.messages : []);
      } catch {
        if (!controller.signal.aborted) setMessageResults([]);
      } finally {
        if (!controller.signal.aborted) setSearchingMessages(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [guildId, searchMode, searchQuery]);

  useEffect(() => {
    fetch("/api/settings/timezone")
      .then((res) => res.json())
      .then((data) => {
        if (data.timeZone) setTimeZone(data.timeZone);
      });
    fetch("/api/guilds")
      .then((res) => res.json())
      .then((data) => {
        const nextGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        setGuilds(nextGuilds);
        setGuildId(nextGuilds[0]?.id ?? "");
      })
      .catch(() => setDataError("サーバー一覧を取得できませんでした。"));
    fetch("/api/notifications")
      .then((res) => res.json())
      .then((data) =>
        setNotifications(
          Array.isArray(data.notifications) ? data.notifications : [],
        ),
      )
      .catch(() => {});
  }, []);

  const dismissNotification = async (id: number) => {
    setNotifications((current) =>
      current.filter((notification) => notification.id !== id),
    );
    try {
      await fetch(`/api/notifications/${id}`, { method: "DELETE" });
    } catch {
      /* It will return on the next reload if deletion failed. */
    }
  };

  useEffect(() => {
    if (!guildId) return;
    setDataError(null);
    fetch(
      `/backend/status?guildId=${encodeURIComponent(guildId)}&days=${days}&locale=${locale}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error("stats request failed");
        return res.json();
      })
      .then((data) => {
        setChartPoints(Array.isArray(data.chartPoints) ? data.chartPoints : []);
        setMemberPoints(
          Array.isArray(data.memberPoints) ? data.memberPoints : [],
        );
        setActiveMemberPoints(
          Array.isArray(data.activeMemberPoints) ? data.activeMemberPoints : [],
        );
        setReactionPoints(
          Array.isArray(data.reactionPoints) ? data.reactionPoints : [],
        );
        setLabels(Array.isArray(data.labels) ? data.labels : []);
        setMemberCount(Number(data.latestMemberCount) || 0);
        setMessageCount(Number(data.latestMessageCount) || 0);
        setTotalMessageCount(Number(data.totalMessageCount) || 0);
        setActiveMemberCount(Number(data.activeMemberCount) || 0);
        setPreviousMemberCount(Number(data.previousMemberCount) || 0);
        setPreviousActiveMemberCount(
          Number(data.previousActiveMemberCount) || 0,
        );
        setPeriodMessageCount(Number(data.periodMessageCount) || 0);
        setPeriodReactionRate(Number(data.periodReactionRate) || 0);
        setPreviousMessageCount(Number(data.previousMessageCount) || 0);
        setPreviousReactionRate(Number(data.previousReactionRate) || 0);
        setPreviousMaxVoiceSessionSeconds(
          Number(data.previousMaxVoiceSessionSeconds) || 0,
        );
        setReactionRate(Number(data.reactionRate) || 0);
        setVoiceTotalSeconds(Number(data.voiceTotalSeconds) || 0);
        setMaxVoiceSessionSeconds(Number(data.maxVoiceSessionSeconds) || 0);
        if (data.insight?.title && data.insight?.body) setInsight(data.insight);
        if (data.health) setHealth(data.health);
        setActivities(Array.isArray(data.activities) ? data.activities : []);
      })
      .catch(() => setDataError("分析データを取得できませんでした。"));
  }, [guildId, days, locale]);

  const displayedChartPoints = useMemo(() => {
    if (chartMetric === "members") return memberPoints;
    if (chartMetric === "cumulative")
      return chartPoints.reduce<number[]>(
        (points, point) => [...points, (points.at(-1) ?? 0) + point],
        [],
      );
    return chartPoints;
  }, [chartMetric, chartPoints, memberPoints]);
  const chartCopy =
    chartMetric === "messages"
      ? {
          title: en ? "Message trend" : "メッセージの推移",
          description: en
            ? `Daily messages collected by the bot · ${periodLabel}`
            : `Botが収集した日別メッセージ数 · ${period}`,
        }
      : chartMetric === "cumulative"
        ? {
            title: en ? "Cumulative messages" : "累積メッセージ",
            description: en
              ? `Messages accumulated during the selected period · ${periodLabel}`
              : `選択期間内の累積メッセージ数 · ${period}`,
          }
        : {
            title: en ? "Member trend" : "メンバー数の推移",
            description: en
              ? `Daily member counts recorded by the bot · ${periodLabel}`
              : `Botが記録した日別メンバー数 · ${period}`,
          };

  const exportReport = async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      guild: selectedGuild?.name ?? (en ? "Unknown server" : "不明なサーバー"),
      period: periodLabel,
      summary: {
        memberCount,
        messageCount,
        activeMemberCount,
        reactionRate,
        voiceTotalSeconds,
        maxVoiceSessionSeconds,
      },
      dailyTrend: labels.map((label, index) => ({
        date: label,
        messages: chartPoints[index] ?? 0,
        members: memberPoints[index] ?? 0,
      })),
    };
    const safeName =
      (selectedGuild?.name ?? "server")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "server";
    const filename = `nuviloview-report-${safeName}-${new Date().toISOString().slice(0, 10)}`;
    if (reportFormat === "pdf") {
      const reportWindow = window.open("", "_blank", "noopener,noreferrer");
      if (!reportWindow) return;
      reportWindow.document.write(
        `<!doctype html><html><head><title>${filename}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#171717}h1{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f4f4f5}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:20px}.card{border:1px solid #ddd;border-radius:10px;padding:12px}.label{font-size:12px;color:#666}.value{font-size:22px;font-weight:700;margin-top:4px}</style></head><body><h1>NuviloView:OEM Report</h1><p>${report.guild} · ${report.period}</p><div class="grid"><div class="card"><div class="label">${en ? "Members" : "メンバー数"}</div><div class="value">${memberCount}</div></div><div class="card"><div class="label">${en ? "Messages" : "メッセージ数"}</div><div class="value">${messageCount}</div></div><div class="card"><div class="label">${en ? "Total voice time" : "合計通話時間"}</div><div class="value">${formatDuration(voiceTotalSeconds, locale)}</div></div></div><table><thead><tr><th>${en ? "Date" : "日付"}</th><th>${en ? "Messages" : "メッセージ"}</th><th>${en ? "Members" : "メンバー"}</th></tr></thead><tbody>${report.dailyTrend.map((row) => `<tr><td>${row.date}</td><td>${row.messages}</td><td>${row.members}</td></tr>`).join("")}</tbody></table><script>window.onload=()=>window.print()</script></body></html>`,
      );
      reportWindow.document.close();
      setReportOpen(false);
      return;
    }
    const content =
      reportFormat === "json"
        ? JSON.stringify(report, null, 2)
        : [
            "date,messages,members",
            ...report.dailyTrend.map(
              (row) => `${row.date},${row.messages},${row.members}`,
            ),
          ].join("\n");
    const mimeType =
      reportFormat === "json" ? "application/json" : "text/csv;charset=utf-8";
    const blob = new Blob(
      [reportFormat === "csv" ? `\uFEFF${content}` : content],
      { type: mimeType },
    );
    const file = new File([blob], `${filename}.${reportFormat}`, {
      type: mimeType,
    });
    if (
      reportTarget === "mobile" &&
      navigator.canShare?.({ files: [file] }) &&
      navigator.share
    ) {
      await navigator
        .share({ files: [file], title: "NuviloView:OEM Report" })
        .catch(() => undefined);
    } else {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    setReportOpen(false);
  };

  // グラフの縦軸は実数に対応させる。1,000以上の値があれば必ず1,000刻み。
  const chart = useMemo(() => {
    const maxValue = Math.max(...displayedChartPoints, 0);
    const tickStep =
      maxValue >= 1_000
        ? 1_000
        : Math.max(1, Math.ceil(Math.max(maxValue, 4) / 4 / 10) * 10);
    const scaleMax = Math.max(tickStep, Math.ceil(maxValue / tickStep) * tickStep);
    const ticks = Array.from(
      { length: Math.floor(scaleMax / tickStep) + 1 },
      (_, index) => {
        const value = index * tickStep;
        return { value, y: 92 - (value / scaleMax) * 75 };
      },
    );

    if (!displayedChartPoints.length)
      return {
        line: "M 0 92 L 100 92",
        area: "M 0 92 L 100 92 L 100 100 L 0 100 Z",
        last: { x: 100, y: 92 },
        ticks,
      };

    const coordinates = displayedChartPoints.map((point, index) => ({
      x: (index / Math.max(displayedChartPoints.length - 1, 1)) * 100,
      y: 92 - (Math.max(point, 0) / scaleMax) * 75,
    }));
    const line = coordinates
      .map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`)
      .join(" ");
    return {
      line,
      area: `${line} L 100 100 L 0 100 Z`,
      last: coordinates.at(-1)!,
      ticks,
    };
  }, [displayedChartPoints]);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-24 h-96 w-96 rounded-full bg-primary/[0.08] blur-[130px]" />
        <div className="absolute right-0 top-1/3 h-80 w-80 rounded-full bg-violet-500/[0.06] blur-[120px]" />
      </div>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-border/70 bg-card/45 px-4 py-5 backdrop-blur-xl lg:flex lg:flex-col">
        <a href="/" className="mb-9 flex items-center gap-2.5 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Coffee className="h-[18px] w-[18px]" strokeWidth={2.25} />
          </span>
          <span className="text-base font-bold tracking-tight">
            NuviloView<span className="text-primary">:OEM</span>
          </span>
        </a>
        <div className="relative mb-7">
          <button
            onClick={() => setServerOpen(!serverOpen)}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/55 px-3 py-3 text-left transition-colors hover:bg-secondary"
          >
            <GuildAvatar guild={selectedGuild} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {selectedGuild?.name ?? "サーバーを選択"}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {memberCount.toLocaleString()} メンバー
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${serverOpen ? "rotate-180" : ""}`}
            />
          </button>
          {serverOpen && (
            <div className="absolute inset-x-0 top-[52px] z-20 max-h-64 overflow-auto rounded-xl border border-border bg-card p-1.5 text-sm shadow-2xl">
              {guilds.map((guild) => (
                <button
                  key={guild.id}
                  onClick={() => {
                    setGuildId(guild.id);
                    setServerOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-secondary"
                >
                  <GuildAvatar guild={guild} size="small" />
                  <span className="truncate">{guild.name}</span>
                </button>
              ))}
              {guilds.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  管理できるサーバーがありません
                </p>
              )}
            </div>
          )}
        </div>
        <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.14em] text-muted-foreground">
          {en ? "OVERVIEW" : "概要"}
        </p>
        <nav className="space-y-1">
          <NavItem
            active
            icon={<LayoutDashboard />}
            label={en ? "Dashboard" : "ダッシュボード"}
          />
          <NavItem
            icon={<LineChart />}
            label={en ? "Analytics" : "アナリティクス"}
          />
          <NavItem icon={<Users />} label={en ? "Members" : "メンバー"} />
          <NavItem
            icon={<MessageSquareText />}
            label={en ? "Messages" : "メッセージ"}
          />
        </nav>
        <p className="mb-2 mt-7 px-3 text-[10px] font-bold tracking-[0.14em] text-muted-foreground">
          MANAGE
        </p>
        <nav className="space-y-1">
          <NavItem
            icon={<Sparkles />}
            label={en ? "Growth insights" : "成長インサイト"}
          />
          <NavItem
            icon={<Settings />}
            label={en ? "Settings" : "設定"}
            href="/settings"
          />
        </nav>
      </aside>

      <div className="relative lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/70 bg-background/75 px-5 backdrop-blur-xl sm:px-8">
          <a href="/" className="flex items-center gap-2 lg:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Coffee className="h-[18px] w-[18px]" strokeWidth={2.25} />
            </span>
            <span className="font-bold">
              NuviloView<span className="text-primary">:OEM</span>
            </span>
          </a>
          <div className="relative hidden max-w-sm flex-1 lg:block">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label="検索"
              value={searchQuery}
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchOpen(true);
              }}
              placeholder={
                searchMode === "features"
                  ? "機能を検索..."
                  : "メッセージを検索..."
              }
              className="h-9 w-full rounded-lg border border-border bg-card/60 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
            {searchOpen && (
              <div className="absolute left-0 top-11 z-50 w-[440px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
                <div className="flex border-b border-border p-1.5">
                  <button
                    onClick={() => setSearchMode("features")}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold ${searchMode === "features" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                  >
                    機能を検索
                  </button>
                  <button
                    onClick={() => setSearchMode("messages")}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold ${searchMode === "messages" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                  >
                    メッセージを検索
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto p-2">
                  {searchMode === "features" ? (
                    featureResults.map((feature) => (
                      <button
                        key={feature.title}
                        onClick={() => {
                          router.push(feature.href);
                          setSearchOpen(false);
                        }}
                        className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-secondary"
                      >
                        <p className="text-sm font-semibold">{feature.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {feature.description}
                        </p>
                      </button>
                    ))
                  ) : searchQuery.trim().length < 2 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      2文字以上入力すると、{selectedGuild?.name ?? "サーバー"}
                      内を検索します。
                    </p>
                  ) : searchingMessages ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      検索中...
                    </p>
                  ) : messageResults.length ? (
                    messageResults.map((message) => (
                      <div key={message.id} className="rounded-lg px-3 py-2.5">
                        <div className="flex gap-2 text-xs">
                          <span className="font-bold text-foreground">
                            {message.authorName}
                          </span>
                          <span className="text-muted-foreground">
                            #{message.channelName} ·{" "}
                            {formatActivityTime(message.createdAt, timeZone)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {message.content}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      該当するメッセージはありません。
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => setAiGuideOpen(true)}
            className="ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/35 bg-primary/10 px-3 text-xs font-bold text-primary transition-colors hover:bg-primary/20"
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI
          </button>
          <a
            href="/settings"
            aria-label={en ? "Settings" : "設定"}
            className="ml-1 inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-bold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <Settings className="h-3.5 w-3.5" />
            {en ? "Settings" : "設定"}
          </a>
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={() => setNoticeOpen(!noticeOpen)}
              aria-label={en ? "Open notifications" : "通知を開く"}
              className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Bell className="h-5 w-5" />
              {notifications.length > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border-2 border-background bg-primary" />
              )}
            </button>
            {noticeOpen && (
              <div className="absolute right-20 top-14 z-50 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <p className="text-sm font-bold">
                    {en ? "Notifications" : "通知"}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {notifications.length}
                    {en ? "" : "件"}
                  </span>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length ? (
                    notifications.map((notification) => (
                      <div
                        key={notification.id}
                        className="group border-b border-border/70 px-4 py-3 last:border-0"
                      >
                        <div className="flex gap-3">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">
                              {notification.title}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              {notification.body}
                            </p>
                            <p className="mt-1.5 text-[11px] text-muted-foreground">
                              {formatActivityTime(
                                notification.createdAt,
                                timeZone,
                              )}
                            </p>
                          </div>
                          <button
                            onClick={() => dismissNotification(notification.id)}
                            aria-label={
                              en ? "Dismiss notification" : "通知を削除"
                            }
                            className="h-7 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 hover:bg-secondary hover:text-foreground"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                      {en
                        ? "No new notifications."
                        : "新しい通知はありません。"}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold">{userName}</p>
              <p className="text-[11px] text-muted-foreground">
                {en ? "Server owner" : "サーバーオーナー"}
              </p>
            </div>
            {session?.user?.image ? (
              <img
                src={session.user.image}
                alt=""
                className="h-9 w-9 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-violet-600 text-xs font-bold">
                {userInitials}
              </div>
            )}
          </div>
        </header>

        <section className="mx-auto max-w-[1440px] px-5 py-8 sm:px-8 lg:py-10">
          <div className="relative mb-3 lg:hidden">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label={en ? "Search" : "検索"}
                value={searchQuery}
                onFocus={() => setSearchOpen(true)}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchOpen(true);
                }}
                placeholder={
                  searchMode === "features"
                    ? en
                      ? "Search features..."
                      : "機能を検索..."
                    : en
                      ? "Search messages..."
                      : "メッセージを検索..."
                }
                className="h-11 w-full rounded-xl border border-border bg-card/70 pl-10 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
              {searchOpen && (
                <div className="absolute left-0 top-12 z-50 w-full overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
                  <div className="flex border-b border-border p-1.5">
                    <button
                      onClick={() => setSearchMode("features")}
                      className={`flex-1 rounded-lg px-2 py-2 text-xs font-bold ${searchMode === "features" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                    >
                      {en ? "Features" : "機能を検索"}
                    </button>
                    <button
                      onClick={() => setSearchMode("messages")}
                      className={`flex-1 rounded-lg px-2 py-2 text-xs font-bold ${searchMode === "messages" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                    >
                      {en ? "Messages" : "メッセージを検索"}
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto p-2">
                    {searchMode === "features" ? (
                      featureResults.map((feature) => (
                        <button
                          key={feature.title}
                          onClick={() => {
                            router.push(feature.href);
                            setSearchOpen(false);
                          }}
                          className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-secondary"
                        >
                          <p className="text-sm font-semibold">
                            {feature.title}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {feature.description}
                          </p>
                        </button>
                      ))
                    ) : searchQuery.trim().length < 2 ? (
                      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {en
                          ? `Enter at least 2 characters to search ${selectedGuild?.name ?? "this server"}.`
                          : `2文字以上入力すると、${selectedGuild?.name ?? "サーバー"}内を検索します。`}
                      </p>
                    ) : searchingMessages ? (
                      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {en ? "Searching..." : "検索中..."}
                      </p>
                    ) : messageResults.length ? (
                      messageResults.map((message) => (
                        <div
                          key={message.id}
                          className="rounded-lg px-3 py-2.5"
                        >
                          <div className="flex gap-2 text-xs">
                            <span className="font-bold text-foreground">
                              {message.authorName}
                            </span>
                            <span className="text-muted-foreground">
                              #{message.channelName} ·{" "}
                              {formatActivityTime(message.createdAt, timeZone)}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {message.content}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {en
                          ? "No matching messages."
                          : "該当するメッセージはありません。"}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="relative mb-6 lg:hidden">
            <button
              onClick={() => setServerOpen(!serverOpen)}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/70 px-3 py-3 text-left transition-colors hover:bg-secondary"
            >
              <GuildAvatar guild={selectedGuild} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {selectedGuild?.name ?? "サーバーを選択"}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {memberCount.toLocaleString()} メンバー
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${serverOpen ? "rotate-180" : ""}`}
              />
            </button>
            {serverOpen && (
              <div className="absolute inset-x-0 top-[56px] z-20 max-h-64 overflow-auto rounded-xl border border-border bg-card p-1.5 text-sm shadow-2xl">
                {guilds.map((guild) => (
                  <button
                    key={guild.id}
                    onClick={() => {
                      setGuildId(guild.id);
                      setServerOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left hover:bg-secondary"
                  >
                    <GuildAvatar guild={guild} size="small" />
                    <span className="truncate">{guild.name}</span>
                  </button>
                ))}
                {guilds.length === 0 && (
                  <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                    管理できるサーバーがありません。Discordでサーバーオーナー、または「サーバー管理」権限を持つアカウントでログインしてください。
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
                <Activity className="h-3.5 w-3.5" />
                {en ? "Updating live data" : "ライブデータを更新中"}
              </div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
                {en
                  ? `Welcome back, ${userName}`
                  : `おかえりなさい、${userName}さん`}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {en
                  ? "Your community is growing steadily today."
                  : "コミュニティは今日も順調に成長しています。"}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setReportOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3.5 py-2 text-sm font-medium hover:bg-secondary"
              >
                <Download className="h-4 w-4" />
                {en ? "Report" : "レポート"}
              </button>
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                className="rounded-lg border border-border bg-card/60 px-3.5 py-2 text-sm font-medium outline-none"
              >
                <option value="過去7日間">
                  {en ? "Last 7 days" : "過去7日間"}
                </option>
                <option value="過去14日間">
                  {en ? "Last 14 days" : "過去14日間"}
                </option>
                <option value="過去30日間">
                  {en ? "Last 30 days" : "過去30日間"}
                </option>
                <option value="過去3ヶ月">
                  {en ? "Last 3 months" : "過去3ヶ月"}
                </option>
                <option value="過去5ヶ月">
                  {en ? "Last 5 months" : "過去5ヶ月"}
                </option>
              </select>
            </div>
          </div>

          {dataError && (
            <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {dataError}
            </p>
          )}
          {aiGuideOpen && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-5">
              <section
                role="dialog"
                aria-modal="true"
                aria-label="ローカルAIアシスタント"
                className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <h2 className="mt-4 text-xl font-extrabold">
                      {en ? "Local AI Assistant" : "ローカルAIアシスタント"}
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {en
                        ? "Use your own Gemini or OpenAI API key in NuviloView Companion. Keys and conversations are never stored by NuviloView."
                        : "NuviloView Companionで、ご自身のGeminiまたはOpenAI APIキーを使います。キーと会話はNuviloViewに保存されません。"}
                    </p>
                  </div>
                  <button
                    onClick={() => setAiGuideOpen(false)}
                    aria-label={en ? "Close" : "閉じる"}
                    className="rounded-lg p-2 hover:bg-secondary"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <a
                  href="nuviloview://ai"
                  onClick={() => setAiGuideOpen(false)}
                  className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground"
                >
                  <Sparkles className="h-4 w-4" />
                  {en ? "Open AI in Companion" : "CompanionでAIを開く"}
                </a>
                <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                  {en
                    ? "Companion must be installed and running on this PC."
                    : "このPCにNuviloView Companionが必要です。"}
                </p>
              </section>
            </div>
          )}
          {reportOpen && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-5">
              <section
                role="dialog"
                aria-modal="true"
                className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-extrabold">
                      {en ? "Export report" : "レポートを保存"}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {en
                        ? "Choose a format and where to save it."
                        : "保存する形式と端末を選択してください。"}
                    </p>
                  </div>
                  <button
                    onClick={() => setReportOpen(false)}
                    aria-label={en ? "Close" : "閉じる"}
                    className="rounded-lg p-2 hover:bg-secondary"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="mt-6">
                  <p className="text-sm font-bold">{en ? "Format" : "形式"}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    <button
                      onClick={() => setReportFormat("csv")}
                      className={`rounded-xl border p-3 text-left ${reportFormat === "csv" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    >
                      <FileText className="h-5 w-5 text-primary" />
                      <p className="mt-2 text-sm font-bold">CSV</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {en ? "For spreadsheets" : "Excel・表計算向け"}
                      </p>
                    </button>
                    <button
                      onClick={() => setReportFormat("json")}
                      className={`rounded-xl border p-3 text-left ${reportFormat === "json" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    >
                      <FileJson className="h-5 w-5 text-primary" />
                      <p className="mt-2 text-sm font-bold">JSON</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {en ? "For backups" : "バックアップ向け"}
                      </p>
                    </button>
                    <button
                      onClick={() => setReportFormat("pdf")}
                      className={`rounded-xl border p-3 text-left ${reportFormat === "pdf" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    >
                      <FileText className="h-5 w-5 text-primary" />
                      <p className="mt-2 text-sm font-bold">PDF</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {en ? "For sharing" : "共有・印刷向け"}
                      </p>
                    </button>
                  </div>
                </div>
                <div className="mt-6">
                  <p className="text-sm font-bold">
                    {en ? "Save to" : "保存先"}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setReportTarget("computer")}
                      className={`flex items-center gap-2 rounded-xl border p-3 text-left text-sm font-bold ${reportTarget === "computer" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    >
                      <Laptop className="h-5 w-5 text-primary" />
                      {en ? "Computer" : "PC"}
                    </button>
                    <button
                      onClick={() => setReportTarget("mobile")}
                      className={`flex items-center gap-2 rounded-xl border p-3 text-left text-sm font-bold ${reportTarget === "mobile" ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    >
                      <Smartphone className="h-5 w-5 text-primary" />
                      {en ? "Mobile" : "スマホ"}
                    </button>
                  </div>
                </div>
                <div className="mt-7 flex justify-end gap-2">
                  <button
                    onClick={() => setReportOpen(false)}
                    className="rounded-lg px-4 py-2.5 text-sm font-bold hover:bg-secondary"
                  >
                    {en ? "Cancel" : "キャンセル"}
                  </button>
                  <button
                    onClick={() => void exportReport()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground"
                  >
                    <Download className="h-4 w-4" />
                    {reportFormat === "pdf"
                      ? en
                        ? "Open print dialog"
                        : "印刷画面を開く"
                      : en
                        ? "Save report"
                        : "保存する"}
                  </button>
                </div>
              </section>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label={en ? "Total members" : "総メンバー数"}
              value={memberCount.toLocaleString()}
              delta={en ? "Live" : "ライブ"}
              icon={<Users />}
              onClick={() => setOverviewMetric("members")}
              selected={overviewMetric === "members"}
            />
            <StatCard
              label={en ? "Active members" : "アクティブメンバー"}
              value={activeMemberCount.toLocaleString()}
              delta={en ? "Unique speakers today" : "今日のユニーク発言者"}
              icon={<Activity />}
              onClick={() => setOverviewMetric("active")}
              selected={overviewMetric === "active"}
            />
            <StatCard
              label={en ? "Total messages" : "総送信数"}
              value={totalMessageCount.toLocaleString()}
              delta={en ? "Stored messages" : "保存済みメッセージ"}
              icon={<MessageSquareText />}
              onClick={() => setOverviewMetric("messages")}
              selected={overviewMetric === "messages"}
            />
            <StatCard
              label={en ? "Average reaction rate" : "平均リアクション率"}
              value={`${reactionRate.toFixed(1)}%`}
              delta={en ? "Reactions ÷ messages" : "リアクション ÷ メッセージ"}
              icon={<Sparkles />}
              onClick={() => setOverviewMetric("reactions")}
              selected={overviewMetric === "reactions"}
            />
            <StatCard
              label={en ? "Total voice time" : "合計通話時間"}
              value={formatDuration(voiceTotalSeconds, locale)}
              delta={periodLabel}
              icon={<Coffee />}
            />
            <StatCard
              label={en ? "Longest voice session" : "最高連続通話時間"}
              value={formatDuration(maxVoiceSessionSeconds, locale)}
              delta={en ? "Continuous server activity" : "サーバー内の連続通話"}
              icon={<Activity />}
              onClick={() => setOverviewMetric("voice")}
              selected={overviewMetric === "voice"}
            />
          </div>
          <OverviewComparison
            metric={overviewMetric}
            memberCount={memberCount}
            previousMemberCount={previousMemberCount}
            activeMemberCount={activeMemberCount}
            previousActiveMemberCount={previousActiveMemberCount}
            periodMessageCount={periodMessageCount}
            previousMessageCount={previousMessageCount}
            periodReactionRate={periodReactionRate}
            previousReactionRate={previousReactionRate}
            maxVoiceSessionSeconds={maxVoiceSessionSeconds}
            previousMaxVoiceSessionSeconds={previousMaxVoiceSessionSeconds}
            memberPoints={memberPoints}
            activeMemberPoints={activeMemberPoints}
            messagePoints={chartPoints}
            reactionPoints={reactionPoints}
            periodLabel={periodLabel}
            locale={locale}
            en={en}
          />

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(280px,0.75fr)]">
            <section className="rounded-2xl border border-border bg-card/55 p-5 shadow-sm sm:p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-bold">{chartCopy.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {chartCopy.description}
                  </p>
                </div>
                <div className="relative">
                  <button
                    onClick={() => setChartMenuOpen(!chartMenuOpen)}
                    aria-label="グラフの表示を変更"
                    className="rounded-lg p-2 text-muted-foreground hover:bg-secondary"
                  >
                    <MoreHorizontal className="h-5 w-5" />
                  </button>
                  {chartMenuOpen && (
                    <div className="absolute right-0 top-10 z-10 w-48 rounded-xl border border-border bg-card p-1.5 text-sm shadow-xl">
                      {(
                        [
                          ["messages", "日別メッセージ"],
                          ["cumulative", "累積メッセージ"],
                          ["members", "メンバー推移"],
                        ] as const
                      ).map(([metric, label]) => (
                        <button
                          key={metric}
                          onClick={() => {
                            setChartMetric(metric);
                            setChartMenuOpen(false);
                          }}
                          className={`w-full rounded-lg px-3 py-2 text-left ${chartMetric === metric ? "bg-primary/15 text-primary" : "hover:bg-secondary"}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-7 flex h-60">
                <div className="relative h-full w-12 shrink-0 text-right text-[10px] text-muted-foreground">
                  {chart.ticks.map((tick) => (
                    <span
                      key={tick.value}
                      className="absolute right-2 -translate-y-1/2"
                      style={{ top: `${tick.y}%` }}
                    >
                      {tick.value.toLocaleString()}
                    </span>
                  ))}
                </div>
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="h-full min-w-0 flex-1 overflow-visible"
                >
                  <defs>
                    <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="currentColor"
                        stopOpacity="0.36"
                      />
                      <stop
                        offset="100%"
                        stopColor="currentColor"
                        stopOpacity="0"
                      />
                    </linearGradient>
                  </defs>
                  {chart.ticks.map((tick) => (
                    <line
                      key={tick.value}
                      x1="0"
                      x2="100"
                      y1={tick.y}
                      y2={tick.y}
                      stroke="currentColor"
                      strokeOpacity="0.1"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <path
                    d={chart.area}
                    fill="url(#area)"
                    className="text-primary"
                  />
                  <path
                    d={chart.line}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-primary"
                  />
                  <circle
                    cx={chart.last.x}
                    cy={chart.last.y}
                    r="2.1"
                    fill="currentColor"
                    className="text-primary"
                  />
                </svg>
              </div>
              <div className="mt-3 flex justify-between text-[11px] text-muted-foreground">
                {labels.length ? (
                  labels.map((label) => <span key={label}>{label}</span>)
                ) : (
                  <span>Botがデータを記録すると推移が表示されます</span>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card/55 p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-bold">
                    {en ? "Server health" : "サーバーヘルス"}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {en ? "Current community status" : "現在のコミュニティ状態"}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-bold ${health.status === "良好" || health.status === "Good" ? "bg-emerald-400/10 text-emerald-400" : health.status === "注意" || health.status === "Caution" ? "bg-amber-400/10 text-amber-400" : "bg-muted text-muted-foreground"}`}
                >
                  {health.status}
                </span>
              </div>
              <div className="mt-6 flex items-center gap-5">
                <div
                  className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: `conic-gradient(#7877ff 0deg ${health.score * 3.6}deg, rgba(255,255,255,.08) ${health.score * 3.6}deg)`,
                  }}
                >
                  <div className="flex h-[76px] w-[76px] flex-col items-center justify-center rounded-full bg-card">
                    <span className="text-xl font-extrabold">
                      {health.score}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      / 100
                    </span>
                  </div>
                </div>
                <div className="space-y-3 text-xs">
                  <HealthItem
                    label={en ? "Speakers today" : "今日の発言者"}
                    value={health.activeLabel}
                  />
                  <HealthItem
                    label={en ? "Reaction rate" : "リアクション率"}
                    value={health.reactionLabel}
                  />
                  <HealthItem
                    label={en ? "Conversation trend" : "会話の推移"}
                    value={health.conversationLabel}
                  />
                  <HealthItem
                    label={en ? "Joins & leaves (7 days)" : "7日間の入退室"}
                    value={health.retentionLabel}
                  />
                </div>
              </div>
            </section>
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <section className="rounded-2xl border border-border bg-card/55 p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-bold">
                    {en ? "Recent activity" : "最近のアクティビティ"}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {en
                      ? "Latest events recorded by the bot"
                      : "Botが記録した最新イベント"}
                  </p>
                </div>
                <span className="text-xs font-semibold text-primary">
                  {timeZone}
                </span>
              </div>
              <div className="mt-5 space-y-4">
                {activities.length ? (
                  activities.map((activity, index) => (
                    <div
                      key={`${activity.occurredAt}-${index}`}
                      className="flex items-center gap-3"
                    >
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[10px] font-bold ${activity.type === "member_left" ? "from-rose-400 to-orange-500" : activity.type === "member_joined" ? "from-emerald-400 to-teal-600" : "from-violet-400 to-indigo-600"}`}
                      >
                        {activity.actorName.slice(0, 2)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex gap-2 text-sm">
                          <span className="font-semibold">
                            {activity.actorName}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatActivityTime(activity.occurredAt, timeZone)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {activity.type === "message"
                            ? en
                              ? `${activity.channelName ? `#${activity.channelName}` : "channel"} sent a message`
                              : `${activity.channelName ? `#${activity.channelName}` : "チャンネル"} にメッセージを送信`
                            : activity.type === "member_joined"
                              ? en
                                ? "Joined the server"
                                : "サーバーに参加しました"
                              : en
                                ? "Left the server"
                                : "サーバーを退出しました"}
                        </p>
                      </div>
                      <Hash className="h-4 w-4 text-muted-foreground/60" />
                    </div>
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    {en
                      ? "Events after the bot starts will appear here."
                      : "Botが起動後に発生したイベントがここに表示されます。"}
                  </p>
                )}
              </div>
            </section>
            <section className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.16] to-card/60 p-5 sm:p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Sparkles className="h-5 w-5" />
              </div>
              <p className="mt-4 text-xs font-bold tracking-wider text-primary">
                LIVE INSIGHT
              </p>
              <h2 className="mt-1 font-bold">
                {en && insight.title === "データを収集中です"
                  ? "Collecting data"
                  : insight.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {en &&
                insight.body ===
                  "Botがデータを記録すると、実績に基づくインサイトを表示します。"
                  ? "Insights will appear when the bot has recorded data."
                  : insight.body}
              </p>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  href = "#",
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  href?: string;
}) {
  return (
    <a
      href={href}
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${active ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
    >
      <span className={active ? "text-primary" : ""}>{icon}</span>
      {label}
    </a>
  );
}

function GuildAvatar({
  guild,
  size = "normal",
}: {
  guild?: Guild;
  size?: "normal" | "small";
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const dimensions =
    size === "small" ? "h-7 w-7 text-[10px]" : "h-8 w-8 text-xs";
  const initials = (guild?.name || "VC").trim().slice(0, 2).toUpperCase();
  const iconUrl =
    guild?.icon && !imageFailed
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
      : null;

  if (iconUrl)
    return (
      <img
        src={iconUrl}
        alt=""
        onError={() => setImageFailed(true)}
        className={`${dimensions} shrink-0 rounded-lg object-cover`}
      />
    );
  return (
    <span
      aria-label={guild?.name ?? "サーバー"}
      className={`flex ${dimensions} shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 font-bold text-white`}
    >
      {initials}
    </span>
  );
}

function StatCard({
  label,
  value,
  delta,
  icon,
  onClick,
  selected = false,
}: {
  label: string;
  value: string;
  delta: string;
  icon: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  const { locale } = useLocale();
  const content = (
    <>
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className="rounded-lg bg-primary/[0.12] p-2 text-primary">
          {icon}
        </span>
      </div>
      <p className="mt-5 text-3xl font-extrabold tracking-tight">{value}</p>
      <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-emerald-400">
        <ArrowUpRight className="h-3.5 w-3.5" />
        {delta}
        <span className="ml-1 font-normal text-muted-foreground">
          {locale === "en" ? "vs. previous period" : "前期間比"}
        </span>
      </p>
    </>
  );
  const className = `rounded-2xl border bg-card/55 p-5 text-left shadow-sm transition-colors ${selected ? "border-primary/70 bg-primary/[0.08]" : "border-border"} ${onClick ? "cursor-pointer hover:border-primary/40 hover:bg-card" : ""}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  ) : (
    <section className={className}>{content}</section>
  );
}

function OverviewComparison({
  metric,
  memberCount,
  previousMemberCount,
  activeMemberCount,
  previousActiveMemberCount,
  periodMessageCount,
  previousMessageCount,
  periodReactionRate,
  previousReactionRate,
  maxVoiceSessionSeconds,
  previousMaxVoiceSessionSeconds,
  memberPoints,
  activeMemberPoints,
  messagePoints,
  reactionPoints,
  periodLabel,
  locale,
  en,
}: {
  metric: "members" | "active" | "messages" | "reactions" | "voice";
  memberCount: number;
  previousMemberCount: number;
  activeMemberCount: number;
  previousActiveMemberCount: number;
  periodMessageCount: number;
  previousMessageCount: number;
  periodReactionRate: number;
  previousReactionRate: number;
  maxVoiceSessionSeconds: number;
  previousMaxVoiceSessionSeconds: number;
  memberPoints: number[];
  activeMemberPoints: number[];
  messagePoints: number[];
  reactionPoints: number[];
  periodLabel: string;
  locale: "ja" | "en";
  en: boolean;
}) {
  const config =
    metric === "members"
      ? {
          title: en ? "Member comparison" : "メンバー数の比較",
          currentLabel: en ? "Members today" : "今日の総メンバー",
          previousLabel: en ? "Before this period" : "前期間の総メンバー",
          current: memberCount,
          previous: previousMemberCount,
          points: memberPoints,
          format: (value: number) => value.toLocaleString(),
        }
      : metric === "active"
        ? {
            title: en ? "Active member comparison" : "アクティブメンバーの比較",
            currentLabel: en ? "Active today" : "今日のアクティブメンバー",
            previousLabel: en
              ? "Previous period"
              : "前期間のアクティブメンバー",
            current: activeMemberCount,
            previous: previousActiveMemberCount,
            points: activeMemberPoints,
            format: (value: number) => value.toLocaleString(),
          }
        : metric === "messages"
          ? {
              title: en ? "Message comparison" : "送信メッセージの比較",
              currentLabel: en ? "Selected period" : "選択期間の送信メッセージ",
              previousLabel: en ? "Previous period" : "前期間の送信メッセージ",
              current: periodMessageCount,
              previous: previousMessageCount,
              points: messagePoints,
              format: (value: number) => value.toLocaleString(),
            }
          : metric === "reactions"
            ? {
                title: en
                  ? "Reaction rate comparison"
                  : "平均リアクション率の比較",
                currentLabel: en
                  ? "Selected period"
                  : "選択期間の平均リアクション率",
                previousLabel: en
                  ? "Previous period"
                  : "前期間の平均リアクション率",
                current: periodReactionRate,
                previous: previousReactionRate,
                points: reactionPoints,
                format: (value: number) => `${value.toFixed(1)}%`,
              }
            : {
                title: en
                  ? "Longest voice session comparison"
                  : "最高連続通話時間の比較",
                currentLabel: en ? "Selected period" : "選択期間の最高連続通話",
                previousLabel: en ? "Previous period" : "前期間の最高連続通話",
                current: maxVoiceSessionSeconds,
                previous: previousMaxVoiceSessionSeconds,
                points: [],
                format: (value: number) => formatDuration(value, locale),
              };
  const {
    title,
    currentLabel,
    previousLabel,
    current,
    previous,
    points,
    format,
  } = config;
  const max = Math.max(current, previous, ...points, 1);
  const change = current - previous;
  return (
    <section className="mt-4 rounded-2xl border border-border bg-card/55 p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {en
              ? `Current value compared with the previous ${periodLabel.toLowerCase()}.`
              : `選択中の${periodLabel}と前期間を実データで比較します。`}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${change >= 0 ? "bg-emerald-400/10 text-emerald-400" : "bg-rose-400/10 text-rose-400"}`}
        >
          {change >= 0 ? "+" : ""}
          {metric === "voice"
            ? formatDuration(Math.abs(change), locale)
            : metric === "reactions"
              ? `${change.toFixed(1)}%`
              : change.toLocaleString()}
        </span>
      </div>
      <div className="mt-5 grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
        <div className="grid grid-cols-2 gap-3">
          <ComparisonBar
            label={previousLabel}
            value={previous}
            displayValue={format(previous)}
            max={max}
            muted
          />
          <ComparisonBar
            label={currentLabel}
            value={current}
            displayValue={format(current)}
            max={max}
          />
        </div>
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-muted-foreground">
              {en ? "Trend in selected period" : "選択期間の推移"}
            </span>
            <span className="text-muted-foreground">{periodLabel}</span>
          </div>
          <div className="mt-3 flex h-28 items-end gap-1.5 rounded-xl border border-border/70 bg-background/30 p-3">
            {points.length ? (
              points.map((point, index) => (
                <span
                  key={index}
                  className="min-w-0 flex-1 rounded-t-sm bg-primary/70 transition-opacity hover:bg-primary"
                  style={{ height: `${Math.max(5, (point / max) * 100)}%` }}
                  title={format(point)}
                />
              ))
            ) : (
              <span className="m-auto text-xs text-muted-foreground">
                {en
                  ? "Comparison shown at left"
                  : "左側の比較グラフで表示中です"}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ComparisonBar({
  label,
  value,
  displayValue,
  max,
  muted = false,
}: {
  label: string;
  value: number;
  displayValue: string;
  max: number;
  muted?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/30 p-3">
      <p className="min-h-8 text-[11px] leading-4 text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-extrabold">{displayValue}</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={
            muted
              ? "h-full rounded-full bg-muted-foreground/50"
              : "h-full rounded-full bg-primary"
          }
          style={{ width: `${Math.max(4, (value / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function HealthItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-bold text-emerald-400">{value}</span>
    </div>
  );
}

function formatActivityTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(totalSeconds: number, locale: "ja" | "en") {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (locale === "en")
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  if (hours > 0) return `${hours}時間${minutes}分`;
  return `${minutes}分`;
}
