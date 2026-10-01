'use client'

import { useEffect, useState } from 'react'
import type { DisplayIdentity } from '@/lib/display-identity'

export function useDisplayIdentity(user?: DisplayIdentity & { id?: string }) {
  const [resolved, setResolved] = useState<{ userId: string; profile: DisplayIdentity } | null>(null)
  useEffect(() => {
    if (!user?.id) return
    const controller = new AbortController()
    const userId = user.id
    fetch('/api/account-profile', { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(profile => { if (profile && !controller.signal.aborted) setResolved({ userId, profile }) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [user?.id])
  return resolved?.userId === user?.id ? resolved?.profile : user
}
