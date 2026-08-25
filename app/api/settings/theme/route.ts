import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { authStorage } from '@/lib/auth-storage'
import { getManagedGuilds } from '@/lib/discord'
import { defaultGuildTheme, type GuildTheme } from '@/lib/guild-theme'
import { hasJsonBody, isTrustedMutation } from '@/lib/request-security'

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
  const stored = await authStorage.settings.getGuildTheme(session.user.id, id)
  return NextResponse.json({ theme: stored ? { ...stored, mode: 'dark', brandName: defaultGuildTheme.brandName, backgroundColor: stored.backgroundColor.toLowerCase() === '#f5f5f8' ? '#111116' : stored.backgroundColor, cardColor: stored.cardColor.toLowerCase() === '#ffffff' ? '#1c1c24' : stored.cardColor } : defaultGuildTheme })
}

export async function PUT(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 8_192)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const body = await request.json().catch(() => null)
  const id = typeof body?.guildId === 'string' ? body.guildId : ''
  const session = await sessionAndGuild(request, id)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await authStorage.rateLimit.isLimited({ scope: 'guild-theme-write', limit: 20, windowSeconds: 60, identity: session.user.id })) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const theme = normalizeTheme(body?.theme)
  if (!theme) return NextResponse.json({ error: 'Invalid theme settings' }, { status: 400 })
  const stored = await authStorage.settings.upsertGuildTheme(session.user.id, id, theme)
  return NextResponse.json({ theme: stored })
}

export async function DELETE(request: Request) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = new URL(request.url).searchParams.get('guildId') ?? ''
  const session = await sessionAndGuild(request, id)
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await authStorage.settings.deleteGuildTheme(session.user.id, id)
  return NextResponse.json({ theme: defaultGuildTheme })
}
