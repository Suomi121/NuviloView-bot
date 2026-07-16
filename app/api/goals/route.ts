import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'

const guildIdPattern = /^\d{16,22}$/
const goalTypes = ['member_growth', 'messages', 'voice_seconds'] as const
type GoalType = (typeof goalTypes)[number]

async function sessionAndGuild(request: Request, guildId: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !guildIdPattern.test(guildId)) return null
  const guilds = await getManagedGuilds(session.user.id)
  return guilds.some((guild) => guild.id === guildId) ? session : null
}

export async function GET(request: Request) {
  const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
  const session = await sessionAndGuild(request, guildId)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [stored, metrics] = await Promise.all([
    pool.query<{ type: GoalType; target: number }>(
      'SELECT "type", "target"::int AS "target" FROM "guild_goal" WHERE "userId" = $1 AND "guildId" = $2',
      [session.user.id, guildId],
    ),
    pool.query<{ messageCount: number; memberGrowth: number; voiceSeconds: number }>(`
      WITH month_start AS (SELECT date_trunc('month', CURRENT_DATE)::date AS date),
      member_baseline AS (
        SELECT "memberCount"::int AS count FROM "daily_stats", month_start
        WHERE "guildId" = $1 AND date < month_start.date
        ORDER BY date DESC LIMIT 1
      ), latest_members AS (
        SELECT "memberCount"::int AS count FROM "daily_stats"
        WHERE "guildId" = $1 ORDER BY date DESC LIMIT 1
      ), voice AS (
        SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
          LEAST(COALESCE("endedAt", now()), now()) - GREATEST("startedAt", date_trunc('month', now()))
        )))), 0)::int AS seconds
        FROM "voice_server_session"
        WHERE "guildId" = $1 AND "startedAt" < now()
          AND ("endedAt" IS NULL OR "endedAt" > date_trunc('month', now()))
      )
      SELECT
        COALESCE((SELECT SUM("messageCount")::int FROM "daily_stats", month_start WHERE "guildId" = $1 AND date >= month_start.date), 0)::int AS "messageCount",
        GREATEST(COALESCE((SELECT count FROM latest_members), 0) - COALESCE((SELECT count FROM member_baseline), COALESCE((SELECT count FROM latest_members), 0)), 0)::int AS "memberGrowth",
        (SELECT seconds FROM voice)::int AS "voiceSeconds"
    `, [guildId]),
  ])

  const values: Record<GoalType, number> = {
    member_growth: Number(metrics.rows[0]?.memberGrowth ?? 0),
    messages: Number(metrics.rows[0]?.messageCount ?? 0),
    voice_seconds: Number(metrics.rows[0]?.voiceSeconds ?? 0),
  }
  return NextResponse.json({
    goals: stored.rows.map((goal) => ({ ...goal, current: values[goal.type] })),
  })
}

export async function PUT(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 8_192)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const body = await request.json().catch(() => null)
  const guildId = typeof body?.guildId === 'string' ? body.guildId : ''
  const session = await sessionAndGuild(request, guildId)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, { scope: 'goal-write', limit: 12, windowSeconds: 60, identity: session.user.id, failClosed: true })) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  const goals = Array.isArray(body?.goals) ? body.goals : []
  if (goals.length > goalTypes.length) return NextResponse.json({ error: 'Invalid goals' }, { status: 400 })

  for (const goal of goals) {
    if (!goalTypes.includes(goal?.type) || !Number.isInteger(goal?.target) || goal.target < 0 || goal.target > 100_000_000) {
      return NextResponse.json({ error: 'Invalid goals' }, { status: 400 })
    }
  }
  for (const goal of goals as Array<{ type: GoalType; target: number }>) {
    if (goal.target === 0) {
      await pool.query('DELETE FROM "guild_goal" WHERE "userId" = $1 AND "guildId" = $2 AND "type" = $3', [session.user.id, guildId, goal.type])
    } else {
      await pool.query(
        `INSERT INTO "guild_goal" ("userId", "guildId", "type", "target", "updatedAt") VALUES ($1,$2,$3,$4,now())
         ON CONFLICT ("userId", "guildId", "type") DO UPDATE SET "target" = EXCLUDED."target", "updatedAt" = now()`,
        [session.user.id, guildId, goal.type, goal.target],
      )
    }
  }
  return NextResponse.json({ ok: true })
}
