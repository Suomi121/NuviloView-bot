import { NextResponse } from 'next/server'
import { getDeveloperAccess } from '@/lib/developer-access'
import { pool } from '@/lib/db'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'
import { createAuditLogHash, verifyAuditLogHash } from '@/lib/audit-log'

export const dynamic = 'force-dynamic'

const guildIdPattern = /^\d{16,22}$/

async function purgeGuildData(guildId: string) {
  await Promise.all([
    pool.query('DELETE FROM "daily_stats" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "daily_active_member" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "recent_activity" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "discord_message" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "voice_session" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "voice_server_session" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "bot_channel_access" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "history_import_job" WHERE "guildId" = $1', [guildId]),
    pool.query('DELETE FROM "user_notification" WHERE "guildId" = $1', [guildId]),
  ])
}

export async function GET(request: Request) {
  const access = await getDeveloperAccess(request)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, { scope: 'developer-guilds-read', limit: 60, windowSeconds: 60, identity: access.userId, failClosed: true })) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  try {
    const [guilds, audit, heartbeat] = await Promise.all([
      pool.query<{
        guildId: string; name: string | null; iconUrl: string | null; ownerId: string | null
        memberCount: number | null; isConnected: boolean | null; lastSeenAt: Date | null
        reason: string | null; blockedBy: string | null; blockedAt: Date | null
      }>(`
        SELECT
          COALESCE(registry."guildId", blocklist."guildId") AS "guildId",
          registry."name", registry."iconUrl", registry."ownerId", registry."memberCount",
          registry."isConnected", registry."lastSeenAt",
          blocklist."reason", blocklist."blockedBy", blocklist."blockedAt"
        FROM "bot_guild_registry" AS registry
        FULL OUTER JOIN "bot_guild_blocklist" AS blocklist
          ON blocklist."guildId" = registry."guildId"
        ORDER BY (blocklist."guildId" IS NOT NULL) DESC, registry."name" ASC NULLS LAST, COALESCE(registry."guildId", blocklist."guildId") ASC
      `),
      pool.query<{
        id: number; guildId: string; action: string; reason: string | null
        performedBy: string; performedByName: string | null; source: string; createdAt: Date; previousHash: string | null; entryHash: string | null
      }>(`
        SELECT "id", "guildId", "action", "reason", "performedBy", "performedByName", "source", "createdAt", "previousHash", "entryHash"
        FROM "bot_guild_block_audit"
        ORDER BY "createdAt" DESC
      `),
      pool.query<{ lastSeenAt: Date | null; stoppedAt: Date | null }>(`
        SELECT "lastSeenAt", "stoppedAt"
        FROM "bot_heartbeat"
        WHERE "id" = 'primary'
        LIMIT 1
      `),
    ])
    const latestHeartbeat = heartbeat.rows[0] ?? null
    const lastSeen = latestHeartbeat?.lastSeenAt ? new Date(latestHeartbeat.lastSeenAt).getTime() : 0
    const botOnline = Boolean(latestHeartbeat) && !latestHeartbeat?.stoppedAt && Date.now() - lastSeen <= 3 * 60 * 1000
    const chainedAudit = [...audit.rows].reverse().filter((entry) => entry.entryHash)
    let previousHash = 'GENESIS'
    const auditIntegrity = chainedAudit.every((entry) => {
      const valid = entry.previousHash === previousHash && verifyAuditLogHash({ ...entry, createdAt: new Date(entry.createdAt).toISOString(), previousHash })
      previousHash = entry.entryHash ?? previousHash
      return valid
    })
    return NextResponse.json({
      guilds: guilds.rows,
      audit: audit.rows,
      bot: { online: botOnline, lastSeenAt: latestHeartbeat?.lastSeenAt ?? null },
      auditIntegrity: { valid: auditIntegrity, checked: chainedAudit.length },
    })
  } catch (error) {
    console.error('Failed to load developer guild management data:', error)
    return NextResponse.json({ error: 'Unable to load developer data' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 2_048)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const access = await getDeveloperAccess(request)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, { scope: 'developer-guilds-write', limit: 10, windowSeconds: 60, identity: access.userId, failClosed: true })) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const body = await request.json().catch(() => null)
  const action = body?.action === 'block' || body?.action === 'unblock' ? body.action : null
  const guildId = typeof body?.guildId === 'string' ? body.guildId.trim() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
  if (!action || !guildIdPattern.test(guildId)) return NextResponse.json({ error: 'Invalid guild' }, { status: 400 })
  if (guildId === process.env.DISCORD_DEV_GUILD_ID) return NextResponse.json({ error: 'The development server cannot be blocked' }, { status: 400 })
  if (action === 'block' && reason.length < 3) return NextResponse.json({ error: 'A reason of at least 3 characters is required' }, { status: 400 })

  try {
    if (action === 'block') {
      await pool.query(`
        INSERT INTO "bot_guild_blocklist" ("guildId", "reason", "blockedBy")
        VALUES ($1, $2, $3)
        ON CONFLICT ("guildId") DO UPDATE SET
          "reason" = EXCLUDED."reason", "blockedBy" = EXCLUDED."blockedBy", "blockedAt" = now()
      `, [guildId, reason, access.discordUserId])
      await purgeGuildData(guildId)
    } else {
      await pool.query('DELETE FROM "bot_guild_blocklist" WHERE "guildId" = $1', [guildId])
    }

    const previous = await pool.query<{ entryHash: string | null }>('SELECT "entryHash" FROM "bot_guild_block_audit" WHERE "entryHash" IS NOT NULL ORDER BY "id" DESC LIMIT 1')
    const previousHash = previous.rows[0]?.entryHash ?? 'GENESIS'
    const createdAt = new Date().toISOString()
    const auditReason = action === 'block' ? reason : null
    const entryHash = createAuditLogHash({ guildId, action, reason: auditReason, performedBy: access.discordUserId, performedByName: access.displayName, source: 'developer_dashboard', createdAt, previousHash })
    await pool.query(`
      INSERT INTO "bot_guild_block_audit" ("guildId", "action", "reason", "performedBy", "performedByName", "source", "createdAt", "previousHash", "entryHash")
      VALUES ($1, $2, $3, $4, $5, 'developer_dashboard', $6, $7, $8)
    `, [guildId, action, auditReason, access.discordUserId, access.displayName, createdAt, previousHash, entryHash])
    return NextResponse.json({ ok: true, message: action === 'block' ? 'Guildをブロックしました。Botは15秒以内に停止・退出します。' : 'Guildのブロックを解除しました。' })
  } catch (error) {
    console.error('Failed to change guild block status:', error)
    return NextResponse.json({ error: 'Unable to update block status' }, { status: 500 })
  }
}
