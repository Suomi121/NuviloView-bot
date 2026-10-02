'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { signIn } from '@/lib/auth-client'
import { createSocialLoginState } from '@/lib/social-login-state.mjs'

// Shared by the header, landing CTA and onboarding recovery button.
const loginState = createSocialLoginState()
const serverSnapshot = { pending: false, retryAt: 0, observedAt: 0 }

export function useSocialLogin() {
  const state = useSyncExternalStore(loginState.subscribe, loginState.getSnapshot, () => serverSnapshot)
  const [clock, setClock] = useState(0)
  useEffect(() => {
    if (!state.retryAt) return
    const timer = setInterval(() => {
      const now = Date.now()
      setClock(now)
      if (now >= state.retryAt) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [state.retryAt])
  const seconds = Math.max(0, Math.ceil((state.retryAt - Math.max(clock, state.observedAt)) / 1000))
  return {
    pending: state.pending,
    seconds,
    async start(options: Parameters<typeof signIn.social>[0]) {
      return loginState.run((fetchOptions: Parameters<typeof signIn.social>[1]) => signIn.social(options, fetchOptions))
    },
  }
}
