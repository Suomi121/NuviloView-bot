'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  DatabaseBackup,
  FileJson,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  TestTube2,
} from 'lucide-react'
import { SiteHeader } from '@/components/site-header'

type ResetSettings = {
  enabled: boolean
  protectedChannelIds: string[]
  protectedRoleIds: string[]
  resetLogChannelId: string | null
  backupChannelId: string | null
  allowedAdminIds: string[]
  maxChannelDeletes: number | null
  maxRoleDeletes: number | null
  maxTotalOperations: number | null
  guildCooldownHours: number | null
  developerCooldownMinutes: number | null
  defaultMode: 'channels_only' | 'channels_and_roles' | 'settings_reset'
}

type ResetPlan = {
  id: string
  mode: string
  dryRun: boolean
  status: string
  expiresAt: string
  createdAt: string
  targetSummary: {
    guild: { name: string; memberCount: number; channelCount: number; roleCount: number }
    channelDeleteCount: number
    roleDeleteCount: number
    totalOperationCount: number
    limitExceeded: boolean
    limitReasons: string[]
    missingPermissions: string[]
    warnings: string[]
    deleteChannels: Array<{ id: string; name: string }>
    protectedChannels: Array<{ id: string; name: string }>
    deleteRoles: Array<{ id: string; name: string }>
    protectedRoles: Array<{ id: string; name: string }>
    settingsChanges: string[]
  }
}

type ResetExecution = {
  id: string
  planId: string
  developerId: string
  developerName: string | null
  mode: string
  dryRun: boolean
  reason: string
  status: string
  backupPath: string | null
  requestedCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  operationStarted: boolean
  errorSummary: string | null
  startedAt: string
  finishedAt: string | null
}

type ResetRequest = {
  id: string
  action: 'plan' | 'confirm'
  status: 'queued' | 'running' | 'completed' | 'failed'
  result: { planId?: string; executionId?: string } | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
}

type Backup = {
  id: string
  executionId: string
  planId: string
  fileName: string
  filePath: string
  fileSize: number
  checksum: string
  schemaVersion: number
  createdAt: string
}

const defaultSettings: ResetSettings = {
  enabled: false,
  protectedChannelIds: [],
  protectedRoleIds: [],
  resetLogChannelId: null,
  backupChannelId: null,
  allowedAdminIds: [],
  maxChannelDeletes: null,
  maxRoleDeletes: null,
  maxTotalOperations: null,
  guildCooldownHours: null,
  developerCooldownMinutes: null,
  defaultMode: 'channels_only',
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function idList(value: string[]) {
  return value.join(', ')
}

function InputLabel({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <label className="block text-sm font-bold">
      {label}
      {children}
      {hint && <span className="mt-1 block text-[11px] font-normal text-muted-foreground">{hint}</span>}
    </label>
  )
}

export default function GuildResetPage() {
  const params = useParams<{ guildId: string }>()
  const guildId = params.guildId
  const [guildName, setGuildName] = useState(`Guild ${guildId}`)
  const [settings, setSettings] = useState<ResetSettings>(defaultSettings)
  const [plans, setPlans] = useState<ResetPlan[]>([])
  const [executions, setExecutions] = useState<ResetExecution[]>([])
  const [requests, setRequests] = useState<ResetRequest[]>([])
  const [backups, setBackups] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [working, setWorking] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [message, setMessage] = useState('')
  const [planId, setPlanId] = useState('')
  const [issuedCode, setIssuedCode] = useState('')
  const [code, setCode] = useState('')
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [planForm, setPlanForm] = useState({
    mode: 'channels_only' as ResetSettings['defaultMode'],
    dryRun: true,
    deleteChannels: true,
    deleteRoles: false,
    resetSettings: false,
    createDefaultChannels: false,
    keepChannelIds: '',
    keepRoleIds: '',
    reason: '',
  })

  const load = useCallback(async () => {
    try {
      const [historyResponse, backupResponse] = await Promise.all([
        fetch(`/api/developer/guilds/${guildId}/reset/history`, { cache: 'no-store' }),
        fetch(`/api/developer/guilds/${guildId}/reset/backups`, { cache: 'no-store' }),
      ])
      if (historyResponse.status === 403) {
        setForbidden(true)
        return
      }
      const history = await historyResponse.json().catch(() => null)
      const backupData = await backupResponse.json().catch(() => null)
      if (!historyResponse.ok) throw new Error(history?.error || '管理データを取得できません。')
      setGuildName(history.guild?.name || `Guild ${guildId}`)
      setSettings(history.settings ? { ...defaultSettings, ...history.settings } : defaultSettings)
      setPlans(Array.isArray(history.plans) ? history.plans : [])
      setExecutions(Array.isArray(history.executions) ? history.executions : [])
      setRequests(Array.isArray(history.requests) ? history.requests : [])
      if (backupResponse.ok) setBackups(Array.isArray(backupData?.backups) ? backupData.backups : [])
      const latestCompletedPlan = (history.requests as ResetRequest[] | undefined)?.find(
        (request) => request.action === 'plan' && request.status === 'completed' && request.result?.planId,
      )
      if (latestCompletedPlan?.result?.planId) setPlanId(latestCompletedPlan.result.planId)
      const latestFailure = (history.requests as ResetRequest[] | undefined)?.find(
        (request) => request.status === 'failed',
      )
      if (latestFailure && Date.now() - new Date(latestFailure.createdAt).getTime() < 60_000) {
        setMessage(`${latestFailure.errorMessage || '処理に失敗しました。'} (${latestFailure.errorCode})`)
      }
      setForbidden(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '管理データを取得できません。')
    } finally {
      setLoading(false)
    }
  }, [guildId])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5_000)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    setPlanForm((current) => ({
      ...current,
      mode: settings.defaultMode,
    }))
  }, [settings.defaultMode])

  const activePlan = useMemo(
    () => plans.find((plan) => plan.id === planId) ?? plans.find((plan) => plan.status === 'active') ?? null,
    [planId, plans],
  )
  const latestExecution = executions[0] ?? null
  const pendingRequest = requests.find(
    (request) => request.status === 'queued' || request.status === 'running',
  )

  const updateSettingsList = (
    key: 'protectedChannelIds' | 'protectedRoleIds' | 'allowedAdminIds',
    value: string,
  ) => {
    setSettings((current) => ({
      ...current,
      [key]: value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
    }))
  }

  const saveSettings = async () => {
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch(`/api/developer/guilds/${guildId}/reset/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || '設定を保存できませんでした。')
      setSettings({ ...defaultSettings, ...data.settings })
      setMessage('初期化設定を保存しました。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '設定を保存できませんでした。')
    } finally {
      setSaving(false)
    }
  }

  const createPlan = async (forceDryRun?: boolean) => {
    setWorking(true)
    setMessage('')
    setIssuedCode('')
    setCode('')
    setAcknowledged(false)
    try {
      const response = await fetch(`/api/developer/guilds/${guildId}/reset/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...planForm,
          dryRun: forceDryRun ?? planForm.dryRun,
          keepChannelIds: planForm.keepChannelIds,
          keepRoleIds: planForm.keepRoleIds,
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || 'Planを作成できませんでした。')
      setMessage(`Plan作成をBotへ依頼しました。Request: ${data.requestId}`)
      window.setTimeout(() => void load(), 1_500)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Planを作成できませんでした。')
    } finally {
      setWorking(false)
    }
  }

  const issueCode = async () => {
    if (!activePlan) return
    setWorking(true)
    setMessage('')
    try {
      const response = await fetch(`/api/developer/guilds/${guildId}/reset/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: activePlan.id }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || '確認コードを発行できませんでした。')
      setIssuedCode(data.code)
      setCode(data.code)
      setCodeExpiresAt(data.expiresAt)
      setMessage('新しいワンタイム確認コードを発行しました。古いコードは無効です。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '確認コードを発行できませんでした。')
    } finally {
      setWorking(false)
    }
  }

  const confirm = async () => {
    if (!activePlan || !acknowledged || !code) return
    setWorking(true)
    setMessage('')
    try {
      const response = await fetch(`/api/developer/guilds/${guildId}/reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: activePlan.id, code, acknowledge: acknowledged }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || '実行を開始できませんでした。')
      setCode('')
      setIssuedCode('')
      setAcknowledged(false)
      setMessage(`確認済みリクエストをBotへ送信しました。Request: ${data.requestId}`)
      window.setTimeout(() => void load(), 1_500)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '実行を開始できませんでした。')
    } finally {
      setWorking(false)
    }
  }

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </main>
    )
  }

  if (forbidden) {
    return (
      <main className="min-h-screen bg-background text-foreground">
        <SiteHeader />
        <section className="mx-auto max-w-xl px-6 pt-32">
          <div className="rounded-2xl border border-destructive/30 bg-card p-7 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
            <h1 className="mt-4 text-xl font-bold">アクセスできません</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              開発者認証とGuild所有権を確認できませんでした。
            </p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-6xl px-5 pb-24 pt-28 sm:px-8">
        <a href="/developer" className="inline-flex items-center gap-2 text-sm font-bold text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Guild一覧へ戻る
        </a>
        <div className="mt-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-bold tracking-[.18em] text-primary">SAFE GUILD RESET</p>
            <h1 className="mt-2 text-3xl font-extrabold">{guildName}</h1>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{guildId}</p>
          </div>
          <button
            onClick={() => void load()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-bold hover:bg-secondary"
          >
            <RefreshCw className="h-4 w-4" />更新
          </button>
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          <SummaryCard
            label="初期化機能"
            value={settings.enabled ? '有効' : '無効'}
            detail="グローバル機能フラグとは別にGuild単位で制御"
            good={settings.enabled}
          />
          <SummaryCard
            label="最後の実行"
            value={latestExecution ? (latestExecution.dryRun ? 'DRY RUN' : latestExecution.status.toUpperCase()) : '未実行'}
            detail={latestExecution ? formatDate(latestExecution.startedAt) : '実行履歴はありません'}
            good={latestExecution?.status === 'completed'}
          />
          <SummaryCard
            label="処理状態"
            value={pendingRequest ? pendingRequest.status.toUpperCase() : 'IDLE'}
            detail={pendingRequest ? `${pendingRequest.action} · ${pendingRequest.id}` : '実行待ちはありません'}
            good={!pendingRequest}
          />
        </div>

        {message && (
          <p className="mt-5 rounded-xl border border-border bg-card px-4 py-3 text-sm">{message}</p>
        )}

        <div className="mt-7 grid gap-7 lg:grid-cols-2">
          <section className="rounded-2xl border border-border bg-card/60 p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <div>
                <h2 className="font-extrabold">Guild保護設定</h2>
                <p className="mt-1 text-xs text-muted-foreground">変更できるのはGuild所有者として登録された開発者だけです。</p>
              </div>
            </div>
            <label className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-background/55 p-4 text-sm font-bold">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))}
              />
              このGuildで安全な初期化機能を有効にする
            </label>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <InputLabel label="保護チャンネルID" hint="カンマまたは空白区切り">
                <textarea
                  value={idList(settings.protectedChannelIds)}
                  onChange={(event) => updateSettingsList('protectedChannelIds', event.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="保護ロールID" hint="Administrator・Managed・Botロールは自動保護">
                <textarea
                  value={idList(settings.protectedRoleIds)}
                  onChange={(event) => updateSettingsList('protectedRoleIds', event.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="実行ログチャンネルID">
                <input
                  value={settings.resetLogChannelId ?? ''}
                  onChange={(event) => setSettings((current) => ({ ...current, resetLogChannelId: event.target.value || null }))}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="バックアップ送信チャンネルID">
                <input
                  value={settings.backupChannelId ?? ''}
                  onChange={(event) => setSettings((current) => ({ ...current, backupChannelId: event.target.value || null }))}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="許可する管理者Discord ID" hint="開発者登録済みIDだけが最終的に実行可能">
                <textarea
                  value={idList(settings.allowedAdminIds)}
                  onChange={(event) => updateSettingsList('allowedAdminIds', event.target.value)}
                  rows={2}
                  className="mt-2 w-full rounded-lg border border-border bg-background p-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="既定モード">
                <select
                  value={settings.defaultMode}
                  onChange={(event) => setSettings((current) => ({ ...current, defaultMode: event.target.value as ResetSettings['defaultMode'] }))}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                >
                  <option value="channels_only">channels_only</option>
                  <option value="channels_and_roles">channels_and_roles</option>
                  <option value="settings_reset">settings_reset</option>
                </select>
              </InputLabel>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <NumberSetting label="最大Channel" value={settings.maxChannelDeletes} placeholder="50" onChange={(value) => setSettings((current) => ({ ...current, maxChannelDeletes: value }))} />
              <NumberSetting label="最大Role" value={settings.maxRoleDeletes} placeholder="25" onChange={(value) => setSettings((current) => ({ ...current, maxRoleDeletes: value }))} />
              <NumberSetting label="最大合計" value={settings.maxTotalOperations} placeholder="75" onChange={(value) => setSettings((current) => ({ ...current, maxTotalOperations: value }))} />
              <NumberSetting label="Guild待機(h)" value={settings.guildCooldownHours} placeholder="24" onChange={(value) => setSettings((current) => ({ ...current, guildCooldownHours: value }))} />
              <NumberSetting label="開発者待機(m)" value={settings.developerCooldownMinutes} placeholder="60" onChange={(value) => setSettings((current) => ({ ...current, developerCooldownMinutes: value }))} />
            </div>
            <button
              disabled={saving}
              onClick={() => void saveSettings()}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              設定を保存
            </button>
          </section>

          <section className="rounded-2xl border border-border bg-card/60 p-5">
            <div className="flex items-center gap-2">
              <TestTube2 className="h-5 w-5 text-primary" />
              <div>
                <h2 className="font-extrabold">Plan作成</h2>
                <p className="mt-1 text-xs text-muted-foreground">Plan作成だけではDiscord上のデータは変更されません。</p>
              </div>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <InputLabel label="モード">
                <select
                  value={planForm.mode}
                  onChange={(event) => {
                    const mode = event.target.value as ResetSettings['defaultMode']
                    setPlanForm((current) => ({
                      ...current,
                      mode,
                      deleteChannels: mode !== 'settings_reset',
                      deleteRoles: mode === 'channels_and_roles',
                      resetSettings: mode === 'settings_reset',
                    }))
                  }}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                >
                  <option value="channels_only">channels_only</option>
                  <option value="channels_and_roles">channels_and_roles</option>
                  <option value="settings_reset">settings_reset</option>
                </select>
              </InputLabel>
              <InputLabel label="実行理由">
                <input
                  value={planForm.reason}
                  onChange={(event) => setPlanForm((current) => ({ ...current, reason: event.target.value }))}
                  maxLength={300}
                  placeholder="3文字以上"
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="追加保護チャンネルID">
                <input
                  value={planForm.keepChannelIds}
                  onChange={(event) => setPlanForm((current) => ({ ...current, keepChannelIds: event.target.value }))}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
              <InputLabel label="追加保護ロールID">
                <input
                  value={planForm.keepRoleIds}
                  onChange={(event) => setPlanForm((current) => ({ ...current, keepRoleIds: event.target.value }))}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary"
                />
              </InputLabel>
            </div>
            <div className="mt-5 grid gap-2 text-sm">
              <CheckOption label="Dry Run" checked={planForm.dryRun} onChange={(checked) => setPlanForm((current) => ({ ...current, dryRun: checked }))} />
              <CheckOption label="チャンネルを対象にする" checked={planForm.deleteChannels} onChange={(checked) => setPlanForm((current) => ({ ...current, deleteChannels: checked }))} />
              <CheckOption label="ロール削除を明示的に有効化" checked={planForm.deleteRoles} onChange={(checked) => setPlanForm((current) => ({ ...current, deleteRoles: checked }))} danger />
              <CheckOption label="Guild設定初期化を明示的に有効化" checked={planForm.resetSettings} onChange={(checked) => setPlanForm((current) => ({ ...current, resetSettings: checked }))} danger />
              <CheckOption label="実行後にgeneral / logs / rulesを作成" checked={planForm.createDefaultChannels} onChange={(checked) => setPlanForm((current) => ({ ...current, createDefaultChannels: checked }))} />
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                disabled={working || !settings.enabled || planForm.reason.trim().length < 3}
                onClick={() => void createPlan(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-primary/40 px-4 py-2.5 text-sm font-bold text-primary disabled:opacity-40"
              >
                <TestTube2 className="h-4 w-4" />Dry Run Plan
              </button>
              <button
                disabled={working || !settings.enabled || planForm.reason.trim().length < 3}
                onClick={() => void createPlan()}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-40"
              >
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Plan作成
              </button>
            </div>
          </section>
        </div>

        {activePlan && (
          <section className={`mt-7 rounded-2xl border p-5 ${activePlan.targetSummary.limitExceeded || activePlan.targetSummary.missingPermissions.length ? 'border-amber-500/40 bg-amber-500/[.06]' : 'border-border bg-card/60'}`}>
            <div className="flex flex-col justify-between gap-3 sm:flex-row">
              <div>
                <p className="text-xs font-bold tracking-[.15em] text-primary">ACTIVE PLAN</p>
                <h2 className="mt-2 text-lg font-extrabold">{activePlan.id}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {activePlan.mode} · {activePlan.dryRun ? 'Dry Run' : '実変更'} · 有効期限 {formatDate(activePlan.expiresAt)}
                </p>
              </div>
              <span className={`h-fit rounded-full px-3 py-1 text-xs font-bold ${activePlan.targetSummary.limitExceeded ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                {activePlan.targetSummary.limitExceeded ? '上限超過・実行不可' : '実行上限内'}
              </span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-4">
              <Metric label="削除Channel" value={activePlan.targetSummary.channelDeleteCount} />
              <Metric label="削除Role" value={activePlan.targetSummary.roleDeleteCount} />
              <Metric label="合計操作" value={activePlan.targetSummary.totalOperationCount} />
              <Metric label="不足権限" value={activePlan.targetSummary.missingPermissions.length} />
            </div>
            <div className="mt-5 grid gap-4 text-xs sm:grid-cols-2">
              <TargetList title="削除予定チャンネル" items={activePlan.targetSummary.deleteChannels} />
              <TargetList title="保護チャンネル" items={activePlan.targetSummary.protectedChannels} />
              <TargetList title="削除予定ロール" items={activePlan.targetSummary.deleteRoles} danger />
              <TargetList title="保護ロール" items={activePlan.targetSummary.protectedRoles} />
            </div>
            <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/[.08] p-4 text-sm">
              {activePlan.targetSummary.warnings.map((warning) => (
                <p key={warning} className="mt-1 flex gap-2 first:mt-0">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />{warning}
                </p>
              ))}
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-[auto_1fr_auto] lg:items-end">
              <button
                disabled={working || activePlan.status !== 'active'}
                onClick={() => void issueCode()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-primary/40 px-4 text-sm font-bold text-primary disabled:opacity-40"
              >
                <KeyRound className="h-4 w-4" />確認コード発行
              </button>
              <InputLabel label="ワンタイム確認コード" hint={codeExpiresAt ? `有効期限 ${formatDate(codeExpiresAt)}` : '発行後5分・1回のみ'}>
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 12))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 font-mono text-lg tracking-[.3em] outline-none focus:border-primary"
                />
              </InputLabel>
              <button
                disabled={
                  working ||
                  !acknowledged ||
                  code.length < 6 ||
                  activePlan.targetSummary.limitExceeded ||
                  activePlan.targetSummary.missingPermissions.length > 0
                }
                onClick={() => void confirm()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-rose-600 px-5 text-sm font-extrabold text-white disabled:opacity-40"
              >
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                最終実行
              </button>
            </div>
            {issuedCode && (
              <p className="mt-4 rounded-xl border border-primary/30 bg-primary/10 p-4 font-mono text-2xl font-black tracking-[.3em]">
                {issuedCode}
              </p>
            )}
            <label className="mt-4 flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/[.07] p-4 text-sm font-bold">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5"
              />
              この操作は選択されたチャンネルやロールを削除します。バックアップが作成されますが、完全な復元を保証するものではありません。
            </label>
          </section>
        )}

        <div className="mt-7 grid gap-7 lg:grid-cols-2">
          <section className="rounded-2xl border border-border bg-card/60 p-5">
            <div className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-primary" /><h2 className="font-extrabold">実行履歴</h2></div>
            <div className="mt-5 max-h-[36rem] space-y-3 overflow-y-auto">
              {executions.length ? executions.map((execution) => (
                <article key={execution.id} className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-xs font-bold">{execution.id}</p>
                    <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${execution.status === 'completed' ? 'bg-emerald-500/15 text-emerald-400' : execution.status === 'partial' ? 'bg-amber-500/15 text-amber-400' : 'bg-rose-500/15 text-rose-400'}`}>{execution.dryRun ? 'DRY RUN' : execution.status.toUpperCase()}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{execution.reason}</p>
                  <p className="mt-2 text-xs">成功 {execution.successCount} · 失敗 {execution.failedCount} · スキップ {execution.skippedCount}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">{execution.developerName || execution.developerId} · {formatDate(execution.startedAt)}</p>
                  {execution.errorSummary && <p className="mt-2 text-xs text-rose-400">{execution.errorSummary}</p>}
                </article>
              )) : <p className="text-sm text-muted-foreground">実行履歴はありません。</p>}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card/60 p-5">
            <div className="flex items-center gap-2"><DatabaseBackup className="h-5 w-5 text-primary" /><h2 className="font-extrabold">バックアップ</h2></div>
            <p className="mt-2 text-xs text-muted-foreground">ファイルはBotホストに保存され、設定済みの場合はバックアップチャンネルにも送信されます。</p>
            <div className="mt-5 max-h-[36rem] space-y-3 overflow-y-auto">
              {backups.length ? backups.map((backup) => (
                <article key={backup.id} className="rounded-xl border border-border bg-background/50 p-4">
                  <div className="flex items-start gap-3">
                    <FileJson className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="break-all text-xs font-bold">{backup.fileName}</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{backup.filePath}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground">{(backup.fileSize / 1024).toFixed(1)} KB · Schema v{backup.schemaVersion} · {formatDate(backup.createdAt)}</p>
                      <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">SHA-256 {backup.checksum}</p>
                    </div>
                  </div>
                </article>
              )) : <p className="text-sm text-muted-foreground">バックアップはありません。</p>}
            </div>
          </section>
        </div>
      </section>
    </main>
  )
}

function SummaryCard({ label, value, detail, good }: { label: string; value: string; detail: string; good: boolean }) {
  return <div className="rounded-2xl border border-border bg-card/60 p-5"><p className="text-xs font-bold text-muted-foreground">{label}</p><p className={`mt-2 text-xl font-extrabold ${good ? 'text-emerald-400' : 'text-amber-400'}`}>{value}</p><p className="mt-2 truncate text-xs text-muted-foreground">{detail}</p></div>
}

function NumberSetting({ label, value, placeholder, onChange }: { label: string; value: number | null; placeholder: string; onChange: (value: number | null) => void }) {
  return <label className="text-[11px] font-bold text-muted-foreground">{label}<input type="number" min={0} value={value ?? ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary" /></label>
}

function CheckOption({ label, checked, onChange, danger = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; danger?: boolean }) {
  return <label className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${danger ? 'border-rose-500/25 bg-rose-500/[.04]' : 'border-border bg-background/45'}`}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className={danger ? 'font-bold text-rose-300' : ''}>{label}</span></label>
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-border bg-background/50 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-extrabold">{value}</p></div>
}

function TargetList({ title, items, danger = false }: { title: string; items: Array<{ id: string; name: string }>; danger?: boolean }) {
  return <div className="rounded-xl border border-border bg-background/45 p-4"><p className={`font-bold ${danger ? 'text-rose-400' : 'text-foreground'}`}>{title} · {items.length}件</p><div className="mt-3 max-h-36 space-y-1 overflow-y-auto text-muted-foreground">{items.length ? items.map((item) => <p key={item.id} className="truncate">• {item.name} <span className="font-mono text-[10px]">({item.id})</span></p>) : <p>なし</p>}</div></div>
}
