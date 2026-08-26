'use client'

import { useEffect, useMemo, useState } from 'react'
import { Ban, CheckCircle2, Clock3, RefreshCcw, RefreshCw, Search, Server, ShieldAlert, ShieldCheck, Unlock } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { DeveloperRuntimePanel } from '@/components/developer-runtime-panel'

type ManagedGuild = {
  guildId: string
  name: string | null
  iconUrl: string | null
  ownerId: string | null
  memberCount: number | null
  isConnected: boolean | null
  lastSeenAt: string | null
  reason: string | null
  blockedBy: string | null
  blockedAt: string | null
}

type AuditEntry = {
  id: number
  guildId: string
  action: 'block' | 'unblock'
  reason: string | null
  performedBy: string
  performedByName: string | null
  source: string
  createdAt: string
}

type PendingAction = { action: 'block' | 'unblock'; guild: ManagedGuild }

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function DeveloperPage() {
  const [guilds, setGuilds] = useState<ManagedGuild[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [auditIntegrity, setAuditIntegrity] = useState<{ valid: boolean; checked: number }>({ valid: true, checked: 0 })
  const [bot, setBot] = useState<{ online: boolean; lastSeenAt: string | null }>({ online: false, lastSeenAt: null })
  const [guildResetAvailable, setGuildResetAvailable] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [booting, setBooting] = useState(true)
  const [saving, setSaving] = useState(false)
  const [forbidden, setForbidden] = useState(false)

  const load = async (initial = false, includeAudit = true) => {
    const startedAt = Date.now()
    try {
      const response = await fetch(
        includeAudit ? '/api/developer/guilds' : '/api/developer/guilds?includeAudit=false',
        { cache: 'no-store' },
      )
      if (response.status === 403) {
        setForbidden(true)
        return
      }
      if (!response.ok) throw new Error('load failed')
      const data = await response.json()
      setGuilds(Array.isArray(data.guilds) ? data.guilds : [])
      if (Array.isArray(data.audit)) setAudit(data.audit)
      if (data.auditIntegrity) setAuditIntegrity(data.auditIntegrity)
      setBot(data.bot ?? { online: false, lastSeenAt: null })
      setGuildResetAvailable(data.guildResetAvailable === true)
      setForbidden(false)
    } catch {
      setMessage('管理データを取得できませんでした。')
    } finally {
      if (initial) {
        window.setTimeout(() => setBooting(false), Math.max(0, 850 - (Date.now() - startedAt)))
      } else {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    void load(true)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false, false)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const filteredGuilds = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return guilds
    return guilds.filter((guild) => `${guild.name ?? ''} ${guild.guildId}`.toLowerCase().includes(normalized))
  }, [guilds, query])

  const openAction = (action: PendingAction['action'], guild: ManagedGuild) => {
    setPending({ action, guild })
    setReason('')
    setMessage('')
  }

  const submitAction = async () => {
    if (!pending) return
    setSaving(true)
    try {
      const response = await fetch('/api/developer/guilds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: pending.action, guildId: pending.guild.guildId, reason }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || '操作に失敗しました。')
      setMessage(data.message || '更新しました。')
      setPending(null)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作に失敗しました。')
    } finally {
      setSaving(false)
    }
  }

  if (booting) {
    return <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-6 text-foreground">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[34rem] w-[34rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[130px]" />
      <section className="relative w-full max-w-sm rounded-3xl border border-border/80 bg-card/70 p-7 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
        <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-2xl bg-primary/20 [animation-duration:1.8s]" />
          <span className="absolute inset-1 animate-spin rounded-[18px] border-2 border-primary/20 border-t-primary [animation-duration:1.5s]" />
          <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><ShieldCheck className="h-5 w-5" /></span>
        </div>
        <p className="mt-7 text-center text-[11px] font-bold tracking-[.2em] text-primary">NUVILOVIEW · SECURE ACCESS</p>
        <h1 className="mt-3 text-center text-2xl font-extrabold tracking-tight">Developer Console</h1>
        <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">Discordアカウントと開発者権限を確認しています</p>
        <div className="mt-7 space-y-3 rounded-2xl border border-border/70 bg-background/50 p-4 text-xs">
          <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-primary" />セキュアセッションを確認中</p>
          <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="h-4 w-4 animate-pulse text-primary" />Discord IDを照合中</p>
          <p className="flex items-center gap-2 text-muted-foreground"><span className="h-4 w-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />Guild管理データを取得中</p>
        </div>
      </section>
    </main>
  }

  if (forbidden) {
    return <main className="min-h-screen bg-background text-foreground"><SiteHeader /><section className="mx-auto max-w-xl px-6 pb-24 pt-32"><div className="rounded-2xl border border-destructive/30 bg-card p-7 text-center"><ShieldAlert className="mx-auto h-8 w-8 text-destructive" /><h1 className="mt-4 text-xl font-bold">アクセスできません</h1><p className="mt-2 text-sm text-muted-foreground">この画面は登録済みのDiscord開発者アカウントのみ利用できます。</p></div></section></main>
  }

  return <main className="min-h-screen bg-background text-foreground"><SiteHeader />
    <section className="mx-auto max-w-6xl px-5 pb-20 pt-28 sm:px-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div><p className="text-xs font-bold tracking-[.18em] text-primary">DEVELOPER CONSOLE</p><h1 className="mt-2 text-3xl font-extrabold tracking-tight">Guild管理</h1><p className="mt-2 text-sm text-muted-foreground">Botの導入先・停止状態・ブロック操作を開発者だけが管理できます。</p></div>
        <button onClick={() => { setLoading(true); void load() }} className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-bold hover:bg-secondary"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />更新</button>
      </div>

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatusCard label="Bot接続状態" value={bot.online ? 'オンライン' : 'オフライン'} detail={bot.lastSeenAt ? `最終記録: ${formatDate(bot.lastSeenAt)}` : '生存記録はまだありません'} tone={bot.online ? 'good' : 'bad'} />
        <StatusCard label="管理対象Guild" value={`${guilds.length}件`} detail="ブロック済みを含む" tone="neutral" />
        <StatusCard label="ブロック済み" value={`${guilds.filter((guild) => Boolean(guild.reason)).length}件`} detail="解除しても操作履歴は残ります" tone="bad" />
      </div>

      <DeveloperRuntimePanel />

      {message && <p className="mt-5 rounded-xl border border-border bg-card px-4 py-3 text-sm">{message}</p>}
      <div className="mt-7 grid gap-7 lg:grid-cols-[1.55fr_.85fr]">
        <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold">Guild一覧</h2><p className="mt-1 text-xs text-muted-foreground">ブロックはデータ削除後、Botが15秒以内に退出します。</p></div><label className="relative block"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Guild名・IDを検索" className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary sm:w-56" /></label></div>
          <div className="mt-5 space-y-2">{filteredGuilds.map((guild) => <GuildRow key={guild.guildId} guild={guild} guildResetAvailable={guildResetAvailable} onBlock={() => openAction('block', guild)} onUnblock={() => openAction('unblock', guild)} />)}{!loading && filteredGuilds.length === 0 && <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">該当するGuildはありません。</p>}</div>
        </section>
        <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-primary" /><div><h2 className="font-bold">完全な操作履歴</h2><p className="mt-1 text-xs text-muted-foreground">ブロック解除後も、実行者・日時・理由を保持します。</p></div></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${auditIntegrity.valid ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>{auditIntegrity.valid ? `整合性確認済み · ${auditIntegrity.checked}件` : '整合性エラー'}</span></div><div className="mt-5 max-h-[54rem] space-y-4 overflow-y-auto pr-1">{audit.length ? audit.map((entry) => <div key={entry.id} className="border-l-2 border-border pl-3"><p className={`text-xs font-bold ${entry.action === 'block' ? 'text-rose-400' : 'text-emerald-400'}`}>{entry.action === 'block' ? 'BLOCK' : 'UNBLOCK'} · {entry.guildId}</p><p className="mt-1 text-xs text-muted-foreground">{entry.reason || '理由なし'} · {entry.performedByName || entry.performedBy}</p><p className="mt-1 text-[11px] text-muted-foreground">{formatDate(entry.createdAt)} · {entry.source === 'developer_dashboard' ? '管理画面' : 'Botコマンド'}</p></div>) : <p className="text-sm text-muted-foreground">まだ操作ログはありません。</p>}</div></section>
      </div>
    </section>
    {pending && <ConfirmDialog pending={pending} reason={reason} setReason={setReason} saving={saving} onClose={() => !saving && setPending(null)} onSubmit={() => void submitAction()} />}
  </main>
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'good' | 'bad' | 'neutral' }) {
  const color = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-primary'
  return <div className="rounded-2xl border border-border bg-card/60 p-5"><p className="text-xs font-bold text-muted-foreground">{label}</p><p className={`mt-2 text-xl font-extrabold ${color}`}>{value}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></div>
}

function GuildRow({ guild, guildResetAvailable, onBlock, onUnblock }: { guild: ManagedGuild; guildResetAvailable: boolean; onBlock: () => void; onUnblock: () => void }) {
  const blocked = Boolean(guild.reason)
  return <article className="flex flex-col gap-3 rounded-xl border border-border bg-background/45 p-3.5 sm:flex-row sm:items-center"><div className="flex min-w-0 flex-1 items-center gap-3">{guild.iconUrl ? <img src={guild.iconUrl} alt="" className="h-10 w-10 rounded-xl object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary"><Server className="h-5 w-5" /></span>}<div className="min-w-0"><p className="truncate text-sm font-bold">{guild.name || `Guild ${guild.guildId}`}</p><p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{guild.guildId} · {guild.memberCount?.toLocaleString() ?? '—'} members</p><p className="mt-1 text-[11px] text-muted-foreground">{blocked ? `理由: ${guild.reason}` : guild.isConnected ? `接続中 · 最終確認 ${formatDate(guild.lastSeenAt)}` : 'Botは現在このGuildにいません'}</p></div></div><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${blocked ? 'bg-rose-500/15 text-rose-400' : guild.isConnected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>{blocked ? 'BLOCKED' : guild.isConnected ? 'CONNECTED' : 'OFFLINE'}</span>{!blocked && guild.isConnected && (guildResetAvailable ? <a href={`/developer/guilds/${guild.guildId}/reset`} className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 px-3 py-2 text-xs font-bold text-primary hover:bg-primary/10"><RefreshCcw className="h-3.5 w-3.5" />初期化</a> : <span className="rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground">初期化 OFF</span>)}{blocked ? <button onClick={onUnblock} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/10"><Unlock className="h-3.5 w-3.5" />解除</button> : <button onClick={onBlock} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-3 py-2 text-xs font-bold text-rose-400 hover:bg-rose-500/10"><Ban className="h-3.5 w-3.5" />ブロック</button>}</div></article>
}

function ConfirmDialog({ pending, reason, setReason, saving, onClose, onSubmit }: { pending: PendingAction; reason: string; setReason: (value: string) => void; saving: boolean; onClose: () => void; onSubmit: () => void }) {
  const blocking = pending.action === 'block'
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm"><div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"><div className={`flex h-11 w-11 items-center justify-center rounded-xl ${blocking ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'}`}>{blocking ? <ShieldAlert className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}</div><h2 className="mt-4 text-lg font-extrabold">{blocking ? 'Guildをブロックしますか？' : 'Guildのブロックを解除しますか？'}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{blocking ? 'Botは分析データを削除し、15秒以内にこのGuildから退出します。この操作は履歴に残ります。' : 'Botは自動では再参加しません。必要な場合は招待URLから改めて導入してください。'}</p><p className="mt-3 rounded-lg bg-background px-3 py-2 font-mono text-xs text-muted-foreground">{pending.guild.guildId}</p>{blocking && <label className="mt-5 block text-sm font-bold">ブロック理由<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={300} rows={3} placeholder="例: 利用規約違反の調査対応" className="mt-2 w-full rounded-lg border border-border bg-background p-3 text-sm font-normal outline-none focus:border-primary" /></label>}<div className="mt-6 flex justify-end gap-3"><button disabled={saving} onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-bold text-muted-foreground hover:bg-secondary">キャンセル</button><button disabled={saving || (blocking && reason.trim().length < 3)} onClick={onSubmit} className={`rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50 ${blocking ? 'bg-rose-500 hover:bg-rose-400' : 'bg-emerald-600 hover:bg-emerald-500'}`}>{saving ? '処理中…' : blocking ? 'ブロックを確定' : '解除を確定'}</button></div></div></div>
}
