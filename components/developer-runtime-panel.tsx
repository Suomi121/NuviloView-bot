'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Cpu, Database, RefreshCw, Server } from 'lucide-react'

type RuntimeLease = {
  serviceKey: string
  ownerInstanceId: string | null
  hostId: string | null
  fencingToken: string
  leaseExpiresAt: string
  acquiredAt: string | null
  renewedAt: string | null
}

type RuntimeHeartbeat = {
  instanceId: string
  hostId: string
  fencingToken: string | null
  platform: string
  startedAt: string
  lastHeartbeatAt: string
  status: string
  leaseState: string
  appVersion: string
  guildCount: number
  stoppedAt: string | null
}

type RuntimeData = {
  enabled: boolean
  dbNow: string | null
  lease: RuntimeLease | null
  diagnostic: {
    state: 'Healthy' | 'Warning' | 'Critical' | 'Unknown'
    heartbeatAgeSeconds: number | null
    incidents: Array<{ code: string; message: string }>
  }
}

function relativeSeconds(value: string | null, now: number) {
  if (!value) return '記録なし'
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000))
  if (seconds < 60) return `${seconds}秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`
  return `${Math.floor(seconds / 3600)}時間前`
}

function shortInstance(value: string | null) {
  if (!value) return '—'
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export function DeveloperRuntimePanel() {
  const [runtime, setRuntime] = useState<RuntimeData | null>(null)
  const [heartbeats, setHeartbeats] = useState<RuntimeHeartbeat[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const load = async () => {
    try {
      const [runtimeResponse, heartbeatResponse] = await Promise.all([
        fetch('/api/developer/runtime/lease', { cache: 'no-store' }),
        fetch('/api/developer/runtime/heartbeats?limit=50', { cache: 'no-store' }),
      ])
      if (!runtimeResponse.ok || !heartbeatResponse.ok) throw new Error('runtime unavailable')
      const [runtimeData, heartbeatData] = await Promise.all([
        runtimeResponse.json(),
        heartbeatResponse.json(),
      ])
      setRuntime(runtimeData)
      setHeartbeats(Array.isArray(heartbeatData.heartbeats) ? heartbeatData.heartbeats : [])
      setError(false)
      setNow(Date.now())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const visibleHosts = useMemo(() => {
    const latest = new Map<string, RuntimeHeartbeat>()
    for (const heartbeat of heartbeats) {
      if (!latest.has(heartbeat.hostId)) latest.set(heartbeat.hostId, heartbeat)
    }
    return [...latest.values()].slice(0, 8)
  }, [heartbeats])

  const state = runtime?.diagnostic.state ?? 'Unknown'
  const stateColor = state === 'Healthy'
    ? 'text-emerald-400 bg-emerald-500/15'
    : state === 'Warning'
      ? 'text-amber-400 bg-amber-500/15'
      : 'text-rose-400 bg-rose-500/15'

  return <section className="mt-7 rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary"><Activity className="h-5 w-5" /></span>
        <div><h2 className="font-bold">Runtime / Distributed Singleton</h2><p className="mt-1 text-xs text-muted-foreground">DB LeaseでWindows・Android・Render間の同時接続を防止します。</p></div>
      </div>
      <div className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${stateColor}`}>{state.toUpperCase()}</span><button onClick={() => { setLoading(true); void load() }} className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary" aria-label="Runtimeを更新"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></div>
    </div>

    {error && <p className="mt-4 flex items-center gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-xs text-rose-300"><AlertTriangle className="h-4 w-4" />Runtime情報を取得できません。Migrationと環境設定を確認してください。</p>}
    {!error && runtime && <>
      {!runtime.enabled && <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">Distributed Singletonはまだ無効です。Migration後、全Hostの設定を揃えてから有効化してください。</p>}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <RuntimeValue icon={<Server className="h-4 w-4" />} label="Active Host" value={runtime.lease?.hostId || 'Ownerなし'} />
        <RuntimeValue icon={<Cpu className="h-4 w-4" />} label="Instance" value={shortInstance(runtime.lease?.ownerInstanceId ?? null)} />
        <RuntimeValue icon={<Database className="h-4 w-4" />} label="Fencing Token" value={runtime.lease?.fencingToken ? `#${runtime.lease.fencingToken}` : '—'} />
        <RuntimeValue icon={<Activity className="h-4 w-4" />} label="Heartbeat" value={runtime.diagnostic.heartbeatAgeSeconds == null ? '記録なし' : `${Math.floor(runtime.diagnostic.heartbeatAgeSeconds)}秒前`} />
      </div>
      {runtime.diagnostic.incidents.length > 0 && <div className="mt-4 rounded-xl border border-amber-500/20 bg-background/50 px-4 py-3 text-xs text-muted-foreground">{runtime.diagnostic.incidents.map((incident) => <p key={incident.code}>• {incident.message}</p>)}</div>}
      <div className="mt-5 overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[720px] text-left text-xs"><thead className="bg-background/70 text-muted-foreground"><tr><th className="px-3 py-2.5">Host</th><th className="px-3 py-2.5">Platform</th><th className="px-3 py-2.5">State</th><th className="px-3 py-2.5">Instance</th><th className="px-3 py-2.5">Version</th><th className="px-3 py-2.5">Last heartbeat</th></tr></thead><tbody>{visibleHosts.map((heartbeat) => {
          const owner = runtime.lease?.ownerInstanceId === heartbeat.instanceId && String(runtime.lease?.fencingToken) === String(heartbeat.fencingToken)
          return <tr key={heartbeat.instanceId} className="border-t border-border"><td className="px-3 py-3 font-bold">{heartbeat.hostId}{owner && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">OWNER</span>}</td><td className="px-3 py-3 text-muted-foreground">{heartbeat.platform}</td><td className="px-3 py-3">{heartbeat.status} / {heartbeat.leaseState}</td><td className="px-3 py-3 font-mono text-muted-foreground">{shortInstance(heartbeat.instanceId)}</td><td className="px-3 py-3 text-muted-foreground">{heartbeat.appVersion}</td><td className="px-3 py-3 text-muted-foreground">{relativeSeconds(heartbeat.lastHeartbeatAt, now)}</td></tr>
        })}{visibleHosts.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">Heartbeat履歴はまだありません。</td></tr>}</tbody></table>
      </div>
    </>}
  </section>
}

function RuntimeValue({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-background/45 p-3.5"><p className="flex items-center gap-2 text-[11px] font-bold text-muted-foreground">{icon}{label}</p><p className="mt-2 truncate font-mono text-sm font-bold">{value}</p></div>
}
