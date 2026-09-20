'use client'

import { signIn } from '@/lib/auth-client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function AuthErrorDiscordButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  const continueWithDiscord = async () => {
    if (pending) return
    setPending(true)
    try {
      const result = await signIn.social({
        provider: 'discord',
        callbackURL: '/dashboard',
        errorCallbackURL: '/auth-error',
      })
      if (result.error) router.push('/auth-error')
    } catch {
      router.push('/auth-error')
    } finally {
      setPending(false)
    }
  }

  return <button type="button" disabled={pending} onClick={() => void continueWithDiscord()}
    className="mt-6 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">
    {pending ? '接続中…' : 'Discordで続行'}
  </button>
}
