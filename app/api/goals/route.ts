import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { buildProjectionGoalMetrics } from '@/lib/projection-analytics'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'
import { withWebReadRouter } from '@/lib/web-analytics-read'

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
  if (await isRateLimited(request, { scope: 'goal-read', limit: 30, windowSeconds: 60, identity: session.user.id })) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const now = new Date()
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10)
  const endDate = now.toISOString().slice(0, 10)

  const [stored, metrics] = await Promise.all([
    pool.query<{ type: GoalType; target: number }>(
      'SELECT "type", "target"::int AS "target" FROM "guild_goal" WHERE "userId" = $1 AND "guildId" = $2',
      [session.user.id, guildId],
    ),
    withWebReadRouter(async (router) => {
      const bundle = await router.readAnalyticsBundle({ guildId, dateFrom: startDate, dateTo: endDate })
      return buildProjectionGoalMetrics(bundle, startDate, endDate)
    }),
  ])

  return NextResponse.json({
    goals: stored.rows.map((goal) => ({ ...goal, current: metrics.values[goal.type] })),
    readMeta: metrics.readMeta,
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
