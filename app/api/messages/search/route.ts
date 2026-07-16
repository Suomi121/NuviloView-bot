import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { isRateLimited } from '@/lib/request-security'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await isRateLimited(request, { scope: 'message-search', limit: 30, windowSeconds: 60, identity: session.user.id })) {
    return NextResponse.json({ error: '検索回数が多すぎます。少し待ってからお試しください。' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const guildId = searchParams.get('guildId')
  const query = searchParams.get('q')?.trim() ?? ''
  if (!guildId || query.length < 2) return NextResponse.json({ messages: [] })
  if (query.length > 100) return NextResponse.json({ error: 'Search query is too long' }, { status: 400 })

  const guilds = await getManagedGuilds(session.user.id)
  if (!guilds.some((guild) => guild.id === guildId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const escapedQuery = query.replace(/[!%_]/g, '!$&')
  const result = await pool.query<{ id: string; channelName: string; authorName: string; content: string; createdAt: Date }>(`
    SELECT "id", "channelName", "authorName", "content", "createdAt"
    FROM "discord_message"
    WHERE "guildId" = $1 AND "content" ILIKE $2 ESCAPE '!'
    ORDER BY "createdAt" DESC LIMIT 20
  `, [guildId, `%${escapedQuery}%`])
  return NextResponse.json({ messages: result.rows })
}
