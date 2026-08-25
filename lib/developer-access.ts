import 'server-only'

import { auth } from '@/lib/auth'
import { authStorage } from '@/lib/auth-storage'
import { parseDeveloperIds } from '@/lib/guild-reset-utils.mjs'

export type DeveloperAccess = {
  userId: string
  discordUserId: string
  displayName: string
}

// Access is based on the Discord account actually linked to the current
// Better Auth session, not a browser-supplied ID or display name.
export async function getDeveloperAccess(request: Request): Promise<DeveloperAccess | null> {
  const developerDiscordIds = parseDeveloperIds(process.env)
  if (developerDiscordIds.size === 0) return null

  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) return null

  const discordUserId = await authStorage.guildAccess.getDiscordUserId(session.user.id)
  if (!discordUserId || !developerDiscordIds.has(discordUserId)) return null

  return {
    userId: session.user.id,
    discordUserId,
    displayName: session.user.name || 'Developer',
  }
}
