import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { defaultGuildTheme, type GuildTheme } from '@/lib/guild-theme'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'

const hex = /^#[0-9a-fA-F]{6}$/
const guildId = /^\d{16,22}$/

async function sessionAndGuild(request: Request, id: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !guildId.test(id)) return null
  const guilds = await getManagedGuilds(session.user.id)
  return guilds.some((guild) => guild.id === id) ? session : null
}

function normalizeTheme(input: unknown): GuildTheme | null {
  const value = input as Partial<GuildTheme> | null
  if (!value) return null
  if (![value.primaryColor, value.accentColor, value.backgroundColor, value.cardColor].every((color) => typeof color === 'string' && hex.test(color))) return null
  if (!['compact', 'default', 'rounded'].includes(value.radius ?? '')) return null
  const logoUrl = typeof value.logoUrl === 'string' ? value.logoUrl.trim() : ''
  if (logoUrl) {
    try { if (new URL(logoUrl).protocol !== 'https:') return null } catch { return null }
  }
  return { mode: 'dark', primaryColor: value.primaryColor!, accentColor: value.accentColor!, backgroundColor: value.backgroundColor!.toLowerCase() === '#f5f5f8' ? '#111116' : value.backgroundColor!, cardColor: value.cardColor!.toLowerCase() === '#ffffff' ? '#1c1c24' : value.cardColor!, radius: value.radius as GuildTheme['radius'], brandName: defaultGuildTheme.brandName, logoUrl: logoUrl || null }
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('guildId') ?? ''
  const session = await sessionAndGuild(request, id)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const result = await pool.query<GuildTheme>('SELECT "mode", "primaryColor", "accentColor", "backgroundColor", "cardColor", "radius", "brandName", "logoUrl" FROM "guild_theme" WHERE "userId" = $1 AND "guildId" = $2', [session.user.id, id])
  const stored = result.rows[0]
  return NextResponse.json({ theme: stored ? { ...stored, mode: 'dark', brandName: defaultGuildTheme.brandName, backgroundColor: stored.backgroundColor.toLowerCase() === '#f5f5f8' ? '#111116' : stored.backgroundColor, cardColor: stored.cardColor.toLowerCase() === '#ffffff' ? '#1c1c24' : stored.cardColor } : defaultGuildTheme })
}

export async function PUT(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 8_192)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const body = await request.json().catch(() => null)
  const id = typeof body?.guildId === 'string' ? body.guildId : ''
  const session = await sessionAndGuild(request, id)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, { scope: 'guild-theme-write', limit: 20, windowSeconds: 60, identity: session.user.id, failClosed: true })) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const theme = normalizeTheme(body?.theme)
  if (!theme) return NextResponse.json({ error: 'Invalid theme settings' }, { status: 400 })
  await pool.query(`INSERT INTO "guild_theme" ("userId", "guildId", "mode", "primaryColor", "accentColor", "backgroundColor", "cardColor", "radius", "brandName", "logoUrl", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT ("userId", "guildId") DO UPDATE SET "mode"=EXCLUDED."mode", "primaryColor"=EXCLUDED."primaryColor", "accentColor"=EXCLUDED."accentColor", "backgroundColor"=EXCLUDED."backgroundColor", "cardColor"=EXCLUDED."cardColor", "radius"=EXCLUDED."radius", "brandName"=EXCLUDED."brandName", "logoUrl"=EXCLUDED."logoUrl", "updatedAt"=now()`, [session.user.id, id, theme.mode, theme.primaryColor, theme.accentColor, theme.backgroundColor, theme.cardColor, theme.radius, theme.brandName, theme.logoUrl])
  return NextResponse.json({ theme })
}

export async function DELETE(request: Request) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = new URL(request.url).searchParams.get('guildId') ?? ''
  const session = await sessionAndGuild(request, id)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await pool.query('DELETE FROM "guild_theme" WHERE "userId" = $1 AND "guildId" = $2', [session.user.id, id])
  return NextResponse.json({ theme: defaultGuildTheme })
}
