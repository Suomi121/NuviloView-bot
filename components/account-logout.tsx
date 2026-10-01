'use client'

import { useRef, useState } from 'react'
import { LoaderCircle, LogOut } from 'lucide-react'
import { useLocale } from '@/components/locale-provider'
import { signOut } from '@/lib/auth-client'

export function AccountLogout() {
  const { locale } = useLocale()
  const en = locale === 'en'
  const inFlight = useRef(false)
  const [signingOut, setSigningOut] = useState(false)
  const [failed, setFailed] = useState(false)

  const logOut = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setSigningOut(true)
    setFailed(false)
    try {
      const result = await signOut()
      if (result.error) throw new Error('Sign out failed')
    } catch {
      setFailed(true)
      setSigningOut(false)
      inFlight.current = false
      return
    }
    // Replace the authenticated document, including its in-memory router cache.
    // Better Auth owns server-side invalidation and all session cookie handling.
    window.location.replace('/?landing=1')
  }

  return (
    <section className="mt-4 rounded-xl border border-destructive/35 bg-destructive/[0.04] p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-bold">{en ? 'Account session' : 'アカウントセッション'}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {en ? 'Log out of NuviloView on this device.' : 'この端末のNuviloViewからログアウトします。'}
          </p>
        </div>
        <button
          type="button"
          disabled={signingOut}
          aria-busy={signingOut}
          onClick={() => void logOut()}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm font-bold text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {signingOut ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogOut className="h-4 w-4" aria-hidden="true" />}
          {signingOut ? (en ? 'Logging out…' : 'ログアウト中…') : (en ? 'Log out' : 'ログアウト')}
        </button>
      </div>
      {failed && <p role="alert" className="mt-3 text-xs text-destructive">
        {en ? 'Could not log out. Please try again.' : 'ログアウトできませんでした。もう一度お試しください。'}
      </p>}
    </section>
  )
}
