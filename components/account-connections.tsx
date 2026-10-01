'use client'

import { DiscordIcon } from '@/components/discord-icon'
import { GoogleIcon } from '@/components/google-icon'
import { useLocale } from '@/components/locale-provider'
import { authClient } from '@/lib/auth-client'
import type { ProviderLabel } from '@/lib/provider-label'
import { Check, Link2, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type AuthProvider = 'discord' | 'google'
type ProviderAvailability = Record<AuthProvider, boolean>
type LinkedAccount = { id: string; providerId: string }

export function AccountConnections({
  providerAvailability,
}: {
  providerAvailability: ProviderAvailability
}) {
  const { locale } = useLocale()
  const en = locale === 'en'
  const [accounts, setAccounts] = useState<LinkedAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState<AuthProvider | null>(null)
  const [error, setError] = useState('')
  const [confirmUnlink, setConfirmUnlink] = useState<AuthProvider | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  const mutationInFlight = useRef(false)
  const [labels, setLabels] = useState<Partial<Record<AuthProvider, ProviderLabel | null>>>({})
  const [labelsLoading, setLabelsLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/account-connections', { cache: 'no-store', signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('PROFILE_UNAVAILABLE'); return response.json() })
      .then(result => { if (!controller.signal.aborted) setLabels(result) })
      .catch(() => { if (!controller.signal.aborted) setLabels({}) })
      .finally(() => { if (!controller.signal.aborted) setLabelsLoading(false) })
    return () => controller.abort()
  }, [])

  const unlinkProvider = async () => {
    if (!confirmUnlink || mutationInFlight.current) return
    mutationInFlight.current = true
    setUnlinking(true)
    setError('')
    try {
      const result = await authClient.unlinkAccount({ providerId: confirmUnlink })
      if (result.error) throw new Error('UNLINK_FAILED')
      const refreshed = await authClient.listAccounts()
      if (refreshed.error || !Array.isArray(refreshed.data)) throw new Error('REFRESH_FAILED')
      setAccounts(refreshed.data)
      // Drop stale presentation/Guild state; no OAuth cookie or provider session is cleared.
      window.location.replace('/account')
    } catch {
      setError(en ? 'Could not disconnect. Reload and check your login methods. You may need to sign in again.' : '連携を解除できませんでした。再読み込みしてログイン方法を確認してください。再ログインが必要な場合があります。')
    } finally {
      mutationInFlight.current = false
      setUnlinking(false)
      setConfirmUnlink(null)
    }
  }

  useEffect(() => {
    let active = true
    authClient.listAccounts()
      .then((result) => {
        if (!active) return
        if (result.error) throw new Error(result.error.message)
        setAccounts(Array.isArray(result.data) ? result.data : [])
      })
      .catch(() => {
        if (active) {
          setError(en
            ? 'Could not load connection status. Please reload the page.'
            : '連携状態を読み込めませんでした。ページを再読み込みしてください。')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [en])

  const linkProvider = async (provider: AuthProvider) => {
    setLinking(provider)
    setError('')
    try {
      const result = await authClient.linkSocial({
        provider,
        callbackURL: '/account',
        errorCallbackURL: `/auth-error?provider=${provider}`,
      })
      if (result.error) throw new Error(result.error.message)
    } catch {
      setError(en
        ? 'Could not connect this account. Check the provider account and try again.'
        : 'アカウントを連携できませんでした。連携先を確認して、もう一度お試しください。')
      setLinking(null)
    }
  }

  const isLinked = (provider: AuthProvider) => accounts.some((account) => account.providerId === provider)
  const providers: Array<{
    id: AuthProvider
    name: string
    description: string
    icon: React.ReactNode
  }> = [
    {
      id: 'discord',
      name: 'Discord',
      description: en
        ? 'Used to verify your servers and permissions.'
        : 'サーバーの確認・権限判定に使用します。',
      icon: <DiscordIcon className="h-6 w-6" />,
    },
    {
      id: 'google',
      name: 'Google',
      description: en
        ? 'Used as an additional sign-in method.'
        : '追加のログイン手段として利用します。',
      icon: <GoogleIcon className="h-6 w-6" />,
    },
  ]

  return (
    <div className="mt-7 space-y-3">
      {providers.map((provider) => {
        const linked = isLinked(provider.id)
        const configured = providerAvailability[provider.id]
        const pending = linking === provider.id
        return (
          <section key={provider.id} className="rounded-xl border border-border bg-background/40 p-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
                  {provider.icon}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-bold">{provider.name}</h2>
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-[11px] font-bold text-primary">{provider.id === 'discord' ? (en ? 'Primary' : 'メイン') : (en ? 'Secondary' : 'サブ')}</span>
                    {loading ? (
                      <span className="text-xs text-muted-foreground">{en ? 'Checking…' : '確認中…'}</span>
                    ) : linked ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-400">
                        <Check className="h-3 w-3" />
                        {en ? 'Connected' : '連携済み'}
                      </span>
                    ) : configured ? (
                      <span className="rounded-full bg-secondary px-2 py-1 text-[11px] font-bold text-muted-foreground">
                        {en ? 'Not connected' : '未連携'}
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-bold text-amber-400">
                        {en ? 'Unavailable' : '現在利用不可'}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{provider.description}</p>
                  {!loading && linked && <div className="mt-2 break-words text-sm" aria-live="polite">
                    {labelsLoading ? <p className="text-xs text-muted-foreground">{en ? 'Loading linked account…' : '連携先を確認中…'}</p> : labels[provider.id]?.name || labels[provider.id]?.detail ? <>
                      {labels[provider.id]?.name && <p>{labels[provider.id]?.name}</p>}
                      {labels[provider.id]?.detail && <p className="text-xs text-muted-foreground">{provider.id === 'discord' ? '@' : ''}{labels[provider.id]?.detail}</p>}
                    </> : <p className="text-xs text-muted-foreground">{en ? 'Linked account details unavailable.' : '連携先情報を取得できませんでした。'}</p>}
                  </div>}
                </div>
              </div>
              {!loading && !linked && (
                <button
                  type="button"
                  disabled={!configured || linking !== null || unlinking || confirmUnlink !== null}
                  onClick={() => void linkProvider(provider.id)}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/35 bg-primary/10 px-4 py-2.5 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {pending
                    ? en ? 'Connecting…' : '連携中…'
                    : en ? `Connect ${provider.name}` : `${provider.name}を連携`}
                </button>
              )}
              {!loading && linked && (
                <button type="button" disabled={accounts.length <= 1 || linking !== null || unlinking || confirmUnlink !== null}
                  onClick={() => setConfirmUnlink(provider.id)}
                  className="rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50">
                  {en ? 'Disconnect' : '連携解除'}
                </button>
              )}
            </div>
          </section>
        )
      })}
      {!loading && accounts.length <= 1 && <p className="text-xs text-muted-foreground">{en ? 'You cannot disconnect your last login method. Connect another login method first.' : '最後のログイン方法は解除できません。先に別のログイン方法を連携してください。'}</p>}
      {!loading && isLinked('google') && !isLinked('discord') && <p className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4 text-sm leading-relaxed text-foreground">
        {en ? 'Connect Discord to use server features.' : 'Discordを連携するとサーバー機能を利用できます。'}
      </p>}
      {confirmUnlink && <dialog ref={node => { if (node && !node.open) node.showModal() }} onCancel={event => { if (unlinking) event.preventDefault(); else setConfirmUnlink(null) }} aria-labelledby="unlink-title" className="m-auto max-w-[calc(100%-2rem)] rounded-2xl bg-transparent p-0 text-foreground backdrop:bg-black/60">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
          <h2 id="unlink-title" className="font-bold">{en ? `Disconnect ${confirmUnlink === 'discord' ? 'Discord' : 'Google'}?` : `${confirmUnlink === 'discord' ? 'Discord' : 'Google'}連携を解除しますか？`}</h2>
          {confirmUnlink === 'discord' && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{en ? 'Server lists, Dashboard server data and Guild features will become unavailable. You can still sign in with Google.' : 'Discord連携を解除すると、サーバー一覧、ダッシュボードのサーバーデータ、Guild機能へのアクセスが利用できなくなります。Googleでのログインは引き続き利用できます。'}</p>}
          <div className="mt-5 flex justify-end gap-3">
            <button autoFocus type="button" disabled={unlinking} onClick={() => setConfirmUnlink(null)} className="rounded-lg border border-border px-4 py-2">{en ? 'Cancel' : 'キャンセル'}</button>
            <button type="button" disabled={unlinking} onClick={() => void unlinkProvider()} className="rounded-lg bg-destructive px-4 py-2 text-white disabled:opacity-50">{unlinking ? (en ? 'Disconnecting…' : '解除中…') : (en ? 'Disconnect' : '解除する')}</button>
          </div>
        </div>
      </dialog>}
      <div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {en
            ? 'Connecting Google does not grant Discord server access. NuviloView continues to authorize every Guild through the linked Discord account.'
            : 'Googleを連携してもDiscordサーバーへの権限は付与されません。各サーバーの表示可否は、これまで通り連携済みDiscordアカウントで確認します。'}
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
