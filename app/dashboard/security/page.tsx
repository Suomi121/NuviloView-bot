"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Eye,
  FileClock,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";

type Guild = { id: string; name: string; icon: string | null };
type Overview = {
  guild: { id: string; name: string; connected: boolean };
  featureEnabled: boolean;
  scopes: string[];
  protection: { enabled: boolean; mode: "shadow" | "monitor" | "manual" | "protect" | "strict"; status: string; reason: string | null; lastDiagnosticAt: string | null; missingPermissions: string[] };
  riskScore: number;
  openIncidents: number;
  last24HoursIncidents: number;
  last7DaysIncidents: number;
  criticalIncidents: number;
  last24HoursActions: number;
  lastIncidentAt: string | null;
};
type Incident = {
  id: string; actorId: string | null; actorType: string; actorName: string | null;
  incidentType: string | null; actionTaken: Record<string, unknown>;
  severity: string; riskScore: number; riskExplanation: Record<string, unknown>;
  status: string; firstDetectedAt: string; lastDetectedAt: string; actionCount: number;
  trustedActor: boolean; guildOwner: boolean; selfActor: boolean; containmentStatus: string;
};
type IncidentDetail = {
  incident: Incident & { resolutionReason?: string | null };
  actions: Array<{ id: number; actionType: string; targetId: string | null; occurredAt: string; riskWeight: number; metadata: Record<string, unknown> }>;
  audit: Array<{ id: number; eventType: string; actorName: string | null; source: string; createdAt: string }>;
  actorProfile: { nameAtDetection: string | null; actorTypeAtDetection: string; currentMemberStatus: string; note: string };
  scopes: string[];
};
type PolicyResponse = {
  policy: {
    enabled: boolean; mode: "shadow" | "monitor" | "manual" | "protect" | "strict"; sensitivity: string; alertEnabled: boolean;
    alertChannelId: string | null; manualContainment: boolean; automaticContainment: boolean;
    channelProtection: boolean; roleProtection: boolean; autoRestore: boolean;
    webhookProtection: boolean; botSpamProtection: boolean; botDuplicateSpam: boolean; botEveryoneSpam: boolean;
    detectorThresholds: Record<string, number>; missingPermissions: string[];
    snapshotEnabled: boolean; snapshotRetentionCount: number; snapshotRetentionDays: number;
    incidentRetentionDays: number; protectionStatus: string; statusReason: string | null;
  };
  trustedActors: Array<{ actorId: string; label: string | null; actorType: string; createdAt: string }>;
  guildOwner: { actorId: string; trustedAutomatically: boolean } | null;
  scopes: string[];
};
type Snapshot = { id: string; source: string; schemaVersion: number; checksum: string; createdAt: string; channelCount: number; roleCount: number };

const severityClass: Record<string, string> = {
  Critical: "border-red-500/35 bg-red-500/10 text-red-300",
  High: "border-orange-500/35 bg-orange-500/10 text-orange-300",
  Suspicious: "border-amber-500/35 bg-amber-500/10 text-amber-300",
  Normal: "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
};
const actionLabels: Record<string, string> = {
  CHANNEL_CREATE: "チャンネル作成", CHANNEL_DELETE: "チャンネル削除", ROLE_CREATE: "ロール作成", ROLE_DELETE: "ロール削除", MEMBER_BAN: "メンバーBAN",
  MEMBER_KICK: "メンバーKick", WEBHOOK_CREATE: "Webhook作成", WEBHOOK_DELETE: "Webhook削除",
  BOT_ADDITION: "Bot / Application追加", INTEGRATION_DELETE: "Integration削除",
  ADMINISTRATOR_GRANT: "Administrator付与", DANGEROUS_PERMISSION: "危険な権限変更",
  GUILD_SETTING_CHANGE: "Guild設定変更",
  BOT_DUPLICATE_SPAM: "Bot重複スパム", BOT_EVERYONE_SPAM: "Bot everyone/hereスパム",
};
const incidentLabels: Record<string, string> = {
  CHANNEL_NUKE: "Channel / Category Nuke", ROLE_NUKE: "Role Nuke", WEBHOOK_NUKE: "Webhook Nuke",
  BOT_DUPLICATE_SPAM: "Bot Duplicate Spam", BOT_EVERYONE_SPAM: "Bot Everyone Spam",
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error === "Unauthorized" ? "ログインが必要です。" : body.error;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return body as T;
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function statusTone(status: string) {
  if (status === "Active") return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  if (status === "Limited") return "text-amber-300 bg-amber-500/10 border-amber-500/30";
  if (status === "Error") return "text-red-300 bg-red-500/10 border-red-500/30";
  return "text-muted-foreground bg-secondary border-border";
}

export default function SecurityPage() {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildId, setGuildId] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [policyData, setPolicyData] = useState<PolicyResponse | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trustedActorId, setTrustedActorId] = useState("");
  const [trustedLabel, setTrustedLabel] = useState("");
  const [operationResult, setOperationResult] = useState<Record<string, unknown> | null>(null);

  const scopes = overview?.scopes ?? [];
  const canManagePolicy = scopes.includes("ManageSecurityPolicy");
  const canContain = scopes.includes("ContainActor");
  const canRestore = scopes.includes("RestoreStructure");
  const selectedGuild = useMemo(() => guilds.find((guild) => guild.id === guildId), [guildId, guilds]);

  const loadGuildData = useCallback(async (targetGuildId: string, selectedIncidentId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = `guildId=${encodeURIComponent(targetGuildId)}`;
      const [nextOverview, incidentResponse, nextPolicy, snapshotResponse] = await Promise.all([
        fetch(`/api/security/overview?${query}`, { cache: "no-store" }).then(readJson<Overview>),
        fetch(`/api/security/incidents?${query}`, { cache: "no-store" }).then(readJson<{ incidents: Incident[] }>),
        fetch(`/api/security/policy?${query}`, { cache: "no-store" }).then(readJson<PolicyResponse>),
        fetch(`/api/security/snapshots?${query}`, { cache: "no-store" }).then(readJson<{ snapshots: Snapshot[] }>),
      ]);
      setOverview(nextOverview);
      setIncidents(incidentResponse.incidents);
      setPolicyData(nextPolicy);
      setSnapshots(snapshotResponse.snapshots);
      const incidentId = selectedIncidentId;
      if (incidentId) {
        const nextDetail = await fetch(`/api/security/incidents/${encodeURIComponent(incidentId)}?${query}`, { cache: "no-store" }).then(readJson<IncidentDetail>);
        setDetail(nextDetail);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Security情報を取得できませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/guilds", { cache: "no-store" }).then(readJson<{ guilds: Guild[] }>);
        setGuilds(response.guilds);
        const requested = new URL(window.location.href).searchParams.get("guildId");
        const initial = response.guilds.some((guild) => guild.id === requested) ? requested! : response.guilds[0]?.id ?? "";
        setGuildId(initial);
        if (initial) await loadGuildData(initial);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "管理Guildを取得できませんでした。");
        setLoading(false);
      }
    })();
  }, [loadGuildData]);

  async function selectGuild(nextGuildId: string) {
    setGuildId(nextGuildId);
    setDetail(null);
    setOperationResult(null);
    window.history.replaceState(null, "", `/dashboard/security?guildId=${encodeURIComponent(nextGuildId)}`);
    await loadGuildData(nextGuildId);
  }

  async function openIncident(id: string) {
    setBusy(true);
    setError(null);
    try {
      const nextDetail = await fetch(`/api/security/incidents/${encodeURIComponent(id)}?guildId=${encodeURIComponent(guildId)}`, { cache: "no-store" }).then(readJson<IncidentDetail>);
      setDetail(nextDetail);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Incidentを取得できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(path: string, body: Record<string, unknown>, method = "POST") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, ...body }),
      }).then(readJson<Record<string, unknown>>);
      const requestId = typeof response.requestId === "string" ? response.requestId : null;
      if (requestId) {
        let completed = false;
        for (let attempt = 0; attempt < 15; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          const poll = await fetch(`/api/security/requests/${requestId}?guildId=${encodeURIComponent(guildId)}`, { cache: "no-store" })
            .then(readJson<{ request: { status: string; result?: Record<string, unknown>; errorMessage?: string } }>);
          if (poll.request.status === "completed") { setOperationResult(poll.request.result ?? {}); completed = true; break; }
          if (poll.request.status === "failed") throw new Error(poll.request.errorMessage || "Bot側の処理に失敗しました。");
        }
        if (!completed) throw new Error("Bot側の処理はまだ完了していません。しばらくしてから再読み込みしてください。");
      }
      await loadGuildData(guildId, detail?.incident.id);
      return response;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "操作に失敗しました。");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function updatePolicy(patch: Record<string, unknown>) {
    await mutate("/api/security/policy", patch, "PUT");
  }

  const incident = detail?.incident;
  const riskExplanation = incident?.riskExplanation as {
    baseItems?: Array<{ actionType: string; points: number }>;
    bonuses?: Array<{ id: string; points: number }>;
    rawRisk?: number;
  } | undefined;
  const containmentProtected = incident?.guildOwner || incident?.trustedActor || incident?.selfActor;
  const containmentAvailable = canContain && overview?.featureEnabled && overview.protection.mode !== "shadow" && overview.protection.mode !== "monitor" && !containmentProtected;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1380px] items-center gap-4 px-5 py-4 sm:px-8">
          <a href="/dashboard" className="rounded-lg p-2 text-muted-foreground transition hover:bg-secondary hover:text-foreground" aria-label="ダッシュボードへ戻る"><ArrowLeft className="h-5 w-5" /></a>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="rounded-xl bg-primary/15 p-2 text-primary"><ShieldAlert className="h-5 w-5" /></span>
            <div><h1 className="font-bold">Security</h1><p className="text-xs text-muted-foreground">Nuke Protection v1</p></div>
          </div>
          <select value={guildId} onChange={(event) => void selectGuild(event.target.value)} className="max-w-64 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            {guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
          </select>
          <button disabled={!guildId || loading} onClick={() => void loadGuildData(guildId, detail?.incident.id)} className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary disabled:opacity-40" aria-label="再読み込み"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
        </div>
      </header>

      <div className="mx-auto max-w-[1380px] space-y-6 px-5 py-7 sm:px-8">
        {error && <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
        {!guildId && !loading && <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">管理できるGuildがありません。</div>}
        {loading && !overview ? <div className="flex min-h-80 items-center justify-center text-muted-foreground"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />Security情報を読み込んでいます</div> : overview && <>
          <section className="rounded-2xl border border-border bg-card/75 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><p className="text-xs font-bold tracking-[0.16em] text-muted-foreground">PROTECTION</p><h2 className="mt-1 text-xl font-bold">{selectedGuild?.name ?? overview.guild.name}</h2></div>
              <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusTone(overview.protection.status)}`}>● {overview.protection.status}</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{overview.protection.reason || "必要な監査権限とGateway Intentを確認済みです。"}</p>
            {overview.protection.missingPermissions.length > 0 && <p className="mt-2 text-xs text-amber-300">Protection degraded — Missing permission: {overview.protection.missingPermissions.join(", ")}</p>}
            {overview.protection.mode === "shadow" && <div className="mt-4 flex items-center gap-2 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-sm text-blue-200"><Eye className="h-4 w-4" />Shadow Mode — 検知・記録のみ。封じ込めは実行されません。</div>}
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Risk level" value={`${overview.riskScore} / 100`} note={overview.riskScore >= 90 ? "Critical" : overview.riskScore >= 60 ? "High" : overview.riskScore >= 30 ? "Suspicious" : "Normal"} />
            <Metric label="Open incidents" value={String(overview.openIncidents)} note="Open / Contained / Monitoring" />
            <Metric label="Last 24 hours" value={`${overview.last24HoursIncidents}`} note={`${overview.last24HoursActions} detected actions`} />
            <Metric label="Last 7 days" value={`${overview.last7DaysIncidents}`} note={`${overview.criticalIncidents} critical incidents`} />
            <Metric label="Last incident" value={overview.lastIncidentAt ? formatTime(overview.lastIncidentAt) : "なし"} note="Audit evidence based" compact />
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.12fr)_minmax(380px,.88fr)]">
            <section className="overflow-hidden rounded-2xl border border-border bg-card/75">
              <div className="border-b border-border px-5 py-4"><h2 className="font-bold">Incidents</h2><p className="mt-1 text-xs text-muted-foreground">Discord Audit Log Entryから関連操作をまとめて表示します。</p></div>
              <div className="divide-y divide-border">
                {incidents.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">記録されたSecurity Incidentはありません。</p> : incidents.map((item) => (
                  <button key={item.id} onClick={() => void openIncident(item.id)} className={`w-full px-5 py-4 text-left transition hover:bg-secondary/60 ${detail?.incident.id === item.id ? "bg-primary/8" : ""}`}>
                    <div className="flex items-center justify-between gap-3"><span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold ${severityClass[item.severity] ?? severityClass.Normal}`}>{item.severity}</span><span className="text-xs text-muted-foreground">{formatTime(item.lastDetectedAt)}</span></div>
                    <div className="mt-2 flex items-end justify-between gap-4"><div className="min-w-0"><p className="truncate text-sm font-semibold">{item.incidentType ? (incidentLabels[item.incidentType] ?? item.incidentType) : item.actorName || (item.actorId ? `User ${item.actorId}` : "Unknown Actor")}</p><p className="mt-1 truncate text-xs text-muted-foreground">{item.actorName || item.actorId || "Unknown Actor"} · {item.actionCount} actions · {item.status} · {item.containmentStatus}</p></div><strong className="text-lg">{item.riskScore}</strong></div>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card/75 p-5">
              {!detail ? <div className="flex min-h-72 flex-col items-center justify-center text-center text-muted-foreground"><FileClock className="mb-3 h-7 w-7" /><p className="text-sm">Incidentを選択するとTimelineとActor情報を表示します。</p></div> : <div className="space-y-5">
                <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-muted-foreground">INCIDENT</p><h2 className="mt-1 font-bold">{incident?.actorName || (incident?.actorId ? `User ${incident.actorId}` : "Unknown Actor")}</h2></div><span className={`rounded-md border px-2 py-1 text-xs font-bold ${severityClass[incident?.severity ?? "Normal"]}`}>{incident?.riskScore} / 100</span></div>
                <div className="grid grid-cols-2 gap-3 rounded-xl bg-secondary/45 p-3 text-xs"><Info label="Incident type" value={incident?.incidentType ? (incidentLabels[incident.incidentType] ?? incident.incidentType) : "Legacy risk incident"} /><Info label="Actor ID" value={incident?.actorId ?? "Unknown"} /><Info label="Type at detection" value={detail.actorProfile.actorTypeAtDetection} /><Info label="Status" value={`${incident?.status} / ${incident?.containmentStatus}`} /></div>
                {incident && Object.keys(incident.actionTaken ?? {}).length > 0 && <details open className="rounded-xl border border-border bg-secondary/30 px-3 py-2 text-xs"><summary className="cursor-pointer font-bold">Response</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap text-muted-foreground">{JSON.stringify(incident.actionTaken, null, 2)}</pre></details>}
                <div><h3 className="mb-3 text-sm font-bold">Timeline</h3><div className="space-y-3 border-l border-border pl-4">{detail.actions.map((action) => <div key={action.id} className="relative"><span className="absolute -left-[19px] top-1.5 h-2 w-2 rounded-full bg-primary" /><p className="text-sm font-semibold">{actionLabels[action.actionType] ?? action.actionType}</p><p className="mt-0.5 text-xs text-muted-foreground">{formatTime(action.occurredAt)} · target {action.targetId ?? "unknown"} · +{action.riskWeight}</p>{typeof action.metadata.targetName === "string" && <p className="mt-1 text-xs">{action.metadata.targetName}</p>}</div>)}</div></div>
                <details className="rounded-xl border border-border bg-secondary/30 px-3 py-2 text-xs"><summary className="cursor-pointer font-bold">Risk calculation</summary><div className="mt-3 space-y-1.5 text-muted-foreground">{riskExplanation?.baseItems?.map((item, index) => <p key={`${item.actionType}-${index}`} className="flex justify-between gap-3"><span>{actionLabels[item.actionType] ?? item.actionType}</span><strong className="text-foreground">+{item.points}</strong></p>)}{riskExplanation?.bonuses?.map((bonus) => <p key={bonus.id} className="flex justify-between gap-3"><span>{bonus.id}</span><strong className="text-foreground">+{bonus.points}</strong></p>)}<p className="flex justify-between gap-3 border-t border-border pt-2"><span>Raw / normalized</span><strong className="text-foreground">{riskExplanation?.rawRisk ?? incident?.riskScore} / {incident?.riskScore}</strong></p></div></details>
                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  <button disabled={!containmentAvailable || busy} onClick={() => { if (window.confirm("危険な権限を持つ、Botより下位のロールをActorから外します。続行しますか？")) void mutate(`/api/security/incidents/${incident?.id}/contain`, { confirmation: true }); }} className="rounded-lg bg-red-500 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-35">Contain actor</button>
                  <button disabled={!canManagePolicy || busy} onClick={() => void mutate(`/api/security/incidents/${incident?.id}/resolve`, { reason: "Reviewed in Security dashboard" })} className="rounded-lg border border-border px-3 py-2 text-xs font-bold hover:bg-secondary disabled:opacity-35">Resolve</button>
                  <button disabled={!canManagePolicy || busy} onClick={() => void mutate(`/api/security/incidents/${incident?.id}/false-positive`, { reason: "Marked in Security dashboard" })} className="rounded-lg border border-border px-3 py-2 text-xs font-bold hover:bg-secondary disabled:opacity-35">False positive</button>
                </div>
                {!containmentAvailable && <p className="text-xs text-muted-foreground">Containment unavailable: {overview.protection.mode === "shadow" ? "Shadow Mode" : containmentProtected ? "Guild owner / trusted actor / NuviloView self is protected" : "owner scope is required"}.</p>}
              </div>}
            </section>
          </div>

          {policyData && <section className="grid gap-6 xl:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card/75 p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h2 className="font-bold">Security Policy</h2></div><div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Toggle label="Nuke Protection" checked={policyData.policy.enabled} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ enabled: checked })} />
              <Toggle label="Channel Protection" checked={policyData.policy.channelProtection} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ channelProtection: checked })} />
              <Toggle label="Role Protection" checked={policyData.policy.roleProtection} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ roleProtection: checked })} />
              <Toggle label="Webhook Protection" checked={policyData.policy.webhookProtection} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ webhookProtection: checked })} />
              <Toggle label="Bot Spam Protection" checked={policyData.policy.botSpamProtection} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ botSpamProtection: checked })} />
              <Toggle label="Duplicate Spam" checked={policyData.policy.botDuplicateSpam} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ botDuplicateSpam: checked })} />
              <Toggle label="Everyone / Here Spam" checked={policyData.policy.botEveryoneSpam} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ botEveryoneSpam: checked })} />
              <Toggle label="Auto Restore" checked={policyData.policy.autoRestore} disabled={!canManagePolicy || busy || !["protect", "strict"].includes(policyData.policy.mode)} onChange={(checked) => void updatePolicy({ autoRestore: checked })} />
              <Toggle label="Automatic Kick" checked={policyData.policy.automaticContainment} disabled={!canManagePolicy || busy || !["protect", "strict"].includes(policyData.policy.mode)} onChange={(checked) => void updatePolicy({ automaticContainment: checked })} />
              <Toggle label="Dashboard / Discord alerts" checked={policyData.policy.alertEnabled} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ alertEnabled: checked })} />
              <Toggle label="Manual containment" checked={policyData.policy.manualContainment} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ manualContainment: checked })} />
              <Toggle label="Daily snapshot" checked={policyData.policy.snapshotEnabled} disabled={!canManagePolicy || busy} onChange={(checked) => void updatePolicy({ snapshotEnabled: checked })} />
              <label className="text-sm"><span className="mb-2 block text-xs font-bold text-muted-foreground">MODE</span><select value={policyData.policy.mode} disabled={!canManagePolicy || busy} onChange={(event) => void updatePolicy({ mode: event.target.value })} className="w-full rounded-lg border border-border bg-secondary px-3 py-2"><option value="shadow">Shadow</option><option value="monitor">Monitor only</option><option value="manual">Manual containment</option><option value="protect">Protect</option><option value="strict">Strict</option></select></label>
              <label className="text-sm"><span className="mb-2 block text-xs font-bold text-muted-foreground">SENSITIVITY</span><select value={policyData.policy.sensitivity} disabled={!canManagePolicy || busy} onChange={(event) => void updatePolicy({ sensitivity: event.target.value })} className="w-full rounded-lg border border-border bg-secondary px-3 py-2"><option value="low">Low</option><option value="balanced">Balanced</option><option value="high">High</option><option value="custom">Custom</option></select></label>
              <label className="text-sm sm:col-span-2"><span className="mb-2 block text-xs font-bold text-muted-foreground">ALERT CHANNEL ID</span><input key={`${guildId}:${policyData.policy.alertChannelId ?? ""}`} defaultValue={policyData.policy.alertChannelId ?? ""} disabled={!canManagePolicy || busy} onBlur={(event) => { const value = event.target.value.trim(); if (value !== (policyData.policy.alertChannelId ?? "")) void updatePolicy({ alertChannelId: value || null }); }} placeholder="Discord channel ID (optional)" className="w-full rounded-lg border border-border bg-secondary px-3 py-2" /></label>
              <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                {[
                  ["channelActionThreshold", "Channel threshold"], ["channelWindowSeconds", "Channel window (sec)"],
                  ["roleActionThreshold", "Role threshold"], ["roleWindowSeconds", "Role window (sec)"],
                  ["webhookThreshold", "Webhook threshold"], ["webhookWindowSeconds", "Webhook window (sec)"],
                  ["botDuplicateThreshold", "Duplicate threshold"], ["botDuplicateWindowSeconds", "Duplicate window (sec)"],
                  ["botEveryoneThreshold", "Everyone threshold"], ["botEveryoneWindowSeconds", "Everyone window (sec)"],
                ].map(([key, label]) => <NumberSetting key={`${guildId}:${key}:${policyData.policy.detectorThresholds[key] ?? 0}`} label={label} value={policyData.policy.detectorThresholds[key] ?? 0} disabled={!canManagePolicy || busy} onCommit={(value) => void updatePolicy({ detectorThresholds: { [key]: value } })} />)}
              </div>
            </div><p className="mt-4 text-xs text-muted-foreground">自動Kickと自動復旧はProtect / Strictで明示的に有効化した場合だけ動作します。復旧はbest-effortで、完全な原状復帰は保証されません。</p></div>

            <div className="rounded-2xl border border-border bg-card/75 p-5"><div className="flex items-center gap-2"><UserCheck className="h-4 w-4 text-primary" /><h2 className="font-bold">Trusted actors</h2></div>{policyData.guildOwner && <div className="mt-4 rounded-lg border border-border bg-secondary/45 px-3 py-2 text-sm"><strong>Guild Owner</strong><p className="mt-1 break-all text-xs text-muted-foreground">{policyData.guildOwner.actorId} · automatically protected</p></div>}<div className="mt-3 space-y-2">{policyData.trustedActors.map((actor) => <div key={actor.actorId} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{actor.label || actor.actorId}</p><p className="truncate text-xs text-muted-foreground">{actor.actorId} · {actor.actorType}</p></div><button disabled={!canManagePolicy || busy} onClick={() => void mutate("/api/security/trusted", { actorId: actor.actorId }, "DELETE")} className="text-xs text-red-300 disabled:opacity-30">Remove</button></div>)}</div><div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><input value={trustedActorId} onChange={(event) => setTrustedActorId(event.target.value)} placeholder="Discord User / Bot ID" className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm" /><input value={trustedLabel} onChange={(event) => setTrustedLabel(event.target.value)} placeholder="Label (optional)" className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm" /><button disabled={!canManagePolicy || busy || !trustedActorId} onClick={() => void mutate("/api/security/trusted", { actorId: trustedActorId, label: trustedLabel }).then((result) => { if (result) { setTrustedActorId(""); setTrustedLabel(""); } })} className="rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground disabled:opacity-35">Add</button></div></div>
          </section>}

          <section className="rounded-2xl border border-border bg-card/75 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold">Snapshots & Restore Preview</h2><p className="mt-1 text-xs text-muted-foreground">構造メタデータのみ。Webhook token・Bot token・message contentは保存しません。</p></div><button disabled={!canRestore || busy || !overview.featureEnabled} onClick={() => void mutate("/api/security/snapshots", {})} className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-35">Create snapshot</button></div><div className="mt-4 divide-y divide-border rounded-xl border border-border">{snapshots.length === 0 ? <p className="p-5 text-center text-sm text-muted-foreground">Snapshotはまだありません。</p> : snapshots.map((snapshot) => <div key={snapshot.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{formatTime(snapshot.createdAt)} · {snapshot.source}</p><p className="mt-1 text-xs text-muted-foreground">{snapshot.channelCount} channels · {snapshot.roleCount} roles · SHA-256 {snapshot.checksum.slice(0, 12)}…</p></div><button disabled={!canRestore || busy || !overview.featureEnabled} onClick={() => void mutate("/api/security/restore-preview", { snapshotId: snapshot.id })} className="rounded-lg border border-border px-3 py-2 text-xs font-bold hover:bg-secondary disabled:opacity-35">Restore preview</button></div>)}</div>{operationResult && <pre className="mt-4 max-h-56 overflow-auto rounded-xl bg-secondary p-4 text-xs">{JSON.stringify(operationResult, null, 2)}</pre>}<p className="mt-3 text-xs text-muted-foreground">Previewと自動復旧はいずれもbest-effortです。Discord APIの制約により完全な復元は保証されません。</p></section>
        </>}
      </div>
      {busy && <div className="fixed bottom-5 right-5 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-2xl"><LoaderCircle className="h-4 w-4 animate-spin" />処理中</div>}
    </main>
  );
}

function Metric({ label, value, note, compact = false }: { label: string; value: string; note: string; compact?: boolean }) {
  return <div className="rounded-xl border border-border bg-card/75 p-4"><p className="text-[11px] font-bold tracking-[0.12em] text-muted-foreground">{label.toUpperCase()}</p><p className={`mt-2 font-bold ${compact ? "text-sm" : "text-2xl"}`}>{value}</p><p className="mt-1 text-xs text-muted-foreground">{note}</p></div>;
}
function Info({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-1 break-all font-semibold">{value}</p></div>;
}
function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-sm"><span>{label}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-primary" /></label>;
}
function NumberSetting({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void }) {
  return <label className="text-sm"><span className="mb-1 block text-xs text-muted-foreground">{label}</span><input type="number" min={1} defaultValue={value} disabled={disabled} onBlur={(event) => { const next = Number(event.target.value); if (Number.isSafeInteger(next) && next > 0 && next !== value) onCommit(next); }} className="w-full rounded-lg border border-border bg-secondary px-3 py-2" /></label>;
}
