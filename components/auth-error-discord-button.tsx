'use client'

import { useSocialLogin } from '@/lib/use-social-login'
import { useRouter } from 'next/navigation'

export function AuthErrorDiscordButton() {
  const router = useRouter()
  const login = useSocialLogin()

  const continueWithDiscord = async () => {
    if (login.pending || login.seconds > 0) return
    try {
      const result = await login.start({
        provider: 'discord',
        callbackURL: '/dashboard',
        errorCallbackURL: '/auth-error',
      })
      if (result === 'error') router.push('/auth-error')
    } catch {
      router.push('/auth-error')
    }
  }

  return <><button type="button" disabled={login.pending || login.seconds > 0} onClick={() => void continueWithDiscord()}
    className="mt-6 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">
    {login.pending ? '接続中…' : 'Discordで続行'}
  </button>
    {login.seconds > 0 && <p role="status" className="mt-3 text-sm">ログイン操作が続いたため、あと{login.seconds}秒待ってから再試行してください。</p>}
  </>
}
