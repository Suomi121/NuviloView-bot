import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'

const guildPattern = /^\d{16,22}$/

async function sessionAndGuild(request: Request, guildId: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !guildPattern.test(guildId)) return null
  const guilds = await getManagedGuilds(session.user.id)
  return guilds.some((guild) => guild.id === guildId) ? session : null
}

export async function GET(request: Request) {
  const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
  const session = await sessionAndGuild(request, guildId)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const result = await pool.query(`SELECT "slug", "enabled", "description", "showMembers", "showMessages", "showVoice", "showChannels" FROM "guild_public_report" WHERE "userId"=$1 AND "guildId"=$2`, [session.user.id, guildId])
  return NextResponse.json({ report: result.rows[0] ?? null })
}

export async function PUT(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 8_192)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const body = await request.json().catch(() => null)
  const guildId = typeof body?.guildId === 'string' ? body.guildId : ''
  const session = await sessionAndGuild(request, guildId)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, { scope: 'public-report-write', limit: 10, windowSeconds: 60, identity: session.user.id, failClosed: true })) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 280) : ''
  const bool = (key: string, fallback: boolean) => typeof body?.[key] === 'boolean' ? body[key] : fallback
  const enabled = bool('enabled', false)
  const flags = [bool('showMembers', true), bool('showMessages', true), bool('showVoice', true), bool('showChannels', true)]
  const current = await pool.query<{ slug: string }>('SELECT "slug" FROM "guild_public_report" WHERE "userId"=$1 AND "guildId"=$2', [session.user.id, guildId])
  const slug = current.rows[0]?.slug ?? randomUUID().replace(/-/g, '').slice(0, 18)
  const result = await pool.query(`
    INSERT INTO "guild_public_report" ("userId","guildId","slug","enabled","description","showMembers","showMessages","showVoice","showChannels","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT ("userId","guildId") DO UPDATE SET "enabled"=EXCLUDED."enabled", "description"=EXCLUDED."description", "showMembers"=EXCLUDED."showMembers", "showMessages"=EXCLUDED."showMessages", "showVoice"=EXCLUDED."showVoice", "showChannels"=EXCLUDED."showChannels", "updatedAt"=now()
    RETURNING "slug","enabled","description","showMembers","showMessages","showVoice","showChannels"
  `, [session.user.id, guildId, slug, enabled, description, ...flags])
  return NextResponse.json({ report: result.rows[0] })
}
