'use client'

import { DiscordIcon } from '@/components/discord-icon'
import { GoogleIcon } from '@/components/google-icon'
import { useLocale } from '@/components/locale-provider'
import { authClient } from '@/lib/auth-client'
import { Check, Link2, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

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
        ? 'Required to verify the servers you own or manage. Existing identify and guilds authorization is unchanged.'
        : '所有・管理しているサーバーの確認に使用します。既存のidentify・guilds認可は変わりません。',
      icon: <DiscordIcon className="h-6 w-6" />,
    },
    {
      id: 'google',
      name: 'Google',
      description: en
        ? 'Adds a convenient sign-in method. NuviloView does not request access to Gmail, Drive, or other Google services.'
        : 'ログイン手段として利用します。Gmail、Driveなど他のGoogleサービスへの権限は要求しません。',
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
                </div>
              </div>
              {!loading && !linked && (
                <button
                  type="button"
                  disabled={!configured || linking !== null}
                  onClick={() => void linkProvider(provider.id)}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/35 bg-primary/10 px-4 py-2.5 text-sm font-bold text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {pending
                    ? en ? 'Connecting…' : '連携中…'
                    : en ? `Connect ${provider.name}` : `${provider.name}を連携`}
                </button>
              )}
            </div>
          </section>
        )
      })}
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
