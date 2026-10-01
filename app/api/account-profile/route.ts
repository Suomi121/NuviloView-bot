import { auth } from '@/lib/auth'
import { selectDisplayIdentity, type DisplayIdentity } from '@/lib/display-identity'
import { NextResponse } from 'next/server'

// Display only. Never used as proof of Discord membership or authorization.
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const accounts = await auth.api.listUserAccounts({ headers: request.headers })
  const profiles: { discord?: DisplayIdentity; google?: DisplayIdentity } = {}
  for (const providerId of ['discord', 'google'] as const) {
    const account = accounts.find(a => a.providerId === providerId)
    if (!account) continue
    try {
      const info = await auth.api.accountInfo({ headers: request.headers, query: { providerId, accountId: account.accountId } })
      if (info?.user) profiles[providerId] = { name: info.user.name, image: info.user.image }
      if (profiles[providerId]?.name && profiles[providerId]?.image) break
    } catch {
      // Profile transport failure is not a login/authorization failure. Fall back
      // without exposing provider data, tokens or raw errors to the client.
    }
  }
  return NextResponse.json(selectDisplayIdentity(profiles, session.user), { headers: { 'Cache-Control': 'private, no-store' } })
}
