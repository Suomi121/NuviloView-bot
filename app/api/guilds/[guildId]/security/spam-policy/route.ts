import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { authStorage } from '@/lib/auth-storage'
import { pool } from '@/lib/db'
import { getManagedGuilds } from '@/lib/discord'
import { hasJsonBody, isTrustedMutation } from '@/lib/request-security'
import {
  DEFAULT_GUILD_SPAM_POLICY,
  canAccessGuildSpamPolicy,
  getChangedSpamPolicyFields,
  normalizeGuildSpamPolicy,
  parseGuildSpamPolicyRow,
  type GuildSpamPolicy,
} from '@/lib/guild-spam-policy.mjs'

export const dynamic = 'force-dynamic'

const guildIdPattern = /^\d{16,22}$/
async function authorizeGuild(request: Request, guildId: string, scope: string) {
  if (!guildIdPattern.test(guildId)) {
    return { response: NextResponse.json({ error: 'Guildを確認できません。' }, { status: 400 }) } as const
  }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  }
  try {
    const managedGuilds = await getManagedGuilds(session.user.id)
    if (!canAccessGuildSpamPolicy(managedGuilds, guildId)) {
      return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) } as const
    }
  } catch {
    return { response: NextResponse.json({ error: 'Guild権限を確認できません。' }, { status: 503 }) } as const
  }
  try {
    if (await authStorage.rateLimit.isLimited({ scope, limit: 20, windowSeconds: 60, identity: session.user.id })) {
      return { response: NextResponse.json({ error: 'しばらく待ってから再試行してください。' }, { status: 429 }) } as const
    }
  } catch {
    return { response: NextResponse.json({ error: 'Guild権限を確認できません。' }, { status: 503 }) } as const
  }
  return { session } as const
}

function safeFailure(operation: string, error: unknown) {
  const code = String((error as { code?: unknown; name?: unknown })?.code ?? (error as { name?: unknown })?.name ?? 'DATABASE_ERROR').slice(0, 40)
  console.error(`Guild spam policy ${operation} failed: code=${code}`)
  return NextResponse.json({ error: 'スパム設定を処理できませんでした。' }, { status: 503 })
}

function publicPolicy(policy: Readonly<GuildSpamPolicy>) {
  return { ...policy, updatedBy: null }
}

export async function GET(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params
  const access = await authorizeGuild(request, guildId, 'guild-spam-policy-read')
  if ('response' in access) return access.response
  try {
    const result = await pool.query('SELECT * FROM "guild_spam_policy" WHERE "guild_id" = $1 LIMIT 1', [guildId])
    const policy = parseGuildSpamPolicyRow(result.rows[0] ?? null)
    if (result.rows[0] && !policy) return NextResponse.json({ error: '保存済み設定を検証できません。' }, { status: 503 })
    return NextResponse.json({ policy: publicPolicy(policy ?? DEFAULT_GUILD_SPAM_POLICY), isCustom: Boolean(policy) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return safeFailure('read', error)
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 8_192)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { guildId } = await params
  const access = await authorizeGuild(request, guildId, 'guild-spam-policy-write')
  if ('response' in access) return access.response
  const body = await request.json().catch(() => null)
  const policy = normalizeGuildSpamPolicy(body?.policy)
  if (!policy) return NextResponse.json({ error: '設定値の形式が正しくありません。' }, { status: 400 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const previousResult = await client.query('SELECT * FROM "guild_spam_policy" WHERE "guild_id" = $1 FOR UPDATE', [guildId])
    const previous = parseGuildSpamPolicyRow(previousResult.rows[0] ?? null)
    const values = [
      policy.enabled, policy.preset, policy.messageCountThreshold, policy.messageWindowSeconds,
      policy.duplicateCountThreshold, policy.duplicateWindowSeconds, policy.mentionCountThreshold,
      policy.mentionWindowSeconds, policy.linkCountThreshold, policy.linkWindowSeconds,
      policy.crossChannelThreshold, policy.crossChannelWindowSeconds, policy.action,
      policy.ignoreBots, policy.ignoreAdmins, policy.ignoredRoleIds, policy.ignoredChannelIds,
      access.session.user.id,
    ]
    const savedResult = await client.query(`
      INSERT INTO "guild_spam_policy" (
        "guild_id", "enabled", "preset", "message_count_threshold", "message_window_seconds",
        "duplicate_count_threshold", "duplicate_window_seconds", "mention_count_threshold", "mention_window_seconds",
        "link_count_threshold", "link_window_seconds", "cross_channel_threshold", "cross_channel_window_seconds",
        "action", "ignore_bots", "ignore_admins", "ignored_role_ids", "ignored_channel_ids", "updated_by", "updated_at"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
      ON CONFLICT ("guild_id") DO UPDATE SET
        "enabled" = EXCLUDED."enabled", "preset" = EXCLUDED."preset",
        "message_count_threshold" = EXCLUDED."message_count_threshold", "message_window_seconds" = EXCLUDED."message_window_seconds",
        "duplicate_count_threshold" = EXCLUDED."duplicate_count_threshold", "duplicate_window_seconds" = EXCLUDED."duplicate_window_seconds",
        "mention_count_threshold" = EXCLUDED."mention_count_threshold", "mention_window_seconds" = EXCLUDED."mention_window_seconds",
        "link_count_threshold" = EXCLUDED."link_count_threshold", "link_window_seconds" = EXCLUDED."link_window_seconds",
        "cross_channel_threshold" = EXCLUDED."cross_channel_threshold", "cross_channel_window_seconds" = EXCLUDED."cross_channel_window_seconds",
        "action" = EXCLUDED."action", "ignore_bots" = EXCLUDED."ignore_bots", "ignore_admins" = EXCLUDED."ignore_admins",
        "ignored_role_ids" = EXCLUDED."ignored_role_ids", "ignored_channel_ids" = EXCLUDED."ignored_channel_ids",
        "updated_by" = EXCLUDED."updated_by", "updated_at" = now()
      RETURNING *
    `, [guildId, ...values])
    const changedFields = getChangedSpamPolicyFields(previous, policy)
    await client.query(`
      INSERT INTO "guild_spam_policy_audit" ("guild_id", "changed_by", "old_preset", "new_preset", "changed_fields")
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [guildId, access.session.user.id, previous?.preset ?? null, policy.preset, JSON.stringify(changedFields)])
    await client.query('COMMIT')
    const saved = parseGuildSpamPolicyRow(savedResult.rows[0])
    return NextResponse.json({ policy: saved ? publicPolicy(saved) : null, isCustom: true }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return safeFailure('write', error)
  } finally {
    client.release()
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { guildId } = await params
  const access = await authorizeGuild(request, guildId, 'guild-spam-policy-reset')
  if ('response' in access) return access.response
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const previousResult = await client.query('SELECT "preset" FROM "guild_spam_policy" WHERE "guild_id" = $1 FOR UPDATE', [guildId])
    const oldPreset = previousResult.rows[0]?.preset ?? null
    if (oldPreset) {
      await client.query('DELETE FROM "guild_spam_policy" WHERE "guild_id" = $1', [guildId])
      await client.query(`
        INSERT INTO "guild_spam_policy_audit" ("guild_id", "changed_by", "old_preset", "new_preset", "changed_fields")
        VALUES ($1, $2, $3, 'DEFAULT', '["reset"]'::jsonb)
      `, [guildId, access.session.user.id, oldPreset])
    }
    await client.query('COMMIT')
    return NextResponse.json({ policy: publicPolicy(DEFAULT_GUILD_SPAM_POLICY), isCustom: false }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return safeFailure('reset', error)
  } finally {
    client.release()
  }
}
