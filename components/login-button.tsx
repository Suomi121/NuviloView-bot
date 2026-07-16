'use client'

import { DiscordIcon } from '@/components/discord-icon'
import { signIn, useSession } from '@/lib/auth-client'
import { useLocale } from '@/components/locale-provider'

type LoginButtonProps = {
  compact?: boolean
}

export function LoginButton({ compact = false }: LoginButtonProps) {
  const { locale } = useLocale()
  const { data: session } = useSession()
  const buttonClass = compact
    ? 'inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 hover:opacity-90'
    : 'group inline-flex items-center gap-3 rounded-xl bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-all hover:-translate-y-0.5 hover:opacity-90 hover:shadow-primary/40'

  if (session?.user) {
    return (
      <a href="/dashboard" className={buttonClass}>
        <span>{locale === 'en' ? 'Open dashboard' : 'ダッシュボードを開く'}</span>
      </a>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        const callbackURL = `${window.location.pathname}${window.location.search}${window.location.hash}`
        void signIn.social({ provider: 'discord', callbackURL: callbackURL === '/' ? '/dashboard' : callbackURL })
      }}
      className={buttonClass}
    >
      <DiscordIcon className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
      <span>{compact ? (locale === 'en' ? 'Sign in' : 'ログイン') : (locale === 'en' ? 'Sign in with Discord' : 'Discordでログイン')}</span>
    </button>
  )
}
