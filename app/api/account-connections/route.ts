import { auth } from '@/lib/auth'
import { providerLabel } from '@/lib/provider-label'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
  const accounts = await auth.api.listUserAccounts({ headers: request.headers })
  const entries = await Promise.all((['discord', 'google'] as const).map(async providerId => {
    const account = accounts.find(item => item.providerId === providerId)
    if (!account) return [providerId, null] as const
    try {
      const info = await auth.api.accountInfo({ headers: request.headers, query: { providerId, accountId: account.accountId } })
      return [providerId, providerLabel(providerId, info)] as const
    } catch {
      return [providerId, null] as const
    }
  }))
  return NextResponse.json(Object.fromEntries(entries), { headers })
}
