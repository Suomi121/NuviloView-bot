import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { authStorage } from '@/lib/auth-storage'
import { safeAuthStorageErrorCode } from '@/lib/auth-storage/postgres'
import { getManagedGuilds } from '@/lib/discord'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (await authStorage.rateLimit.isLimited({ scope: 'guild-list', limit: 30, windowSeconds: 60, identity: session.user.id })) {
    return NextResponse.json({ error: '取得回数が多すぎます。' }, { status: 429 })
  }

  try {
    return NextResponse.json({ guilds: await getManagedGuilds(session.user.id) })
  } catch (error) {
    console.error(`Failed to fetch managed Discord guilds: code=${safeAuthStorageErrorCode(error)}`)
    return NextResponse.json({ error: 'Unable to fetch Discord servers' }, { status: 502 })
  }
}
