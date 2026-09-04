'use client'

import { DiscordIcon } from '@/components/discord-icon'
import { GoogleIcon } from '@/components/google-icon'
import { signIn, useSession } from '@/lib/auth-client'
import { getAuthCallbackPath } from '@/lib/auth-redirect'
import { useLocale } from '@/components/locale-provider'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

type LoginButtonProps = {
  compact?: boolean
}

type AuthProvider = 'discord' | 'google'
type ProviderAvailability = Record<AuthProvider, boolean>

const defaultAvailability: ProviderAvailability = {
  // Preserve the existing Discord-first UI if the safe status request is
  // temporarily unavailable. Google appears only when the server confirms it.
  discord: true,
  google: false,
}

export function LoginButton({ compact = false }: LoginButtonProps) {
  const { locale } = useLocale()
  const { data: session } = useSession()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingProvider, setPendingProvider] = useState<AuthProvider | null>(null)
  const [providers, setProviders] = useState<ProviderAvailability>(defaultAvailability)
  const buttonClass = compact
    ? 'inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:opacity-90'
    : 'group inline-flex min-h-12 items-center justify-center gap-3 rounded-xl px-6 py-3.5 text-base font-semibold shadow-lg transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'

  useEffect(() => {
    let active = true
    fetch('/api/auth-provider-status')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!active || !data) return
        setProviders({
          discord: data.discord === true,
          google: data.google === true,
        })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  if (session?.user) {
    return (
      <a href="/dashboard" className={buttonClass}>
        <span>{locale === 'en' ? 'Open dashboard' : 'ダッシュボードを開く'}</span>
      </a>
    )
  }

  const startSocialSignIn = async (provider: AuthProvider) => {
    const callbackURL = getAuthCallbackPath(
      provider,
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    )
    setPendingProvider(provider)

    try {
      const result = await signIn.social({
        provider,
        callbackURL,
        errorCallbackURL: '/auth-error',
      })

      if (result.error) router.push('/auth-error')
    } catch {
      router.push('/auth-error')
    } finally {
      setPendingProvider(null)
    }
  }

  const providerButton = (provider: AuthProvider, inMenu = false) => {
    const isDiscord = provider === 'discord'
    const label = locale === 'en'
      ? `Continue with ${isDiscord ? 'Discord' : 'Google'}`
      : `${isDiscord ? 'Discord' : 'Google'}で続行`
    const pending = pendingProvider === provider
    const enabled = providers[provider]
    const className = inMenu
      ? 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50'
      : `${buttonClass} ${isDiscord ? 'bg-primary text-primary-foreground shadow-primary/25 hover:shadow-primary/40' : 'border border-border bg-card text-foreground shadow-black/10 hover:border-primary/40 hover:bg-secondary'}`

    return (
      <button
        key={provider}
        type="button"
        disabled={!enabled || pendingProvider !== null}
        onClick={() => void startSocialSignIn(provider)}
        className={className}
        title={!enabled ? (locale === 'en' ? 'This sign-in method is not configured.' : 'このログイン方法は現在設定されていません。') : undefined}
      >
        {pending ? (
          <LoaderCircle className="h-5 w-5 animate-spin" />
        ) : isDiscord ? (
          <DiscordIcon className="h-5 w-5" />
        ) : (
          <GoogleIcon className="h-5 w-5" />
        )}
        <span>{label}</span>
      </button>
    )
  }

  if (!compact) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row">
        {providerButton('discord')}
        {providers.google && providerButton('google')}
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className={buttonClass}
      >
        <span>{locale === 'en' ? 'Sign in' : 'ログイン'}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
      </button>
      {menuOpen && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-60 rounded-xl border border-border bg-card p-1.5 shadow-2xl">
          {providerButton('discord', true)}
          {providers.google && providerButton('google', true)}
        </div>
      )}
    </div>
  )
}
