import 'server-only'

import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'

export type DeveloperAccess = {
  userId: string
  discordUserId: string
  displayName: string
}

// Access is based on the Discord account actually linked to the current
// Better Auth session, not a browser-supplied ID or display name.
export async function getDeveloperAccess(request: Request): Promise<DeveloperAccess | null> {
  const ownerDiscordId = process.env.DISCORD_OWNER_USER_ID?.trim()
  if (!ownerDiscordId) return null

  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) return null

  const result = await pool.query<{ accountId: string }>(`
    SELECT "accountId"
    FROM "account"
    WHERE "userId" = $1 AND "providerId" = 'discord'
    ORDER BY "createdAt" DESC
    LIMIT 1
  `, [session.user.id])
  const discordUserId = result.rows[0]?.accountId
  if (!discordUserId || discordUserId !== ownerDiscordId) return null

  return {
    userId: session.user.id,
    discordUserId,
    displayName: session.user.name || 'Developer',
  }
}
