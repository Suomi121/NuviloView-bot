import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { isRateLimited } from '@/lib/request-security'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await isRateLimited(request, { scope: 'notifications', limit: 60, windowSeconds: 60, identity: session.user.id })) {
    return NextResponse.json({ error: '通知の取得回数が多すぎます。' }, { status: 429 })
  }

  try {
    const guilds = await getManagedGuilds(session.user.id)
    const guildIds = guilds.map((guild) => guild.id)

    if (guildIds.length) {
      const heartbeat = await pool.query<{ guildId: string }>(`
        SELECT "guildId"
        FROM "daily_stats"
        WHERE "guildId" = ANY($1::text[])
          AND "updatedAt" >= now() - interval '30 minutes'
        GROUP BY "guildId"
      `, [guildIds])
      const connectedGuildIds = new Set(heartbeat.rows.map((row) => row.guildId))
      const disconnectedGuilds = guilds.filter((guild) => !connectedGuildIds.has(guild.id))

      for (const guild of disconnectedGuilds) {
        await pool.query(`
          INSERT INTO "user_notification" ("userId", "guildId", "type", "title", "body")
          VALUES ($1, $2, 'bot_not_connected', $3, $4)
          ON CONFLICT ("userId", "guildId", "type") DO NOTHING
        `, [
          session.user.id,
          guild.id,
          'Botに接続できませんでした',
          `「${guild.name}」にはNuviloView:OEM Botがいないか、Botが停止しています。分析を始めるにはBotを導入してください。`,
        ])
      }

      // Bot-originated alerts are fanned out only to people who are currently
      // authorized to manage the relevant guild. A dismissed alert remains
      // dismissed because its event-specific notification key is stable.
      const alerts = await pool.query<{
        id: number; guildId: string; title: string; body: string
      }>(`
        SELECT "id", "guildId", "title", "body"
        FROM "guild_alert_event"
        WHERE "guildId" = ANY($1::text[])
          AND "createdAt" >= now() - interval '7 days'
        ORDER BY "createdAt" DESC
        LIMIT 50
      `, [guildIds])
      for (const alert of alerts.rows) {
        await pool.query(`
          INSERT INTO "user_notification" ("userId", "guildId", "type", "title", "body")
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT ("userId", "guildId", "type") DO NOTHING
        `, [session.user.id, alert.guildId, `alert:${alert.id}`, alert.title, alert.body])
      }
    }

    const result = await pool.query<{
      id: number; guildId: string; type: string; title: string; body: string; createdAt: Date
    }>(`
      SELECT "id", "guildId", "type", "title", "body", "createdAt"
      FROM "user_notification"
      WHERE "userId" = $1 AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT 30
    `, [session.user.id])
    return NextResponse.json({ notifications: result.rows })
  } catch (error) {
    console.error('Failed to load notifications:', error)
    return NextResponse.json({ error: 'Unable to load notifications' }, { status: 500 })
  }
}
