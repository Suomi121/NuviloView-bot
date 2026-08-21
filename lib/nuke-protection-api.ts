import 'server-only'

import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'
import {
  SECURITY_SCOPES,
  hasSecurityScope,
  isDiscordSnowflake,
  securityScopesForAccess,
} from '@/lib/nuke-security-api-utils.mjs'

export class SecurityApiError extends Error {
  constructor(
    public code: string,
    public publicMessage: string,
    public status = 400,
  ) {
    super(publicMessage)
  }
}

export type SecurityApiContext = {
  sessionUserId: string
  discordUserId: string
  displayName: string
  guildId: string
  guildName: string
  ownerId: string | null
  connected: boolean
  scopes: string[]
  featureEnabled: boolean
}

function featureEnabled() {
  return process.env.NUVILOVIEW_NUKE_PROTECTION?.trim().toLowerCase() === 'true'
}

export function securityApiError(error: unknown) {
  if (error instanceof SecurityApiError) {
    return NextResponse.json({ error: error.publicMessage, code: error.code }, { status: error.status })
  }
  console.error('Nuke Protection API failed:', error)
  return NextResponse.json(
    { error: 'Security request could not be processed', code: 'INTERNAL_ERROR' },
    { status: 500 },
  )
}

export function assertSecurityMutation(request: Request, maximumBytes = 16_384) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, maximumBytes)) {
    throw new SecurityApiError('INVALID_REQUEST', 'リクエストを確認できません。', 403)
  }
}

export async function getSecurityApiContext(
  request: Request,
  guildId: string,
  options: {
    requiredScope?: string
    requireFeature?: boolean
    requireConnected?: boolean
    rateScope: string
    rateLimit?: number
    windowSeconds?: number
  },
): Promise<SecurityApiContext> {
  if (!isDiscordSnowflake(guildId)) {
    throw new SecurityApiError('INVALID_GUILD_ID', 'Guild IDの形式が正しくありません。')
  }
  const enabled = featureEnabled()
  if (options.requireFeature !== false && !enabled) {
    throw new SecurityApiError('FEATURE_DISABLED', 'Nuke Protectionは現在無効です。', 503)
  }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) throw new SecurityApiError('UNAUTHORIZED', 'ログインが必要です。', 401)
  if (await isRateLimited(request, {
    scope: options.rateScope,
    limit: options.rateLimit ?? 30,
    windowSeconds: options.windowSeconds ?? 60,
    identity: session.user.id,
    failClosed: options.requiredScope !== undefined,
  })) {
    throw new SecurityApiError('RATE_LIMIT', 'リクエスト回数が多すぎます。少し待ってください。', 429)
  }
  const [managedGuilds, account, registry] = await Promise.all([
    getManagedGuilds(session.user.id),
    pool.query<{ accountId: string }>(`
      SELECT "accountId" FROM "account"
      WHERE "userId" = $1 AND "providerId" = 'discord'
      ORDER BY "createdAt" DESC LIMIT 1
    `, [session.user.id]),
    pool.query<{ name: string; ownerId: string | null; isConnected: boolean; blocked: boolean }>(`
      SELECT registry."name", registry."ownerId", registry."isConnected",
             (blocklist."guildId" IS NOT NULL) AS "blocked"
      FROM "bot_guild_registry" AS registry
      LEFT JOIN "bot_guild_blocklist" AS blocklist ON blocklist."guildId" = registry."guildId"
      WHERE registry."guildId" = $1 LIMIT 1
    `, [guildId]),
  ])
  const discordUserId = account.rows[0]?.accountId
  const guild = registry.rows[0]
  const managedGuild = managedGuilds.some((candidate) => candidate.id === guildId)
  if (!discordUserId || !managedGuild) {
    throw new SecurityApiError('GUILD_FORBIDDEN', 'このGuildのSecurity情報を表示する権限がありません。', 403)
  }
  if (!guild || guild.blocked) {
    throw new SecurityApiError('GUILD_UNAVAILABLE', '対象Guildを確認できません。', 404)
  }
  if (options.requireConnected !== false && !guild.isConnected) {
    throw new SecurityApiError('PROTECTION_OFFLINE', 'NuviloView BotがGuildへ接続されていません。', 409)
  }
  const scopes = securityScopesForAccess({
    managedGuild,
    guildOwner: guild.ownerId === discordUserId,
  })
  if (options.requiredScope && !hasSecurityScope(scopes, options.requiredScope)) {
    throw new SecurityApiError('SCOPE_FORBIDDEN', 'このSecurity操作を実行する権限がありません。', 403)
  }
  return {
    sessionUserId: session.user.id,
    discordUserId,
    displayName: session.user.name || 'Guild administrator',
    guildId,
    guildName: guild.name,
    ownerId: guild.ownerId,
    connected: guild.isConnected,
    scopes,
    featureEnabled: enabled,
  }
}

export async function enqueueSecurityAction(
  context: SecurityApiContext,
  action: 'contain' | 'snapshot' | 'restore_preview',
  input: { incidentId?: string | null; payload?: Record<string, unknown> } = {},
) {
  const requestId = randomUUID()
  await pool.query(`
    INSERT INTO "security_action_request" (
      "id", "guildId", "incidentId", "action", "requestedBy", "requestedByName", "payload", "status", "createdAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'queued', now())
  `, [
    requestId,
    context.guildId,
    input.incidentId ?? null,
    action,
    context.discordUserId,
    context.displayName,
    JSON.stringify(input.payload ?? {}),
  ])
  await pool.query(`
    INSERT INTO "security_audit_event" (
      "guildId", "incidentId", "eventType", "actorId", "actorName", "source", "details", "createdAt"
    ) VALUES ($1, $2, $3, $4, $5, 'dashboard', $6::jsonb, now())
  `, [
    context.guildId,
    input.incidentId ?? null,
    action === 'contain' ? 'ContainmentRequested' : action === 'snapshot' ? 'SnapshotRequested' : 'RestorePreviewRequested',
    context.discordUserId,
    context.displayName,
    JSON.stringify({ requestId }),
  ])
  return requestId
}

export { SECURITY_SCOPES }
