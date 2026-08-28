"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bell,
  Coffee,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  FileJson,
  FileText,
  Hash,
  LayoutDashboard,
  Laptop,
  LineChart,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Target,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useLocale } from "@/components/locale-provider";
import { defaultGuildTheme, guildThemeStyle, type GuildTheme } from "@/lib/guild-theme";
import { buildDashboardPrintReportHtml } from "@/lib/dashboard-report-utils.mjs";
import { CommunityAnalyticsDashboard, type CommunityAnalyticsView } from "@/components/community-analytics-dashboard";
import { ProjectionReadNotice, type ProjectionReadMeta } from "@/components/projection-read-notice";
import { RuntimeProviderStatus } from "@/components/runtime-provider-status";

type Guild = { id: string; name: string; icon: string | null };
type RecentActivity = {
  type: "message" | "member_joined" | "member_left";
  actorName: string;
  channelName: string | null;
  occurredAt: string;
};
type Insight = { title: string; body: string };
type InsightCard = Insight & {
  kind: "channel" | "time" | "members" | "engagement";
};
type Health = {
  score: number;
  status: string;
  activeLabel: string;
  reactionLabel: string;
  conversationLabel: string;
  retentionLabel: string;
};
type BotStatus = {
  lastRecordedAt: string | null;
  lastPermissionCheckAt: string | null;
  unreadableChannelCount: number;
  unreadableChannelNames: string[];
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
type ChannelInsight = {
  channelName: string;
  messageCount: number;
  previousMessageCount: number;
};
type GoalType = "member_growth" | "messages" | "voice_seconds";
type GrowthGoal = { type: GoalType; target: number; current: number };
type DashboardLoadState = "idle" | "loading" | "refreshing" | "success" | "error";
type DataCoverage = {
  statsDays: number;
  messageDays: number;
  insightRequiredDays: number;
  insightRemainingDays: number;
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isDeveloper, setIsDeveloper] = useState(false);

  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildId, setGuildId] = useState<string>("");
  const [authorizedGuildId, setAuthorizedGuildId] = useState<string>("");
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
  const [insightCards, setInsightCards] = useState<InsightCard[]>([]);
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
  const [botStatus, setBotStatus] = useState<BotStatus>({
    lastRecordedAt: null,
    lastPermissionCheckAt: null,
    unreadableChannelCount: 0,
    unreadableChannelNames: [],
  });
  const [lastLiveRefreshAt, setLastLiveRefreshAt] = useState<number | null>(
    null,
  );
  const [analyticsReadMeta, setAnalyticsReadMeta] = useState<ProjectionReadMeta | null>(null);
  const [isGuildLoading, setIsGuildLoading] = useState(false);
  const [loadState, setLoadState] = useState<DashboardLoadState>("idle");
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [coverage, setCoverage] = useState<DataCoverage>({
    statsDays: 0,
    messageDays: 0,
    insightRequiredDays: 10,
    insightRemainingDays: 10,
  });
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
    "messages" | "cumulative" | "members" | "inactiveMembers"
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
    "members" | "active" | "inactive" | "activeMessages" | "messages" | "reactions" | "voice"
  >("members");
  const [activeView, setActiveView] = useState<"overview" | "analytics" | "members" | "messages" | CommunityAnalyticsView>("overview");
  const [guildTheme, setGuildTheme] = useState<GuildTheme>(defaultGuildTheme);
  const [channelInsights, setChannelInsights] = useState<ChannelInsight[]>([]);
  const [goals, setGoals] = useState<GrowthGoal[]>([]);
  const [goalTargets, setGoalTargets] = useState<Record<GoalType, string>>({
    member_growth: "", messages: "", voice_seconds: "",
  });
  const [savingGoals, setSavingGoals] = useState(false);

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
  const previousPeriodLabel = en
    ? days === 90
      ? "Previous 3 months"
      : days === 150
        ? "Previous 5 months"
        : `Previous ${days} days`
    : period.replace(/^過去/, "直前の");
  const comparisonCaption = en
    ? `Compared with ${previousPeriodLabel.toLowerCase()}`
    : `${previousPeriodLabel}との比較`;
  const memberChange = memberCount - previousMemberCount;
  const activeMemberChange = activeMemberCount - previousActiveMemberCount;
  const inactiveMemberCount = Math.max(0, memberCount - activeMemberCount);
  const inactiveMemberStartIndex = memberPoints.findIndex((point) => point > 0);
  const inactiveMemberPoints = useMemo(
    () => inactiveMemberStartIndex < 0
      ? []
      : memberPoints
          .slice(inactiveMemberStartIndex)
          .map((point, index) => Math.max(0, point - (activeMemberPoints[inactiveMemberStartIndex + index] ?? 0))),
    [activeMemberPoints, inactiveMemberStartIndex, memberPoints],
  );
  const inactiveMemberLabels = inactiveMemberStartIndex < 0 ? [] : labels.slice(inactiveMemberStartIndex);
  const previousInactiveMemberCount = inactiveMemberPoints.at(-2) ?? inactiveMemberCount;
  const inactiveMemberChange = inactiveMemberCount - previousInactiveMemberCount;
  const previousDayMessageCount = chartPoints.at(-2) ?? 0;
  const activeMessageChange = messageCount - previousDayMessageCount;
  const reactionChange = periodReactionRate - previousReactionRate;
  const voiceSessionChange = maxVoiceSessionSeconds - previousMaxVoiceSessionSeconds;
  const dashboardPending = loadState === "loading";
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
    if (!session?.user) return;
    let active = true;
    let retryTimer: number | undefined;
    fetch("/api/settings/timezone")
      .then((res) => res.json())
      .then((data) => {
        if (active && data.timeZone) setTimeZone(data.timeZone);
      });
    const loadGuilds = async (attempt = 0) => {
      try {
        const response = await fetch("/api/guilds", { cache: "no-store" });
        if (!response.ok) throw new Error("guild request failed");
        const data = await response.json();
        if (!active) return;
        const nextGuilds = Array.isArray(data.guilds) ? data.guilds : [];
        setGuilds(nextGuilds);
        // Do not silently use the first server. The selected server controls
        // the analytics and personal per-server theme, so the user chooses it.
        setGuildId((current) =>
          nextGuilds.some((guild: Guild) => guild.id === current) ? current : "",
        );
        // The guild-list request populates the short-lived authorization
        // cache. Load notifications afterwards so both endpoints do not hit
        // Discord simultaneously on a cold page load.
        void fetch("/api/notifications")
          .then((res) => res.json())
          .then((notificationData) =>
            active &&
            setNotifications(
              Array.isArray(notificationData.notifications)
                ? notificationData.notifications
                : [],
            ),
          )
          .catch(() => {});
        // Better Auth may finish saving the Discord account immediately after
        // the redirect. Retry only the initial empty result to avoid making
        // people refresh after their first login.
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
        }
      }
    };
    void loadGuilds();
    return () => {
      active = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [en, session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) {
      setIsDeveloper(false);
      return;
    }
    let active = true;
    fetch("/api/developer/guilds", { cache: "no-store" })
      .then((response) => {
        if (active) setIsDeveloper(response.ok);
      })
      .catch(() => {
        if (active) setIsDeveloper(false);
      });
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!guildId || authorizedGuildId !== guildId) {
      setGuildTheme(defaultGuildTheme);
      return;
    }
    let active = true;
    fetch(`/api/settings/theme?guildId=${encodeURIComponent(guildId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (active && data?.theme) setGuildTheme(data.theme);
      })
      .catch(() => {
        if (active) setGuildTheme(defaultGuildTheme);
      });
    return () => { active = false; };
  }, [authorizedGuildId, guildId]);

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

  const loadGoals = async (selectedGuildId: string) => {
    const response = await fetch(`/api/goals?guildId=${encodeURIComponent(selectedGuildId)}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const nextGoals = Array.isArray(data.goals) ? data.goals as GrowthGoal[] : [];
    setGoals(nextGoals);
    setGoalTargets({
      member_growth: String(nextGoals.find((goal) => goal.type === "member_growth")?.target ?? ""),
      messages: String(nextGoals.find((goal) => goal.type === "messages")?.target ?? ""),
      voice_seconds: String(Math.round((nextGoals.find((goal) => goal.type === "voice_seconds")?.target ?? 0) / 3600) || ""),
    });
  };

  const saveGoals = async () => {
    if (!guildId || savingGoals) return;
    const numberOf = (type: GoalType) => Math.max(0, Math.floor(Number(goalTargets[type]) || 0));
    setSavingGoals(true);
    try {
      const response = await fetch("/api/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guildId,
          goals: [
            { type: "member_growth", target: numberOf("member_growth") },
            { type: "messages", target: numberOf("messages") },
            { type: "voice_seconds", target: numberOf("voice_seconds") * 3600 },
          ],
        }),
      });
      if (response.ok) await loadGoals(guildId);
    } finally {
      setSavingGoals(false);
    }
  };

  const downloadActivityCard = async () => {
    if (!selectedGuild) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1600; canvas.height = 900;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, 1600, 900);
    gradient.addColorStop(0, "#0c0d16"); gradient.addColorStop(.55, "#181a31"); gradient.addColorStop(1, "#312452");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const glow = ctx.createRadialGradient(1360, 100, 10, 1360, 100, 560); glow.addColorStop(0, "rgba(116,130,255,.46)"); glow.addColorStop(1, "rgba(116,130,255,0)"); ctx.fillStyle = glow; ctx.fillRect(0, 0, 1600, 900);
    ctx.fillStyle = "#7584ff"; ctx.fillRect(0, 0, 18, canvas.height);
    ctx.beginPath(); ctx.roundRect(92, 66, 70, 70, 18); ctx.fillStyle = "#6677ff"; ctx.fill();
    ctx.font = "800 36px sans-serif"; ctx.fillStyle = "#fff"; ctx.fillText("☕", 108, 114);
    ctx.font = "700 25px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#9da8ff"; ctx.fillText("NUVILOVIEW:OEM  /  ACTIVITY SNAPSHOT", 186, 108);
    // Fit the real server name by width, rather than cutting at an arbitrary
    // character count. Only extremely long names receive a visible ellipsis.
    let title = selectedGuild.name;
    let titleSize = 64;
    ctx.font = `800 ${titleSize}px 'Yu Gothic', sans-serif`;
    while (ctx.measureText(title).width > 1350 && titleSize > 38) {
      titleSize -= 2;
      ctx.font = `800 ${titleSize}px 'Yu Gothic', sans-serif`;
    }
    if (ctx.measureText(title).width > 1350) {
      const characters = Array.from(title);
      while (characters.length > 1 && ctx.measureText(`${characters.join("")}…`).width > 1350) characters.pop();
      title = `${characters.join("")}…`;
    }
    ctx.fillStyle = "#ffffff"; ctx.fillText(title, 92, 220);
    ctx.font = "400 27px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#b7bacb"; ctx.fillText(`${periodLabel}の活動実績  •  ${new Date().toLocaleDateString("ja-JP")}`, 94, 268);
    const cards = [
      ["メンバー", `${memberCount.toLocaleString()}人`],
      ["メッセージ", `${periodMessageCount.toLocaleString()}件`],
      ["通話時間", formatDuration(voiceTotalSeconds, locale)],
      ["アクティブ", `${activeMemberCount.toLocaleString()}人`],
    ];
    cards.forEach(([label, value], index) => {
      const x = 92 + (index % 2) * 545; const y = 350 + Math.floor(index / 2) * 190;
      ctx.fillStyle = "rgba(255,255,255,.085)"; ctx.beginPath(); ctx.roundRect(x, y, 490, 142, 24); ctx.fill();
      ctx.font = "700 25px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#b7bcdd"; ctx.fillText(label, x + 36, y + 55);
      ctx.font = "800 46px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#ffffff"; ctx.fillText(value, x + 36, y + 112);
    });
    const points = chartPoints.length ? chartPoints : [0, 0]; const max = Math.max(...points, 1); const graphX = 1190; const graphY = 352; const graphW = 310; const graphH = 330;
    ctx.font = "700 22px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#c5c9ff"; ctx.fillText("MESSAGE TREND", graphX, graphY);
    ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 2; [0, .5, 1].forEach((i) => { ctx.beginPath(); ctx.moveTo(graphX, graphY + 40 + graphH * i); ctx.lineTo(graphX + graphW, graphY + 40 + graphH * i); ctx.stroke(); });
    ctx.beginPath(); points.forEach((point, index) => { const x = graphX + (index / Math.max(points.length - 1, 1)) * graphW; const y = graphY + 40 + graphH - (point / max) * graphH; index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = "#8492ff"; ctx.lineWidth = 7; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
    ctx.beginPath(); ctx.roundRect(92, 750, 1408, 76, 18); ctx.fillStyle = "rgba(255,255,255,.06)"; ctx.fill();
    const hasShareableInsight = !["データを収集中です", "Collecting data"].includes(insight.title);
    ctx.font = "700 22px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#a9adbf"; ctx.fillText(hasShareableInsight ? `SERVER INSIGHT  /  ${insight.title}` : "NUVILOVIEW:OEM  /  ACTIVITY SNAPSHOT", 122, 799);
    ctx.font = "500 19px 'Yu Gothic', sans-serif"; ctx.fillStyle = "#888da4"; ctx.fillText("メッセージ本文・個人情報は含まれていません", 690, 799);
    // Keep Japanese and emoji in the download name; remove only characters
    // Windows does not allow in a filename and keep it comfortably short.
    const safeGuildName = selectedGuild.name.normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 48) || "server";
    canvas.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `nuviloview-${safeGuildName}-snapshot.png`; link.click(); URL.revokeObjectURL(url); }, "image/png");
  };

  const switchGuild = (nextGuildId: string) => {
    if (nextGuildId === guildId) return;
    setGuildId(nextGuildId);
    setAuthorizedGuildId("");
    // Never leave another server's values on screen while the new request is
    // in flight. The selected name changes immediately and the cards reset.
    setIsGuildLoading(true);
    setLoadState("loading");
    setChartPoints([]); setMemberPoints([]); setActiveMemberPoints([]); setReactionPoints([]); setLabels([]);
    setMemberCount(0); setMessageCount(0); setTotalMessageCount(0); setActiveMemberCount(0);
    setPreviousMemberCount(0); setPreviousActiveMemberCount(0); setPeriodMessageCount(0);
    setPeriodReactionRate(0); setPreviousMessageCount(0); setPreviousReactionRate(0); setReactionRate(0);
    setPreviousMaxVoiceSessionSeconds(0);
    setVoiceTotalSeconds(0); setMaxVoiceSessionSeconds(0); setActivities([]); setChannelInsights([]);
    setInsight({
      title: en ? "Collecting data" : "データを収集中です",
      body: en
        ? "Insights will appear after the bot records data."
        : "Botがデータを記録すると、実績に基づくインサイトを表示します。",
    });
    setInsightCards([]);
    setHealth({
      score: 0,
      status: en ? "Collecting data" : "データ収集中",
      activeLabel: "—",
      reactionLabel: "—",
      conversationLabel: "—",
      retentionLabel: "—",
    });
    setBotStatus({
      lastRecordedAt: null,
      lastPermissionCheckAt: null,
      unreadableChannelCount: 0,
      unreadableChannelNames: [],
    });
    setGoals([]);
    setGoalTargets({ member_growth: "", messages: "", voice_seconds: "" });
    setCoverage({ statsDays: 0, messageDays: 0, insightRequiredDays: 10, insightRemainingDays: 10 });
    setLastLiveRefreshAt(null);
    setAnalyticsReadMeta(null);
  };

  useEffect(() => {
    if (!guildId || authorizedGuildId !== guildId) {
      setGoals([]);
      return;
    }
    void loadGoals(guildId);
  }, [authorizedGuildId, guildId]);

  useEffect(() => {
    if (!guildId) return;
    let active = true;
    let loading = false;
    let nextRefreshAt = 0;
    let refreshTimer: number | null = null;
    const scheduleNext = (requestedAt: number) => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      nextRefreshAt = Math.max(Date.now() + 1_000, requestedAt);
      refreshTimer = window.setTimeout(() => {
        if (active && document.visibilityState === "visible") void load("auto");
      }, nextRefreshAt - Date.now());
    };
    const load = async (reason: "initial" | "auto") => {
      if (loading) return;
      loading = true;
      if (active) {
        setLoadState(reason === "auto" ? "refreshing" : "loading");
        if (reason === "initial") setIsGuildLoading(true);
      }
      try {
        const response = await fetch(
          `/backend/status?guildId=${encodeURIComponent(guildId)}&days=${days}&locale=${locale}&timeZone=${encodeURIComponent(timeZone)}&requestAt=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("stats request failed");
        const data = await response.json();
        if (!active) return;
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
        setInsightCards(
          Array.isArray(data.insightCards)
            ? data.insightCards.filter(
                (card: unknown): card is InsightCard =>
                  Boolean(card) &&
                  typeof card === "object" &&
                  typeof (card as InsightCard).title === "string" &&
                  typeof (card as InsightCard).body === "string",
              )
            : [],
        );
        setChannelInsights(Array.isArray(data.channelInsights) ? data.channelInsights : []);
        setCoverage({
          statsDays: Number(data.coverage?.statsDays) || 0,
          messageDays: Number(data.coverage?.messageDays) || 0,
          insightRequiredDays: Number(data.coverage?.insightRequiredDays) || 10,
          insightRemainingDays: Math.max(0, Number(data.coverage?.insightRemainingDays) || 0),
        });
        if (data.health) setHealth(data.health);
        setActivities(Array.isArray(data.activities) ? data.activities : []);
        setBotStatus({
          lastRecordedAt:
            typeof data.botStatus?.lastRecordedAt === "string"
              ? data.botStatus.lastRecordedAt
              : null,
          lastPermissionCheckAt:
            typeof data.botStatus?.lastPermissionCheckAt === "string"
              ? data.botStatus.lastPermissionCheckAt
              : null,
          unreadableChannelCount:
            Number(data.botStatus?.unreadableChannelCount) || 0,
          unreadableChannelNames: Array.isArray(
            data.botStatus?.unreadableChannelNames,
          )
            ? data.botStatus.unreadableChannelNames.slice(0, 3)
            : [],
        });
        const readMeta = data.readMeta && typeof data.readMeta === "object"
          ? data.readMeta as ProjectionReadMeta
          : null;
        setAnalyticsReadMeta(readMeta);
        scheduleNext(
          Number(readMeta?.nextUpdateAt) > Date.now()
            ? Number(readMeta?.nextUpdateAt)
            : Date.now() + 15 * 60_000,
        );
        setLastLiveRefreshAt(Date.now());
        // Theme and goal requests start only after this protected request has
        // verified the selected guild and populated the shared auth cache.
        setAuthorizedGuildId(guildId);
        setIsGuildLoading(false);
        setLoadState(readMeta?.available === false ? "error" : "success");
      } catch {
        // Keep the last successful data on screen. A short-lived refresh
        // failure should not interrupt dashboard use with a large warning.
        if (active) {
          setIsGuildLoading(false);
          setLoadState("error");
          scheduleNext(Date.now() + 15 * 60_000);
        }
      } finally {
        loading = false;
      }
    };
    // A Guild change fetches once. Further reads are aligned to the next
    // compaction snapshot; the browser does not poll Analytics every minute.
    void load("initial");
    const onVisibility = () => {
      if (
        document.visibilityState === "visible"
        && nextRefreshAt > 0
        && Date.now() >= nextRefreshAt
      ) void load("auto");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [days, en, guildId, locale, timeZone]);

  const displayedChartPoints = useMemo(() => {
    if (chartMetric === "members") return memberPoints;
    if (chartMetric === "inactiveMembers") return inactiveMemberPoints;
    if (chartMetric === "cumulative")
      return chartPoints.reduce<number[]>(
        (points, point) => [...points, (points.at(-1) ?? 0) + point],
        [],
      );
    return chartPoints;
  }, [chartMetric, chartPoints, inactiveMemberPoints, memberPoints]);
  const displayedChartLabels = chartMetric === "inactiveMembers" ? inactiveMemberLabels : labels;
  const chartCopy =
    chartMetric === "messages"
      ? {
          title: en ? "Active message trend" : "アクティブメッセージの推移",
          description: en
            ? `Daily messages collected by the bot · ${periodLabel}`
            : `Botが収集した日別メッセージ数 · ${period}`,
        }
      : chartMetric === "inactiveMembers"
        ? {
            title: en ? "Inactive member trend" : "非アクティブメンバーの推移",
            description: en
              ? `Members without a recorded message on each day · ${periodLabel}`
              : `各日にメッセージが記録されなかったメンバー · ${period}`,
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
      const memberLabel = en ? "Members" : "メンバー数";
      const messageLabel = en ? "Messages" : "メッセージ数";
      reportWindow.document.write(buildDashboardPrintReportHtml({
        documentTitle: filename,
        guildName: report.guild,
        periodLabel: report.period,
        memberLabel,
        messageLabel,
        voiceLabel: en ? "Total voice time" : "合計通話時間",
        memberCount,
        messageCount,
        voiceDuration: formatDuration(voiceTotalSeconds, locale),
        dateLabel: en ? "Date" : "日付",
        rows: report.dailyTrend,
      }));
      reportWindow.document.close();
      reportWindow.setTimeout(() => {
        reportWindow.focus();
        reportWindow.print();
      }, 100);
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
    <main style={guildThemeStyle(guildTheme)} className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-24 h-96 w-96 rounded-full bg-primary/[0.08] blur-[130px]" />
        <div className="absolute right-0 top-1/3 h-80 w-80 rounded-full bg-violet-500/[0.06] blur-[120px]" />
      </div>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-border/70 bg-card/45 px-4 py-5 backdrop-blur-xl lg:flex lg:flex-col">
        <a href="/?landing=1" className="mb-9 flex items-center gap-2.5 px-2" aria-label="NuviloView:OEM ランディングページへ">
          <BrandMark theme={guildTheme} />
          <BrandTitle className="text-base" />
        </a>
        <div className="relative mb-7">
          <button
            onClick={() => setServerOpen(!serverOpen)}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/55 px-3 py-3 text-left transition-colors hover:bg-secondary"
          >
            <GuildAvatar guild={selectedGuild} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold" title={selectedGuild?.name}>
                {selectedGuild?.name ?? "サーバーを選択"}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {isGuildLoading ? "読み込み中…" : `${memberCount.toLocaleString()} メンバー`}
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
                    switchGuild(guild.id);
                    setServerOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-secondary"
                >
                  <GuildAvatar guild={guild} size="small" />
                  <span className="truncate" title={guild.name}>{guild.name}</span>
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
            active={activeView === "overview"}
            icon={<LayoutDashboard />}
            label={en ? "Dashboard" : "ダッシュボード"}
            onClick={() => setActiveView("overview")}
          />
        </nav>
        <p className="mb-2 mt-7 px-3 text-[10px] font-bold tracking-[0.14em] text-muted-foreground">
          ANALYTICS
        </p>
        <nav className="space-y-1">
          <NavItem active={activeView === "retention"} icon={<Users />} label={en ? "Retention" : "定着率"} onClick={() => setActiveView("retention")} />
          <NavItem active={activeView === "health"} icon={<Activity />} label={en ? "Health v2 Preview" : "Health v2 プレビュー"} onClick={() => setActiveView("health")} />
          <NavItem active={activeView === "diagnostics"} icon={<LineChart />} label={en ? "Diagnostics" : "変化の要因"} onClick={() => setActiveView("diagnostics")} />
          <NavItem active={activeView === "channels"} icon={<Hash />} label={en ? "Channels" : "チャンネル"} onClick={() => setActiveView("channels")} />
          <NavItem active={activeView === "roles"} icon={<ShieldCheck />} label={en ? "Roles" : "ロール"} onClick={() => setActiveView("roles")} />
        </nav>
        <p className="mb-2 mt-7 px-3 text-[10px] font-bold tracking-[0.14em] text-muted-foreground">
          MANAGE
        </p>
        <nav className="space-y-1">
          <NavItem
            active={activeView === "insights"}
            icon={<Sparkles />}
            label={en ? "Growth insights" : "成長インサイト"}
            onClick={() => setActiveView("insights")}
          />
          <NavItem
            icon={<Settings />}
            label={en ? "Settings" : "設定"}
            href="/settings"
          />
        </nav>
      </aside>

      <div className="relative lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/70 bg-background/75 px-3 backdrop-blur-xl sm:px-8">
          <a href="/?landing=1" className="flex items-center gap-2 lg:hidden" aria-label="NuviloView:OEM ランディングページへ">
            <BrandMark theme={guildTheme} />
            <BrandTitle className="hidden min-[480px]:inline" />
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
                          <span className="text-muted-foreground" title={`#${message.channelName}`}>
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
            className="ml-1 inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/35 bg-primary/10 px-2.5 text-xs font-bold text-primary transition-colors hover:bg-primary/20 sm:ml-2 sm:px-3"
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI
          </button>
          <a
            href="/settings"
            aria-label={en ? "Settings" : "設定"}
            className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-xs font-bold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:w-auto sm:gap-1.5 sm:px-3 lg:hidden"
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{en ? "Settings" : "設定"}</span>
          </a>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
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
            <div className="relative">
              {isDeveloper ? (
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((current) => !current)}
                  aria-label={en ? "Open account menu" : "アカウントメニューを開く"}
                  className="flex items-center gap-3 rounded-xl px-1.5 py-1 transition-colors hover:bg-secondary"
                >
                  <UserIdentity sessionImage={session?.user?.image} userName={userName} userInitials={userInitials} en={en} />
                </button>
              ) : (
                <UserIdentity sessionImage={session?.user?.image} userName={userName} userInitials={userInitials} en={en} />
              )}
              {isDeveloper && userMenuOpen && (
                <div className="absolute right-0 top-12 z-50 w-56 overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-2xl">
                  <a
                    href="/developer"
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-bold text-primary transition-colors hover:bg-primary/10"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    <span>Developer Console</span>
                  </a>
                </div>
              )}
            </div>
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
                            <span className="text-muted-foreground" title={`#${message.channelName}`}>
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
                <span className="block truncate text-sm font-semibold" title={selectedGuild?.name}>
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
                      switchGuild(guild.id);
                      setServerOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left hover:bg-secondary"
                  >
                    <GuildAvatar guild={guild} size="small" />
                      <span className="truncate" title={guild.name}>{guild.name}</span>
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
              <DashboardLoadBadge
                state={loadState}
                lastUpdatedAt={lastLiveRefreshAt}
                periodLabel={periodLabel}
                en={en}
              />
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
              <button
                onClick={downloadActivityCard}
                disabled={!selectedGuild}
                className="inline-flex items-center gap-2 rounded-lg border border-primary/35 bg-primary/10 px-3.5 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {en ? "Activity card" : "活動実績カード"}
              </button>
              <select
                value={period}
                onChange={(event) => {
                  setPeriod(event.target.value);
                  setLoadState("loading");
                  setIsGuildLoading(true);
                }}
                disabled={loadState === "loading" || !guildId}
                aria-label={en ? "Analytics period" : "集計期間"}
                className="rounded-lg border border-border bg-card/60 px-3.5 py-2 text-sm font-medium outline-none disabled:cursor-wait disabled:opacity-60"
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

          {analyticsReadMeta && (
            <div className="mb-5">
              <ProjectionReadNotice meta={analyticsReadMeta} locale={locale} compact />
            </div>
          )}
          <section className="mb-5 grid gap-3 lg:grid-cols-3">
            <div className={`rounded-2xl border px-4 py-3.5 sm:px-5 ${loadState === "error" ? "border-rose-400/30 bg-rose-400/[0.08]" : loadState === "success" ? "border-emerald-400/25 bg-emerald-400/[0.07]" : "border-primary/20 bg-card/65"}`}>
              <div className={`flex items-center gap-2 text-xs font-bold ${loadState === "error" ? "text-rose-400" : loadState === "success" ? "text-emerald-400" : "text-primary"}`}>
                <span className="relative flex h-2.5 w-2.5">
                  {(loadState === "loading" || loadState === "refreshing") && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-current" />
                </span>
                {en ? "BOT DATA CONNECTION" : "BOTデータ接続"}
              </div>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {loadState === "error"
                  ? en
                    ? "Could not refresh. Showing the last successful data."
                    : "更新に失敗しました。最後に取得できたデータを表示しています"
                  : botStatus.lastRecordedAt
                  ? en
                    ? `Last recorded ${formatElapsed(botStatus.lastRecordedAt, true)}`
                    : `最終記録から${formatElapsed(botStatus.lastRecordedAt)}`
                  : en
                    ? "Waiting for the first record"
                    : "最初の記録を待っています"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {en
                  ? "Analytics refreshes once when the next Projection is due."
                  : "次のProjection更新時刻に合わせて1回だけ再取得します。"}
                {lastLiveRefreshAt && (
                  <span>
                    {en ? " Last refresh: " : " 最終更新: "}
                    {formatElapsed(lastLiveRefreshAt, en)}
                  </span>
                )}
              </p>
            </div>
            <div
              className={`rounded-2xl border px-4 py-3.5 sm:px-5 ${!botStatus.lastPermissionCheckAt ? "border-border bg-card/65" : botStatus.unreadableChannelCount > 0 ? "border-amber-500/35 bg-amber-500/10" : "border-emerald-500/25 bg-emerald-500/10"}`}
            >
              <div
                className={`flex items-center gap-2 text-xs font-bold ${!botStatus.lastPermissionCheckAt ? "text-muted-foreground" : botStatus.unreadableChannelCount > 0 ? "text-amber-500" : "text-emerald-500"}`}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-current" />
                {en ? "CHANNEL PERMISSIONS" : "チャンネル権限"}
              </div>
              {!botStatus.lastPermissionCheckAt ? (
                <p className="mt-2 text-sm font-semibold text-foreground">
                  {en ? "Permission details are not included in Projection v1" : "権限詳細はProjection v1の集約対象外です"}
                </p>
              ) : botStatus.unreadableChannelCount > 0 ? (
                <>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {en
                      ? `${botStatus.unreadableChannelCount} channel(s) cannot be read`
                      : `${botStatus.unreadableChannelCount}件のチャンネルで読み取り権限が不足しています`}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={botStatus.unreadableChannelNames.map((name) => `#${name}`).join(" · ")}>
                    {botStatus.unreadableChannelNames.map((name) => `#${name}`).join(" · ")}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm font-semibold text-foreground">
                  {en ? "All monitored channels are readable" : "監視対象チャンネルの権限は問題ありません"}
                </p>
              )}
              {botStatus.lastPermissionCheckAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {en ? "Checked " : "確認: "}
                  {formatElapsed(botStatus.lastPermissionCheckAt, en)}
                </p>
              )}
            </div>
            <RuntimeProviderStatus guildId={guildId} locale={locale} />
          </section>
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
          {activeView !== "overview" && (["retention", "health", "diagnostics", "channels", "roles", "insights"] as string[]).includes(activeView)
            ? <CommunityAnalyticsDashboard view={activeView as CommunityAnalyticsView} guildId={guildId} days={days} timeZone={timeZone} locale={locale} />
            : activeView !== "overview" && <DashboardDetailView view={activeView as "analytics" | "members" | "messages"} en={en} periodLabel={periodLabel} memberCount={memberCount} activeMemberCount={activeMemberCount} messageCount={messageCount} totalMessageCount={totalMessageCount} reactionRate={reactionRate} voiceTotalSeconds={voiceTotalSeconds} locale={locale} labels={labels} chartPoints={chartPoints} memberPoints={memberPoints} activities={activities} channelInsights={channelInsights} insight={insight} insightCards={insightCards} />}
          {activeView === "overview" && <>
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold tracking-[0.16em] text-primary">KEY METRICS</p>
              <h2 className="mt-1 text-lg font-extrabold">{en ? "Key metrics" : "重要指標"}</h2>
            </div>
            <p className="text-xs text-muted-foreground">{en ? "Current status and selected period" : `現在値・${periodLabel}`}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={en ? "Total members" : "総メンバー数"}
              value={memberCount.toLocaleString()}
              delta={`${memberChange > 0 ? "+" : memberChange < 0 ? "−" : "±"}${Math.abs(memberChange).toLocaleString()}`}
              detail={comparisonCaption}
              tone={memberChange > 0 ? "success" : memberChange < 0 ? "danger" : "neutral"}
              periodText={en ? "Current" : "現在"}
              loading={dashboardPending}
              requirement={memberCount === 0 ? (en ? "1 member snapshot needed" : "あと1回のメンバー記録が必要") : undefined}
              icon={<Users />}
              onClick={() => setOverviewMetric("members")}
              selected={overviewMetric === "members"}
            />
            <StatCard
              label={en ? "Active members" : "アクティブメンバー"}
              value={activeMemberCount.toLocaleString()}
              delta={`${activeMemberChange > 0 ? "+" : activeMemberChange < 0 ? "−" : "±"}${Math.abs(activeMemberChange).toLocaleString()}`}
              detail={en ? "Compared with yesterday" : "前日との比較"}
              tone={activeMemberChange > 0 ? "success" : activeMemberChange < 0 ? "danger" : "neutral"}
              periodText={en ? "Today" : "今日"}
              loading={dashboardPending}
              requirement={messageCount === 0 ? (en ? "1 message needed to start" : "あと1件のメッセージで集計開始") : undefined}
              icon={<Activity />}
              onClick={() => setOverviewMetric("active")}
              selected={overviewMetric === "active"}
            />
            <StatCard
              label={en ? "Active messages" : "アクティブメッセージ"}
              value={messageCount.toLocaleString()}
              delta={`${activeMessageChange > 0 ? "+" : activeMessageChange < 0 ? "−" : "±"}${Math.abs(activeMessageChange).toLocaleString()}`}
              detail={en ? "vs yesterday · Open daily history" : "前日との比較・押すと日別履歴"}
              tone={activeMessageChange > 0 ? "success" : activeMessageChange < 0 ? "danger" : "neutral"}
              periodText={en ? "Today" : "今日"}
              loading={dashboardPending}
              requirement={messageCount === 0 ? (en ? "1 message needed to display" : "あと1件のメッセージで表示") : undefined}
              icon={<LineChart />}
              onClick={() => {
                setOverviewMetric("activeMessages");
                setChartMetric("messages");
                setMobileDetailsOpen(true);
              }}
              selected={overviewMetric === "activeMessages"}
            />
            <StatCard
              label={en ? "Total messages" : "総送信数"}
              value={totalMessageCount.toLocaleString()}
              delta={`${periodMessageCount.toLocaleString()}${en ? " in period" : "件"}`}
              detail={en ? `Sent during ${periodLabel.toLowerCase()}` : `${periodLabel}に送信`}
              tone="info"
              periodText={en ? "Retention window" : "保存期間内"}
              loading={dashboardPending}
              requirement={totalMessageCount === 0 ? (en ? "1 message needed to display" : "あと1件のメッセージで表示") : undefined}
              icon={<MessageSquareText />}
              onClick={() => setOverviewMetric("messages")}
              selected={overviewMetric === "messages"}
            />
          </div>
          <button
            type="button"
            onClick={() => setMobileDetailsOpen((current) => !current)}
            className="mt-4 flex w-full items-center justify-between rounded-xl border border-border bg-card/60 px-4 py-3 text-sm font-bold sm:hidden"
            aria-expanded={mobileDetailsOpen}
          >
            {en ? "Detailed analytics" : "詳細分析"}
            {mobileDetailsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          <div className={`${mobileDetailsOpen ? "block" : "hidden"} sm:block`}>
          <div className="mb-3 mt-7 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold tracking-[0.16em] text-muted-foreground">DETAIL ANALYTICS</p>
              <h2 className="mt-1 text-lg font-extrabold">{en ? "Detailed analytics" : "詳細分析"}</h2>
            </div>
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={en ? "Inactive members" : "非アクティブメンバー"}
              value={inactiveMemberCount.toLocaleString()}
              delta={`${inactiveMemberChange > 0 ? "+" : inactiveMemberChange < 0 ? "−" : "±"}${Math.abs(inactiveMemberChange).toLocaleString()}`}
              detail={en ? "vs yesterday · Open daily history" : "前日との比較・押すと日別履歴"}
              tone={inactiveMemberChange < 0 ? "success" : inactiveMemberChange > 0 ? "danger" : "neutral"}
              periodText={en ? "Today" : "今日"}
              loading={dashboardPending}
              requirement={memberCount === 0 ? (en ? "1 member snapshot needed" : "あと1回のメンバー記録が必要") : undefined}
              icon={<Users />}
              onClick={() => {
                setOverviewMetric("inactive");
                setChartMetric("inactiveMembers");
                setMobileDetailsOpen(true);
              }}
              selected={overviewMetric === "inactive"}
            />
            <StatCard
              label={en ? "Average reaction rate" : "平均リアクション率"}
              value={`${periodReactionRate.toFixed(1)}%`}
              delta={`${reactionChange > 0 ? "+" : reactionChange < 0 ? "−" : "±"}${Math.abs(reactionChange).toFixed(1)}pt`}
              detail={comparisonCaption}
              tone={reactionChange > 0 ? "success" : reactionChange < 0 ? "danger" : "neutral"}
              periodText={periodLabel}
              loading={dashboardPending}
              requirement={periodMessageCount < 5 ? (en ? `${5 - periodMessageCount} more message(s) needed` : `あと${5 - periodMessageCount}件のメッセージが必要`) : undefined}
              icon={<Sparkles />}
              onClick={() => setOverviewMetric("reactions")}
              selected={overviewMetric === "reactions"}
            />
            <StatCard
              label={en ? "Total voice time" : "合計通話時間"}
              value={formatDuration(voiceTotalSeconds, locale)}
              delta={periodLabel}
              detail={en ? "Server voice activity" : "サーバー内に1人以上いた時間"}
              tone="info"
              periodText={periodLabel}
              loading={dashboardPending}
              requirement={maxVoiceSessionSeconds === 0 ? (en ? "1 voice session needed" : "あと1回の通話記録が必要") : undefined}
              icon={<Coffee />}
            />
            <StatCard
              label={en ? "Longest voice session" : "最高連続通話時間"}
              value={formatDuration(maxVoiceSessionSeconds, locale)}
              delta={voiceSessionChange === 0 ? "±0" : `${voiceSessionChange > 0 ? "+" : "-"}${formatDuration(Math.abs(voiceSessionChange), locale)}`}
              detail={comparisonCaption}
              tone={voiceSessionChange > 0 ? "success" : voiceSessionChange < 0 ? "danger" : "neutral"}
              periodText={periodLabel}
              loading={dashboardPending}
              requirement={maxVoiceSessionSeconds === 0 ? (en ? "1 voice session needed" : "あと1回の通話記録が必要") : undefined}
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
            messageCount={messageCount}
            periodMessageCount={periodMessageCount}
            previousMessageCount={previousMessageCount}
            periodReactionRate={periodReactionRate}
            previousReactionRate={previousReactionRate}
            maxVoiceSessionSeconds={maxVoiceSessionSeconds}
            previousMaxVoiceSessionSeconds={previousMaxVoiceSessionSeconds}
            memberPoints={memberPoints}
            activeMemberPoints={activeMemberPoints}
            inactiveMemberPoints={inactiveMemberPoints}
            inactiveMemberLabels={inactiveMemberLabels}
            messagePoints={chartPoints}
            reactionPoints={reactionPoints}
            labels={labels}
            periodLabel={periodLabel}
            previousPeriodLabel={previousPeriodLabel}
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
                          ["inactiveMembers", "非アクティブ推移"],
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
              {displayedChartPoints.some((point) => point > 0) ? <>
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
                        stopColor="var(--primary)"
                        stopOpacity="0.36"
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--primary)"
                        stopOpacity="0"
                      />
                    </linearGradient>
                    <clipPath id="message-trend-line-clip">
                      <rect
                        key={`${guildId}-${chartMetric}-${displayedChartLabels.join("-")}`}
                        x="0"
                        y="0"
                        width="100"
                        height="100"
                        className="chart-line-reveal"
                      />
                    </clipPath>
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
                    pathLength="1"
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    clipPath="url(#message-trend-line-clip)"
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
                {displayedChartLabels.map((label) => <span key={label}>{label}</span>)}
              </div>
              </> : <div className="mt-7"><EmptyDataState title={en ? "No trend data yet" : "推移データがまだありません"} detail={chartMetric === "members" || chartMetric === "inactiveMembers" ? (en ? "1 member snapshot needed" : "あと1回のメンバー記録が必要") : (en ? "1 message needed" : "あと1件のメッセージ記録が必要")} /></div>}
            </section>

            <section className="rounded-2xl border border-border bg-card/55 p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-bold">
                    {en ? "Live activity pulse" : "リアルタイム活動パルス"}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {en ? "A quick live signal; the Health v2 Preview is shown below" : "当日の簡易シグナルです。Health v2 Previewは下部に表示します"}
                  </p>
                </div>
                <StatusBadge tone={health.status === "良好" || health.status === "Good" ? "success" : health.status === "注意" || health.status === "Caution" ? "warning" : health.status === "要確認" || health.status === "Needs attention" ? "danger" : "neutral"}>{health.status}</StatusBadge>
              </div>
              <div className="mt-6 flex items-center gap-5">
                <div
                  className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: `conic-gradient(${health.status === "良好" || health.status === "Good" ? "#34d399" : health.status === "注意" || health.status === "Caution" ? "#fbbf24" : health.status === "要確認" || health.status === "Needs attention" ? "#fb7185" : "#71717a"} 0deg ${health.score * 3.6}deg, rgba(255,255,255,.08) ${health.score * 3.6}deg)`,
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
              {coverage.insightRemainingDays > 0 && (
                <p className="mt-4 flex items-center gap-1.5 rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] font-bold text-amber-400">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {en ? `${coverage.insightRemainingDays} more recorded day(s) needed for full comparison` : `十分な比較まであと${coverage.insightRemainingDays}日分の記録が必要`}
                </p>
              )}
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
                          <span className="truncate font-semibold" title={activity.actorName}>
                            {activity.actorName}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatActivityTime(activity.occurredAt, timeZone)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground" title={activity.channelName ? `#${activity.channelName}` : undefined}>
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
                  <EmptyDataState title={en ? "No recent activity yet" : "最近のアクティビティはまだありません"} detail={en ? "1 event needed to display" : "あと1件のイベント記録で表示"} />
                )}
              </div>
            </section>
            <section className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.16] to-card/60 p-5 sm:p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Sparkles className="h-5 w-5" />
              </div>
              <p className="mt-4 text-xs font-bold tracking-wider text-primary">
                {en ? "SERVER INSIGHTS" : "サーバーインサイト"}
              </p>
              <h2 className="mt-1 font-bold">
                {en && insight.title === "データを収集中です"
                  ? "Collecting data"
                  : clarifyComparisonText(insight.title, previousPeriodLabel, en)}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {en &&
                insight.body ===
                  "Botがデータを記録すると、実績に基づくインサイトを表示します。"
                  ? "Insights will appear when the bot has recorded data."
                  : clarifyComparisonText(insight.body, previousPeriodLabel, en)}
              </p>
              {coverage.insightRemainingDays > 0 && (
                <p className="mt-3 flex items-center gap-1.5 text-xs font-bold text-amber-400"><AlertCircle className="h-3.5 w-3.5" />{en ? `${coverage.insightRemainingDays} more day(s) of records needed` : `比較インサイトまであと${coverage.insightRemainingDays}日分`}</p>
              )}
              <div className="mt-5 space-y-2.5">
                {insightCards.length ? insightCards.map((card) => (
                  <div
                    key={card.kind}
                    className="rounded-xl border border-border/70 bg-background/45 px-3.5 py-3"
                  >
                    <p className="text-[11px] font-bold tracking-wide text-primary">
                      {card.kind === "channel"
                        ? en
                          ? "CHANNEL"
                          : "チャンネル"
                        : card.kind === "time"
                          ? en
                            ? "PEAK TIME"
                            : "ピーク時間"
                          : card.kind === "members"
                            ? en
                              ? "MEMBERS"
                              : "メンバー"
                            : en
                              ? "ENGAGEMENT"
                              : "反応"}
                    </p>
                    <p className="mt-1 text-sm font-semibold">{clarifyComparisonText(card.title, previousPeriodLabel, en)}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {clarifyComparisonText(card.body, previousPeriodLabel, en)}
                    </p>
                  </div>
                )) : <EmptyDataState title={en ? "No insight data yet" : "インサイトデータがまだありません"} detail={en ? `${coverage.insightRemainingDays} more day(s) needed` : `あと${coverage.insightRemainingDays}日分の記録が必要`} />}
              </div>
            </section>
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
            <ChannelInsightsPanel insights={channelInsights} en={en} periodLabel={periodLabel} previousPeriodLabel={previousPeriodLabel} />
            <GrowthGoalsPanel
              goals={goals}
              targets={goalTargets}
              onTargetChange={(type, value) => setGoalTargets((current) => ({ ...current, [type]: value }))}
              onSave={() => void saveGoals()}
              saving={savingGoals}
              en={en}
              timeZone={timeZone}
            />
          </div>
          <CommunityAnalyticsDashboard view="overview" guildId={guildId} days={days} timeZone={timeZone} locale={locale} />
          </div>
          </>}
        </section>
      </div>
    </main>
  );
}

function DashboardDetailView({ view, en, periodLabel, memberCount, activeMemberCount, messageCount, totalMessageCount, reactionRate, voiceTotalSeconds, locale, labels, chartPoints, memberPoints, activities, channelInsights, insight, insightCards }: {
  view: "analytics" | "members" | "messages" | "insights"; en: boolean; periodLabel: string; memberCount: number; activeMemberCount: number; messageCount: number; totalMessageCount: number; reactionRate: number; voiceTotalSeconds: number; locale: "ja" | "en"; labels: string[]; chartPoints: number[]; memberPoints: number[]; activities: RecentActivity[]; channelInsights: ChannelInsight[]; insight: Insight; insightCards: InsightCard[];
}) {
  const title = view === "analytics" ? (en ? "Analytics" : "アナリティクス") : view === "members" ? (en ? "Members" : "メンバー") : view === "messages" ? (en ? "Messages" : "メッセージ") : (en ? "Growth insights" : "成長インサイト");
  const points = view === "members" ? memberPoints : chartPoints;
  const maximum = Math.max(...points, 1);
  return <section className="rounded-2xl border border-border bg-card/55 p-5 sm:p-7"><p className="text-xs font-bold tracking-[.15em] text-primary">{view.toUpperCase()}</p><h2 className="mt-1 text-2xl font-extrabold">{title}</h2><p className="mt-2 text-sm text-muted-foreground">{periodLabel}の実データです。</p>
    {view === "analytics" && <><div className="mt-6 grid gap-3 sm:grid-cols-3"><DetailMetric label={en ? "Messages" : "メッセージ"} value={`${chartPoints.reduce((a,b)=>a+b,0).toLocaleString()}件`} /><DetailMetric label={en ? "Reaction rate" : "反応率"} value={`${reactionRate.toFixed(1)}%`} /><DetailMetric label={en ? "Voice time" : "通話時間"} value={formatDuration(voiceTotalSeconds, locale)} /></div><MiniTrend labels={labels} points={points} /></>}
    {view === "members" && <><div className="mt-6 grid gap-3 sm:grid-cols-3"><DetailMetric label={en ? "Total" : "総メンバー"} value={`${memberCount.toLocaleString()}人`} /><DetailMetric label={en ? "Active today" : "今日のアクティブ"} value={`${activeMemberCount.toLocaleString()}人`} /><DetailMetric label={en ? "Inactive today" : "今日の非アクティブ"} value={`${Math.max(0,memberCount-activeMemberCount).toLocaleString()}人`} /></div><MiniTrend labels={labels} points={memberPoints} /></>}
    {view === "messages" && <><div className="mt-6 grid gap-3 sm:grid-cols-3"><DetailMetric label={en ? "Today" : "今日の送信数"} value={`${messageCount.toLocaleString()}件`} /><DetailMetric label={en ? "Stored" : "保存済み総数"} value={`${totalMessageCount.toLocaleString()}件`} /><DetailMetric label={en ? "Channels" : "分析チャンネル"} value={`${channelInsights.length}件`} /></div><div className="mt-6 space-y-2">{channelInsights.length ? channelInsights.slice(0,8).map(c=><div key={c.channelName} className="flex justify-between gap-3 rounded-lg bg-secondary/50 px-4 py-3 text-sm"><span className="truncate" title={`#${c.channelName}`}>#{c.channelName}</span><span className="shrink-0 font-bold">{c.messageCount.toLocaleString()}件</span></div>) : <EmptyDataState title={en ? "No channel data yet" : "チャンネルデータがまだありません"} detail={en ? "1 stored message needed" : "あと1件のメッセージ記録が必要"} />}</div></>}
    {view === "insights" && <><div className="mt-6 rounded-xl border border-primary/25 bg-primary/10 p-5"><h3 className="font-bold">{insight.title}</h3><p className="mt-2 text-sm text-muted-foreground">{insight.body}</p></div><div className="mt-4 grid gap-3 sm:grid-cols-3">{insightCards.length ? insightCards.map(c=><div key={c.kind} className="rounded-xl border border-border p-4"><p className="text-xs font-bold text-primary">{c.title}</p><p className="mt-2 text-sm text-muted-foreground">{c.body}</p></div>) : <div className="sm:col-span-3"><EmptyDataState title={en ? "No insight data yet" : "インサイトデータがまだありません"} /></div>}</div></>}
  </section>;
}
function DetailMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-border bg-background/40 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-xl font-extrabold">{value}</p></div> }
function MiniTrend({ labels, points }: { labels: string[]; points: number[] }) { const max=Math.max(...points,1); return <div className="mt-6"><div className="flex h-32 items-end gap-1.5">{points.map((p,i)=><div key={`${labels[i]}-${i}`} title={`${labels[i]}: ${p}`} className="min-w-1 flex-1 rounded-t bg-primary/70" style={{height:`${Math.max(3,(p/max)*100)}%`}} />)}</div><div className="mt-2 flex justify-between text-[10px] text-muted-foreground"><span>{labels[0] ?? "—"}</span><span>{labels.at(-1) ?? "—"}</span></div></div> }

function ChannelInsightsPanel({ insights, en, periodLabel, previousPeriodLabel }: { insights: ChannelInsight[]; en: boolean; periodLabel: string; previousPeriodLabel: string }) {
  const mostActive = insights.at(0);
  const growing = [...insights]
    .filter((item) => item.messageCount > item.previousMessageCount)
    .sort((a, b) => (b.messageCount - b.previousMessageCount) - (a.messageCount - a.previousMessageCount))[0];
  const quiet = [...insights]
    .filter((item) => item.messageCount >= 0)
    .sort((a, b) => a.messageCount - b.messageCount || a.channelName.localeCompare(b.channelName))[0];
  const rows = [
    { label: en ? "MOST ACTIVE" : "最も利用されている", icon: <MessageSquareText className="h-4 w-4" />, item: mostActive, accent: "text-primary" },
    { label: en ? "GROWING" : "伸びている", icon: <TrendingUp className="h-4 w-4" />, item: growing, accent: "text-emerald-400" },
    { label: en ? "QUIET" : "利用が少ない", icon: <Activity className="h-4 w-4" />, item: quiet, accent: "text-amber-400" },
  ];
  return (
    <section className="rounded-2xl border border-border bg-card/55 p-5 sm:p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-bold">{en ? "Channel insights" : "チャンネル別インサイト"}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{en ? `Based on ${periodLabel.toLowerCase()}` : `${periodLabel}の保存済みメッセージを分析`}</p>
        </div>
        <Hash className="h-5 w-5 text-primary" />
      </div>
      {insights.length ? <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-xl border border-border/70 bg-background/40 p-3.5">
            <div className={`flex items-center gap-2 text-[10px] font-bold tracking-wider ${row.accent}`}>{row.icon}{row.label}</div>
            {row.item ? <>
              <p className="mt-3 truncate text-sm font-bold" title={`#${row.item.channelName}`}>#{row.item.channelName}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {row.label === (en ? "GROWING" : "伸びている")
                  ? `${row.item.messageCount - row.item.previousMessageCount >= 0 ? "+" : ""}${(row.item.messageCount - row.item.previousMessageCount).toLocaleString()} ${en ? `vs ${previousPeriodLabel.toLowerCase()}` : `件・${previousPeriodLabel}との差`}`
                  : `${row.item.messageCount.toLocaleString()} ${en ? "messages" : "件"}`}
              </p>
            </> : <p className="mt-3 text-xs text-muted-foreground">{en ? "Waiting for data" : "データを収集中です"}</p>}
          </div>
        ))}
      </div> : <div className="mt-5"><EmptyDataState title={en ? "No channel data yet" : "チャンネルデータがまだありません"} detail={en ? "1 stored message needed" : "あと1件のメッセージ記録が必要"} /></div>}
    </section>
  );
}

function GrowthGoalsPanel({ goals, targets, onTargetChange, onSave, saving, en, timeZone }: {
  goals: GrowthGoal[];
  targets: Record<GoalType, string>;
  onTargetChange: (type: GoalType, value: string) => void;
  onSave: () => void;
  saving: boolean;
  en: boolean;
  timeZone: string;
}) {
  const remainingDays = getDaysRemainingInMonth(timeZone);
  const definitions: Array<{ type: GoalType; label: string; unit: string }> = [
    { type: "member_growth", label: en ? "Member growth" : "メンバー増加", unit: en ? "members" : "人" },
    { type: "messages", label: en ? "Messages" : "総メッセージ", unit: en ? "messages" : "件" },
    { type: "voice_seconds", label: en ? "Voice time" : "通話時間", unit: en ? "hours" : "時間" },
  ];
  return (
    <section className="rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.12] to-card/65 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold">{en ? "Monthly growth goals" : "今月の成長目標"}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{en ? "Goals are private to your dashboard account." : "目標はあなたのダッシュボード設定として保存されます。"}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Target className="h-5 w-5 text-primary" />
          <span className="rounded-full border border-border bg-background/35 px-2 py-1 text-[10px] font-bold text-muted-foreground">{en ? `${remainingDays} days left` : `月末まであと${remainingDays}日`}</span>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {definitions.map((definition) => {
          const goal = goals.find((item) => item.type === definition.type);
          const target = goal?.target ?? 0;
          const current = goal?.current ?? 0;
          const progress = target ? Math.min(100, Math.round((current / target) * 100)) : 0;
          const displayCurrent = definition.type === "voice_seconds" ? Math.floor(current / 3600) : current;
          const displayTarget = definition.type === "voice_seconds" ? Math.floor(target / 3600) : target;
          const displayRemaining = Math.max(0, displayTarget - displayCurrent);
          return <div key={definition.type} className="rounded-xl border border-border/70 bg-background/40 px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-bold">{definition.label}</label>
              <div className="flex items-center gap-1.5">
                <input value={targets[definition.type]} onChange={(event) => onTargetChange(definition.type, event.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="—" className="h-7 w-20 rounded-md border border-border bg-card px-2 text-right text-xs font-bold outline-none focus:border-primary" />
                <span className="w-12 text-[11px] text-muted-foreground">{definition.unit}</span>
              </div>
            </div>
            {target > 0 && <>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px]">
                <span className="text-muted-foreground">{displayCurrent.toLocaleString()} / {displayTarget.toLocaleString()} {definition.unit} · <strong className="text-foreground">{progress}%</strong></span>
                <span className={displayRemaining === 0 ? "font-bold text-emerald-400" : "font-bold text-primary"}>{displayRemaining === 0 ? (en ? "Goal reached" : "目標達成") : (en ? `${displayRemaining.toLocaleString()} remaining` : `残り${displayRemaining.toLocaleString()}${definition.unit}`)}</span>
              </div>
            </>}
          </div>;
        })}
      </div>
      <button onClick={onSave} disabled={saving} className="mt-4 w-full rounded-lg bg-primary px-3 py-2.5 text-xs font-bold text-primary-foreground transition-opacity disabled:opacity-60">
        {saving ? (en ? "Saving..." : "保存中...") : (en ? "Save goals" : "目標を保存")}
      </button>
    </section>
  );
}

function getDaysRemainingInMonth(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.max(0, daysInMonth - day);
}

function UserIdentity({ sessionImage, userName, userInitials, en }: { sessionImage?: string | null; userName: string; userInitials: string; en: boolean }) {
  return <>
    <div className="hidden text-right sm:block">
      <p className="text-sm font-semibold">{userName}</p>
      <p className="text-[11px] text-muted-foreground">{en ? "Server owner" : "サーバーオーナー"}</p>
    </div>
    {sessionImage ? (
      <img src={sessionImage} alt="" className="h-9 w-9 rounded-full object-cover" referrerPolicy="no-referrer" />
    ) : (
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-pink-400 to-violet-600 text-xs font-bold">{userInitials}</div>
    )}
  </>
}

function BrandMark({ theme }: { theme: GuildTheme }) {
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary text-primary-foreground">
    {theme.logoUrl ? <img src={theme.logoUrl} alt="" className="h-full w-full object-cover" /> : <Coffee className="h-[18px] w-[18px]" strokeWidth={2.25} />}
  </span>
}

function BrandTitle({ className = "" }: { className?: string }) {
  return <span className={`font-bold tracking-tight ${className}`}>NuviloView:<span className="text-primary">OEM</span></span>
}

function NavItem({
  icon,
  label,
  active = false,
  href = "#",
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  href?: string;
  onClick?: () => void;
}) {
  return (
    <a
      href={href}
      onClick={(event) => { if (onClick) { event.preventDefault(); onClick(); } }}
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
  detail,
  periodText,
  tone = "neutral",
  loading = false,
  requirement,
}: {
  label: string;
  value: string;
  delta: string;
  icon: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  detail?: string;
  periodText: string;
  tone?: "success" | "warning" | "danger" | "info" | "neutral";
  loading?: boolean;
  requirement?: string;
}) {
  const toneClass = tone === "success"
    ? "text-emerald-400"
    : tone === "warning"
      ? "text-amber-400"
      : tone === "danger"
        ? "text-rose-400"
        : tone === "info"
          ? "text-primary"
          : "text-muted-foreground";
  const content = (
    <>
      <div className="flex items-start justify-between">
        <div className="min-w-0 pr-2">
          <p className="truncate text-sm font-medium text-muted-foreground" title={label}>{label}</p>
          <span className="mt-1.5 inline-flex rounded-full border border-border bg-background/35 px-2 py-0.5 text-[10px] font-bold text-muted-foreground">{periodText}</span>
        </div>
        <span className="rounded-lg bg-primary/[0.12] p-2 text-primary">
          {icon}
        </span>
      </div>
      {loading ? (
        <div className="mt-5 space-y-3" aria-label="データを取得中">
          <div className="h-9 w-28 animate-pulse rounded-lg bg-secondary" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-secondary/70" />
        </div>
      ) : (
        <>
          <p className="mt-4 text-3xl font-extrabold tracking-tight">{value}</p>
          <p className={`mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-semibold ${toneClass}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {delta}
            {detail && <span className="font-normal text-muted-foreground">{detail}</span>}
          </p>
          {requirement && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {requirement}
            </p>
          )}
        </>
      )}
    </>
  );
  const className = `min-h-[178px] w-full rounded-2xl border bg-card/55 p-4 text-left shadow-sm transition-colors sm:p-5 ${selected ? "border-primary/70 bg-primary/[0.08]" : "border-border"} ${onClick ? "cursor-pointer hover:border-primary/40 hover:bg-card" : ""}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  ) : (
    <section className={className}>{content}</section>
  );
}

function StatusBadge({ tone, children }: { tone: "success" | "warning" | "danger" | "info" | "neutral"; children: React.ReactNode }) {
  const classes = tone === "success"
    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-400"
    : tone === "warning"
      ? "border-amber-400/25 bg-amber-400/10 text-amber-400"
      : tone === "danger"
        ? "border-rose-400/25 bg-rose-400/10 text-rose-400"
        : tone === "info"
          ? "border-primary/25 bg-primary/10 text-primary"
          : "border-border bg-secondary text-muted-foreground";
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${classes}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}

function DashboardLoadBadge({ state, lastUpdatedAt, periodLabel, en }: { state: DashboardLoadState; lastUpdatedAt: number | null; periodLabel: string; en: boolean }) {
  if (state === "loading") return <StatusBadge tone="info"><LoaderCircle className="h-3 w-3 animate-spin" />{en ? `Loading ${periodLabel.toLowerCase()}` : `${periodLabel}を取得中`}</StatusBadge>;
  if (state === "refreshing") return <StatusBadge tone="info"><LoaderCircle className="h-3 w-3 animate-spin" />{en ? "Refreshing automatically" : "自動更新中"}</StatusBadge>;
  if (state === "error") return <StatusBadge tone="danger"><AlertCircle className="h-3 w-3" />{en ? "Refresh failed" : "更新に失敗"}</StatusBadge>;
  if (state === "success") return <StatusBadge tone="success">{en ? `Updated ${lastUpdatedAt ? formatElapsed(lastUpdatedAt, true) : "now"}` : `更新完了・${lastUpdatedAt ? formatElapsed(lastUpdatedAt) : "たった今"}`}</StatusBadge>;
  return <StatusBadge tone="neutral">{en ? "Select a server" : "サーバーを選択してください"}</StatusBadge>;
}

function EmptyDataState({ title, detail }: { title: string; detail?: string }) {
  return <div className="rounded-xl border border-dashed border-border bg-background/25 px-4 py-6 text-center">
    <p className="text-xs font-bold text-muted-foreground">{title}</p>
    {detail && <p className="mt-1.5 text-[11px] text-amber-400">{detail}</p>}
  </div>;
}

function clarifyComparisonText(text: string, previousPeriodLabel: string, en: boolean) {
  return en
    ? text.replace(/vs\. previous period/gi, `vs. ${previousPeriodLabel.toLowerCase()}`)
    : text.replace(/前期間比/g, `${previousPeriodLabel}との差`);
}

function OverviewComparison({
  metric,
  memberCount,
  previousMemberCount,
  activeMemberCount,
  previousActiveMemberCount,
  messageCount,
  periodMessageCount,
  previousMessageCount,
  periodReactionRate,
  previousReactionRate,
  maxVoiceSessionSeconds,
  previousMaxVoiceSessionSeconds,
  memberPoints,
  activeMemberPoints,
  inactiveMemberPoints,
  inactiveMemberLabels,
  messagePoints,
  reactionPoints,
  labels,
  periodLabel,
  previousPeriodLabel,
  locale,
  en,
}: {
  metric: "members" | "active" | "inactive" | "activeMessages" | "messages" | "reactions" | "voice";
  memberCount: number;
  previousMemberCount: number;
  activeMemberCount: number;
  previousActiveMemberCount: number;
  messageCount: number;
  periodMessageCount: number;
  previousMessageCount: number;
  periodReactionRate: number;
  previousReactionRate: number;
  maxVoiceSessionSeconds: number;
  previousMaxVoiceSessionSeconds: number;
  memberPoints: number[];
  activeMemberPoints: number[];
  inactiveMemberPoints: number[];
  inactiveMemberLabels: string[];
  messagePoints: number[];
  reactionPoints: number[];
  labels: string[];
  periodLabel: string;
  previousPeriodLabel: string;
  locale: "ja" | "en";
  en: boolean;
}) {
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  useEffect(() => setSelectedPointIndex(null), [metric, periodLabel]);
  const config =
    metric === "members"
      ? {
          title: en ? "Member comparison" : "メンバー数の比較",
          currentLabel: en ? "Members today" : "今日の総メンバー",
          previousLabel: en ? `${previousPeriodLabel} ending value` : `${previousPeriodLabel}終了時の総メンバー`,
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
              ? "Active members yesterday"
              : "前日のアクティブメンバー",
            current: activeMemberCount,
            previous: previousActiveMemberCount,
            points: activeMemberPoints,
            format: (value: number) => value.toLocaleString(),
          }
        : metric === "inactive"
          ? {
              title: en ? "Inactive member comparison" : "非アクティブメンバーの比較",
              currentLabel: en ? "Inactive today" : "今日の非アクティブメンバー",
              previousLabel: en ? "Inactive yesterday" : "前日の非アクティブメンバー",
              current: Math.max(0, memberCount - activeMemberCount),
              previous: inactiveMemberPoints.at(-2) ?? Math.max(0, memberCount - activeMemberCount),
              points: inactiveMemberPoints,
              format: (value: number) => value.toLocaleString(),
            }
        : metric === "activeMessages"
          ? {
              title: en ? "Active message comparison" : "アクティブメッセージの比較",
              currentLabel: en ? "Messages today" : "今日のアクティブメッセージ",
              previousLabel: en ? "Messages yesterday" : "前日のアクティブメッセージ",
              current: messageCount,
              previous: messagePoints.at(-2) ?? 0,
              points: messagePoints,
              format: (value: number) => value.toLocaleString(),
            }
          : metric === "messages"
          ? {
              title: en ? "Message comparison" : "送信メッセージの比較",
              currentLabel: en ? "Selected period" : "選択期間の送信メッセージ",
              previousLabel: en ? previousPeriodLabel : `${previousPeriodLabel}の送信メッセージ`,
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
                  ? previousPeriodLabel
                  : `${previousPeriodLabel}の平均リアクション率`,
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
                previousLabel: en ? previousPeriodLabel : `${previousPeriodLabel}の最高連続通話`,
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
  const trendLabels = metric === "inactive" ? inactiveMemberLabels : labels;
  const selectedPoint =
    selectedPointIndex !== null && points[selectedPointIndex] !== undefined
      ? {
          index: selectedPointIndex,
          date: trendLabels[selectedPointIndex] ?? "—",
          value: points[selectedPointIndex],
        }
      : null;
  const formatTrendValue = (value: number) => {
    if (metric === "activeMessages" || metric === "messages")
      return en ? `${format(value)} messages` : `${format(value)}件`;
    if (metric === "members" || metric === "active" || metric === "inactive")
      return en ? `${format(value)} members` : `${format(value)}人`;
    return format(value);
  };
  const changeToneClass = change === 0
    ? "bg-secondary text-muted-foreground"
    : metric === "inactive"
      ? change < 0
        ? "bg-emerald-400/10 text-emerald-400"
        : "bg-rose-400/10 text-rose-400"
      : change > 0
        ? "bg-emerald-400/10 text-emerald-400"
        : "bg-rose-400/10 text-rose-400";
  return (
    <section className="mt-4 rounded-2xl border border-border bg-card/55 p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {en
              ? metric === "active" || metric === "inactive" || metric === "activeMessages" ? "Today compared with yesterday." : `${periodLabel} compared with ${previousPeriodLabel.toLowerCase()}.`
              : metric === "active" || metric === "inactive" || metric === "activeMessages" ? "今日と前日の実データを比較します。" : `${periodLabel}と${previousPeriodLabel}を実データで比較します。`}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${changeToneClass}`}
        >
          {change > 0 ? "+" : change < 0 ? "−" : "±"}
          {metric === "voice"
            ? formatDuration(Math.abs(change), locale)
            : metric === "reactions"
              ? `${Math.abs(change).toFixed(1)}pt`
              : Math.abs(change).toLocaleString()}
        </span>
      </div>
      <div className="mt-5 space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
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
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-muted-foreground">
              {en ? "Trend in selected period" : "選択期間の推移"}
            </span>
            <span className="text-muted-foreground">{periodLabel}</span>
          </div>
          {points.length > 0 && (
            <div className={`mt-3 flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${selectedPoint ? "border-primary/40 bg-primary/[0.08]" : "border-border/70 bg-background/30 text-muted-foreground"}`} aria-live="polite">
              {selectedPoint ? (
                <>
                  <span className="font-semibold">
                    {selectedPoint.date} · {selectedPoint.index === points.length - 1 ? (en ? "00:00–now" : "0:00〜現在") : (en ? "daily total" : "日別集計")}
                  </span>
                  <strong className="text-sm text-foreground">{formatTrendValue(selectedPoint.value)}</strong>
                </>
              ) : (
                <span>{en ? "Click or tap a bar to view its date and value." : `棒グラフをクリック／タップすると日付と${metric === "inactive" ? "人数" : "件数"}を表示します。`}</span>
              )}
            </div>
          )}
          <div className="mt-2 flex h-32 items-end gap-1.5 rounded-xl border border-border/70 bg-background/30 p-3">
            {points.length ? (
              points.map((point, index) => (
                <button
                  type="button"
                  key={index}
                  onClick={() => setSelectedPointIndex(index)}
                  className={`min-w-[5px] flex-1 rounded-t-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selectedPointIndex === index ? "bg-primary ring-2 ring-primary/35" : "bg-primary/70 hover:bg-primary"}`}
                  style={{ height: `${Math.max(5, (point / max) * 100)}%` }}
                  title={`${trendLabels[index] ?? ""} · ${formatTrendValue(point)}`}
                  aria-label={`${trendLabels[index] ?? ""} ${formatTrendValue(point)}`}
                  aria-pressed={selectedPointIndex === index}
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
          {(metric === "activeMessages" || metric === "inactive") && points.length > 0 && (
            <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1" aria-label={metric === "inactive" ? (en ? "Daily inactive member history" : "非アクティブメンバーの日別履歴") : (en ? "Daily active message history" : "アクティブメッセージの日別履歴")}>
              {points.map((point, index) => (
                <button
                  type="button"
                  key={`${trendLabels[index] ?? index}-${index}`}
                  onClick={() => setSelectedPointIndex(index)}
                  aria-pressed={selectedPointIndex === index}
                  className={`min-w-[76px] rounded-lg border px-2.5 py-2 text-center transition-colors ${selectedPointIndex === index ? "border-primary/60 bg-primary/[0.12]" : "border-border/70 bg-background/35 hover:border-primary/35"}`}
                >
                  <p className="text-[10px] text-muted-foreground">{trendLabels[index] ?? "—"}</p>
                  <p className="mt-0.5 text-sm font-bold">{format(point)}</p>
                </button>
              ))}
            </div>
          )}
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

function formatElapsed(value: string | number, english = false) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (elapsedSeconds < 60) return english ? "just now" : "たった今";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return english ? `${minutes} min ago` : `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return english ? `${hours} hr ago` : `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return english ? `${days} day${days === 1 ? "" : "s"} ago` : `${days}日前`;
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
