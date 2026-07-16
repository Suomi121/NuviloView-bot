import 'server-only'

import { pool } from '@/lib/db'

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

const MANAGE_GUILD = BigInt('32')

async function refreshDiscordAccessToken(account: DiscordAccount) {
  if (!account.refreshToken || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return null

  const credentials = Buffer.from(`${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`).toString('base64')
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
  await pool.query(
    `UPDATE "account"
     SET "accessToken" = $1, "refreshToken" = $2, "accessTokenExpiresAt" = $3, "updatedAt" = now()
     WHERE "id" = $4`,
    [tokens.access_token, tokens.refresh_token ?? account.refreshToken, accessTokenExpiresAt, account.id],
  )
  return tokens.access_token
}

async function fetchDiscordGuilds(accessToken: string) {
  return fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
}

export async function getManagedGuilds(userId: string): Promise<ManagedGuild[]> {
  const account = await pool.query<DiscordAccount>(
    `SELECT "id", "accessToken", "refreshToken", "accessTokenExpiresAt" FROM "account"
     WHERE "userId" = $1 AND "providerId" = 'discord'
     ORDER BY "createdAt" DESC LIMIT 1`,
    [userId],
  )

  const linkedAccount = account.rows[0]
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
