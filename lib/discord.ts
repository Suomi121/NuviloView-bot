import 'server-only'

import { authStorage } from '@/lib/auth-storage'

type DiscordGuild = {
  id: string
  name: string
  icon: string | null
  owner: boolean
  permissions: string
}

type DiscordAccount = {
  id: string
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: Date | string | null
}

type DiscordTokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
}

export type ManagedGuild = Pick<DiscordGuild, 'id' | 'name' | 'icon'>

type ManagedGuildCacheRow = {
  guilds: unknown
  updatedAt: Date | string
}

const MANAGE_GUILD = BigInt('32')
const discordClientId = process.env.NUVILOVIEW_CLIENT_ID ?? process.env.DISCORD_CLIENT_ID
const discordClientSecret = process.env.NUVILOVIEW_CLIENT_SECRET ?? process.env.DISCORD_CLIENT_SECRET
const MANAGED_GUILD_CACHE_TTL_MS = 60_000
const MANAGED_GUILD_CACHE_STALE_MAX_MS = 15 * 60_000
const globalGuildCache = globalThis as typeof globalThis & {
  nuviloManagedGuildLoads?: Map<string, Promise<ManagedGuild[]>>
}
const managedGuildLoads = globalGuildCache.nuviloManagedGuildLoads ??= new Map()

function normalizeManagedGuilds(value: unknown): ManagedGuild[] {
  if (!Array.isArray(value)) return []
  return value.filter((guild): guild is ManagedGuild => {
    if (!guild || typeof guild !== 'object') return false
    const candidate = guild as Partial<ManagedGuild>
    return (
      typeof candidate.id === 'string' && /^\d{16,22}$/.test(candidate.id) &&
      typeof candidate.name === 'string' &&
      (candidate.icon === null || typeof candidate.icon === 'string')
    )
  })
}

async function readManagedGuildCache(userId: string) {
  const row = await authStorage.guildAccess.getManagedGuildCache(userId) as ManagedGuildCacheRow | null
  if (!row) return null
  return {
    guilds: normalizeManagedGuilds(row.guilds),
    updatedAt: new Date(row.updatedAt).getTime(),
  }
}

async function writeManagedGuildCache(userId: string, guilds: ManagedGuild[]) {
  await authStorage.guildAccess.setManagedGuildCache(userId, guilds)
}

async function refreshDiscordAccessToken(account: DiscordAccount) {
  if (!account.refreshToken || !discordClientId || !discordClientSecret) return null

  const credentials = Buffer.from(`${discordClientId}:${discordClientSecret}`).toString('base64')
  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken }),
    cache: 'no-store',
  })
  if (!response.ok) return null

  const tokens = (await response.json()) as DiscordTokenResponse
  if (!tokens.access_token || !Number.isFinite(tokens.expires_in)) return null
  const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  await authStorage.guildAccess.updateDiscordTokens(
    account.id,
    tokens.access_token,
    tokens.refresh_token ?? account.refreshToken,
    accessTokenExpiresAt,
  )
  return tokens.access_token
}

async function fetchDiscordGuilds(accessToken: string) {
  return fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
}

async function fetchManagedGuilds(userId: string): Promise<ManagedGuild[]> {
  const linkedAccount = await authStorage.guildAccess.getDiscordAccount(userId) as DiscordAccount | null
  if (!linkedAccount?.accessToken) return []

  const expiresAt = linkedAccount.accessTokenExpiresAt ? new Date(linkedAccount.accessTokenExpiresAt).getTime() : Number.POSITIVE_INFINITY
  let accessToken = linkedAccount.accessToken
  let refreshed = false
  if (expiresAt <= Date.now() + 60_000) {
    const nextAccessToken = await refreshDiscordAccessToken(linkedAccount)
    if (nextAccessToken) {
      accessToken = nextAccessToken
      refreshed = true
    }
  }

  let response = await fetchDiscordGuilds(accessToken)
  if (response.status === 401 && !refreshed) {
    const nextAccessToken = await refreshDiscordAccessToken(linkedAccount)
    if (nextAccessToken) response = await fetchDiscordGuilds(nextAccessToken)
  }

  if (!response.ok) {
    throw new Error(`Discord guild fetch failed: ${response.status}`)
  }

  const guilds = (await response.json()) as DiscordGuild[]
  return guilds
    .filter((guild) => guild.owner || (BigInt(guild.permissions) & MANAGE_GUILD) === MANAGE_GUILD)
    .map(({ id, name, icon }) => ({ id, name, icon }))
}

export async function getManagedGuilds(userId: string): Promise<ManagedGuild[]> {
  const cached = await readManagedGuildCache(userId)
  if (cached && Date.now() - cached.updatedAt < MANAGED_GUILD_CACHE_TTL_MS) {
    return cached.guilds
  }

  // Coalesce simultaneous dashboard, theme, goals and notification checks in
  // the same runtime. The Neon row provides the same cache across runtimes.
  const existingLoad = managedGuildLoads.get(userId)
  if (existingLoad) return existingLoad

  const load = (async () => {
    try {
      const guilds = await fetchManagedGuilds(userId)
      await writeManagedGuildCache(userId, guilds)
      return guilds
    } catch (error) {
      // Discord can briefly return 429 while several protected endpoints open
      // together. A previously verified list keeps the dashboard usable; it is
      // refreshed again after the short TTL instead of weakening authorization.
      const fallback = cached ?? await readManagedGuildCache(userId)
      if (fallback && Date.now() - fallback.updatedAt < MANAGED_GUILD_CACHE_STALE_MAX_MS) {
        return fallback.guilds
      }
      throw error
    }
  })()

  managedGuildLoads.set(userId, load)
  try {
    return await load
  } finally {
    if (managedGuildLoads.get(userId) === load) managedGuildLoads.delete(userId)
  }
}
