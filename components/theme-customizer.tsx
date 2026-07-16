'use client'

import { Check, LoaderCircle, Palette, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { defaultGuildTheme, guildThemeStyle, type GuildTheme } from '@/lib/guild-theme'

type Guild = { id: string; name: string }

const colorFields: Array<{ key: keyof Pick<GuildTheme, 'primaryColor' | 'accentColor' | 'backgroundColor' | 'cardColor'>; label: string; description: string }> = [
  { key: 'primaryColor', label: 'メインカラー', description: '主要ボタン・強調表示' },
  { key: 'accentColor', label: 'アクセントカラー', description: '補助的な強調表示' },
  { key: 'backgroundColor', label: '背景色', description: 'ダッシュボード全体' },
  { key: 'cardColor', label: 'カード背景', description: 'カード・サイドバー' },
]

export function ThemeCustomizer({ guilds }: { guilds: Guild[] }) {
  const [guildId, setGuildId] = useState('')
  const [theme, setTheme] = useState<GuildTheme>(defaultGuildTheme)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!guildId) {
      setTheme(defaultGuildTheme)
      return
    }
    let active = true
    setLoading(true)
    fetch(`/api/settings/theme?guildId=${encodeURIComponent(guildId)}`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { if (active && data.theme) { setTheme(data.theme); setDirty(false) } })
      .catch(() => { if (active) setStatus('テーマ設定を読み込めませんでした。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [guildId])

  const update = <K extends keyof GuildTheme>(key: K, value: GuildTheme[K]) => { setTheme((current) => ({ ...current, [key]: value })); setDirty(true); setStatus('') }
  const save = async () => {
    if (!guildId) return
    setSaving(true); setStatus('')
    try {
      const response = await fetch('/api/settings/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guildId, theme }) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || '保存できませんでした。')
      setTheme(data.theme); setDirty(false); setStatus('保存しました。ダッシュボードを開き直すと反映されます。')
    } catch (error) { setStatus(error instanceof Error ? error.message : '保存できませんでした。') } finally { setSaving(false) }
  }
  const reset = async () => {
    if (!guildId) return
    setSaving(true); setStatus('')
    try {
      const response = await fetch(`/api/settings/theme?guildId=${encodeURIComponent(guildId)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || '初期化できませんでした。')
      setTheme(data.theme ?? defaultGuildTheme); setDirty(false); setStatus('初期設定へ戻しました。')
    } catch (error) { setStatus(error instanceof Error ? error.message : '初期化できませんでした。') } finally { setSaving(false) }
  }

  return <section className="mt-4 rounded-xl border border-border bg-background/40 p-4">
    <div className="flex gap-3"><Palette className="mt-0.5 h-5 w-5 text-primary" /><div className="min-w-0 flex-1"><h2 className="text-sm font-bold">サーバー別テーマ</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">選択したサーバーのダッシュボードだけに適用されます。他のサーバーや他ユーザーには影響しません。</p>
      <select disabled={!guilds.length || loading} value={guildId} onChange={(event) => setGuildId(event.target.value)} className="mt-4 h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary">{guilds.length ? <><option value="" disabled>サーバーを選択してください</option>{guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</> : <option>管理できるサーバーがありません</option>}</select>
      {!guildId && guilds.length > 0 && <p className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">テーマを変更するサーバーを選択すると、現在の設定を読み込んで編集できます。</p>}
      {guildId && <>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{colorFields.map((field) => <label key={field.key} className="rounded-lg border border-border bg-card/50 p-3"><span className="block text-sm font-bold">{field.label}</span><span className="mt-1 block text-xs text-muted-foreground">{field.description}</span><span className="mt-3 flex items-center gap-2"><input aria-label={field.label} type="color" value={theme[field.key]} onChange={(event) => update(field.key, event.target.value)} className="h-9 w-11 cursor-pointer rounded border-0 bg-transparent p-0" /><input value={theme[field.key]} onChange={(event) => update(field.key, event.target.value)} pattern="^#[0-9a-fA-F]{6}$" className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus:border-primary" /></span></label>)}</div>
      <div className="mt-4"><p className="text-sm font-bold">角丸</p><div className="mt-2 flex flex-wrap gap-2">{([{ value: 'compact', label: 'コンパクト' }, { value: 'default', label: '標準' }, { value: 'rounded', label: 'ラウンド' }] as const).map(({ value, label }) => <button key={value} onClick={() => update('radius', value)} className={`rounded-lg border px-4 py-2 text-xs font-bold ${theme.radius === value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>{label}</button>)}</div></div>
      <div className="mt-4"><label className="text-sm font-bold">ロゴ画像URL <span className="font-normal text-muted-foreground">(任意)</span><input value={theme.logoUrl ?? ''} type="url" placeholder="https://…" onChange={(event) => update('logoUrl', event.target.value || null)} className="mt-2 h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-normal outline-none focus:border-primary" /></label></div>
      <div style={guildThemeStyle(theme)} className="mt-5 overflow-hidden rounded-[var(--radius)] border border-border bg-background p-4 text-foreground transition-colors"><p className="text-[10px] font-bold tracking-[.16em] text-primary">LIVE PREVIEW</p><div className="mt-3 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[calc(var(--radius)*.9)] bg-primary text-sm font-extrabold text-primary-foreground">{theme.logoUrl ? <img src={theme.logoUrl} alt="" className="h-full w-full object-cover" /> : theme.brandName.slice(0, 1)}</span><div><p className="font-bold">{theme.brandName || 'サービス名'}</p><p className="text-xs text-muted-foreground">選択中のサーバー用テーマ</p></div><span className="ml-auto rounded-[calc(var(--radius)*.8)] bg-primary px-3 py-2 text-xs font-bold text-primary-foreground">サンプル</span></div><div className="mt-4 rounded-[calc(var(--radius)*.8)] bg-card p-3"><span className="inline-flex rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-accent-foreground">アクセント</span><p className="mt-2 text-xs text-muted-foreground">色・カード・角丸を即時に確認できます。</p></div></div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className={`text-xs ${status.includes('でき') ? 'text-destructive' : 'text-emerald-400'}`}>{status}</p><button disabled={!guildId || saving} onClick={() => void reset()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground disabled:opacity-60"><RotateCcw className="h-3.5 w-3.5" />初期化</button></div>
      </>}
    </div></div>
    {dirty && guildId && <div className="fixed inset-x-4 bottom-5 z-50 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-2xl border border-border bg-card/95 px-4 py-3 shadow-2xl shadow-black/40 backdrop-blur-xl transition-all duration-300 sm:inset-x-auto sm:w-[min(36rem,calc(100%-2rem))]"><p className="min-w-0 text-sm font-medium text-muted-foreground">テーマに未保存の変更があります</p><button disabled={saving || loading} onClick={() => void save()} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}保存</button></div>}
  </section>
}
