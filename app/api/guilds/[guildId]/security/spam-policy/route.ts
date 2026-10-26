import { NextResponse } from 'next/server'
import { enrollSecurityV2, readSecurityV2, setSecurityV2Auto } from '@/lib/security-v2-consent.mjs'
import { auth } from '@/lib/auth'
import { authStorage } from '@/lib/auth-storage'
import { pool } from '@/lib/db'
import { getSecurityCoordinator } from '@/lib/multi-db/web-runtime'
import { getManagedGuilds } from '@/lib/discord'
import { hasJsonBody, isTrustedMutation } from '@/lib/request-security'
import {
  DEFAULT_GUILD_SPAM_POLICY,
  canAccessGuildSpamPolicy,
  getChangedSpamPolicyFields,
  getSpamPolicyAuditChanges,
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
  if (code === '55000' && (error as { message?: string })?.message?.includes('SECURITY_QUORUM_AUTHORITY')) return quorumRequiredResponse()
  if (code === 'MDB_REVISION_CONFLICT' || code === 'MDB_IDEMPOTENCY_CONFLICT') return NextResponse.json({ code, error: 'ほかの操作で設定が更新されました。再読込してください。' }, { status: 409 })
  if (code.startsWith('MDB_')) return NextResponse.json({ code: 'MDB_UNAVAILABLE', readOnly: true, error: 'DBの合意を確認できません。保存結果は再読込で確認してください。' }, { status: 503 })
  if (code === '55000') return localAuthorityResponse()
  console.error(`Guild spam policy ${operation} failed: code=${code}`)
  return NextResponse.json({ error: 'スパム設定を処理できませんでした。' }, { status: 503 })
}

function localAuthorityResponse() {
  return NextResponse.json({ code: 'SPAM_POLICY_SQLITE_AUTHORITY', authority: 'sqlite',
    error: 'この設定はDiscordの /spamprotection から変更してください。Webでの変更は停止しています。' },
  { status: 409, headers: { 'Cache-Control': 'private, no-store' } })
}

function quorumRequiredResponse() {
  return NextResponse.json({ code: 'MDB_COORDINATOR_REQUIRED', readOnly: true,
    error: 'このGuildは共通DB調整方式へ移管済みです。WebとBotのリリース設定を確認してください。' },
  { status: 409, headers: { 'Cache-Control': 'private, no-store' } })
}

function publicPolicy(policy: Readonly<GuildSpamPolicy>) {
  return { ...policy, updatedBy: null }
}

function coordinatedResponse(state: { value: { revision: number; epoch: string; data: { policy: GuildSpamPolicy; autoTimeout: boolean; emergencyStop: boolean; migrationState: string } }; checksum: string }) {
  const data = state.value.data
  return NextResponse.json({ policy: publicPolicy(data.policy), isCustom: true,
    concurrency: { revision: state.value.revision, checksum: state.checksum, epoch: state.value.epoch }, authority: 'cloud-quorum',
    auto: { autoTimeout: data.autoTimeout, emergencyStop: data.emergencyStop || process.env.SECURITY_V2_AUTO_EXECUTION !== 'enabled', migrationState: data.migrationState, policyMissing: false } },
  { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function GET(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params
  const access = await authorizeGuild(request, guildId, 'guild-spam-policy-read')
  if ('response' in access) return access.response
  try {
    const runtime = await getSecurityCoordinator()
    if (runtime) return coordinatedResponse(await runtime.security.read(guildId))
    const quorumTable = await pool.query("SELECT to_regclass('public.guild_security_quorum_fence') AS name")
    if (quorumTable.rows[0]?.name) {
      const fenced = await pool.query('SELECT 1 FROM guild_security_quorum_fence WHERE guild_id=$1', [guildId])
      if (fenced.rowCount) return quorumRequiredResponse()
    }
    const authorityTable = await pool.query("SELECT to_regclass('public.guild_spam_policy_authority') AS name")
    if (authorityTable.rows[0]?.name) {
      const authority = await pool.query('SELECT 1 FROM guild_spam_policy_authority WHERE guild_id=$1', [guildId])
      if (authority.rowCount) return localAuthorityResponse()
    }
    const result = await pool.query('SELECT * FROM "guild_spam_policy" WHERE "guild_id" = $1 LIMIT 1', [guildId])
    const policy = parseGuildSpamPolicyRow(result.rows[0] ?? null)
    if (result.rows[0] && !policy) return NextResponse.json({ error: '保存済み設定を検証できません。' }, { status: 503 })
    const auto = await readSecurityV2((text: string, values: unknown[]) => pool.query(text, values), guildId)
    return NextResponse.json({ policy: publicPolicy(policy ?? DEFAULT_GUILD_SPAM_POLICY), isCustom: Boolean(policy), auto }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return safeFailure('read', error)
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, 1_024)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { guildId } = await params
  const access = await authorizeGuild(request, guildId, 'guild-spam-auto-write')
  if ('response' in access) return access.response
  const body = await request.json().catch(() => null)
  if (!['on', 'off'].includes(body?.operation)) return NextResponse.json({ error: 'Explicit on/off required' }, { status: 400 })
  try {
    const runtime = await getSecurityCoordinator()
    if (runtime) return coordinatedResponse(await runtime.security.change({ guildId,
      actorId: `web:${access.session.user.id}`, requestId: body.requestId,
      expectedRevision: body.concurrency?.revision, expectedChecksum: body.concurrency?.checksum,
      operation: `auto:${body.operation}`, value: null,
      authorize: async () => !('response' in await authorizeGuild(request, guildId, 'guild-spam-auto-confirm')) }))
    const actor = `web:${access.session.user.id}`
    const query = (text: string, values: unknown[]) => pool.query(text, values)
    await enrollSecurityV2(query, guildId)
    await setSecurityV2Auto(query, guildId, actor, body.operation)
    return NextResponse.json({ auto: await readSecurityV2(query, guildId) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return safeFailure('auto', error) }
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

  try {
    const runtime = await getSecurityCoordinator()
    if (runtime) return coordinatedResponse(await runtime.security.change({ guildId,
      actorId: `web:${access.session.user.id}`, requestId: body.requestId,
      expectedRevision: body.concurrency?.revision, expectedChecksum: body.concurrency?.checksum,
      operation: 'policy', value: policy,
      authorize: async () => !('response' in await authorizeGuild(request, guildId, 'guild-spam-policy-confirm')) }))
  } catch (error) { return safeFailure('coordinated-write', error) }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nuviloview:spam-policy:${guildId}`])
    const previousResult = await client.query('SELECT * FROM "guild_spam_policy" WHERE "guild_id" = $1 FOR UPDATE', [guildId])
    const previous = parseGuildSpamPolicyRow(previousResult.rows[0] ?? null)
    const values = [
      policy.enabled, policy.preset, policy.messageCountThreshold, policy.messageWindowSeconds,
      policy.duplicateCountThreshold, policy.duplicateWindowSeconds, policy.mentionCountThreshold,
      policy.mentionWindowSeconds, policy.linkCountThreshold, policy.linkWindowSeconds,
      policy.crossChannelThreshold, policy.crossChannelWindowSeconds, policy.action,
      policy.ignoreBots, policy.ignoreAdmins, policy.ignoredRoleIds, policy.ignoredChannelIds,
      access.session.user.id, policy.strength, policy.mode,
      policy.messageBurstEnabled, policy.duplicateEnabled, policy.mentionEnabled,
      policy.linkEnabled, policy.crossChannelEnabled,
    ]
    const savedResult = await client.query(`
      INSERT INTO "guild_spam_policy" (
        "guild_id", "enabled", "preset", "message_count_threshold", "message_window_seconds",
        "duplicate_count_threshold", "duplicate_window_seconds", "mention_count_threshold", "mention_window_seconds",
        "link_count_threshold", "link_window_seconds", "cross_channel_threshold", "cross_channel_window_seconds",
        "action", "ignore_bots", "ignore_admins", "ignored_role_ids", "ignored_channel_ids", "updated_by", "updated_at",
        "strength", "policy_mode", "message_burst_enabled", "duplicate_enabled", "mention_enabled", "link_enabled", "cross_channel_enabled"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now(), $20, $21, $22, $23, $24, $25, $26)
      ON CONFLICT ("guild_id") DO UPDATE SET
        "enabled" = EXCLUDED."enabled", "preset" = EXCLUDED."preset",
        "message_count_threshold" = EXCLUDED."message_count_threshold", "message_window_seconds" = EXCLUDED."message_window_seconds",
        "duplicate_count_threshold" = EXCLUDED."duplicate_count_threshold", "duplicate_window_seconds" = EXCLUDED."duplicate_window_seconds",
        "mention_count_threshold" = EXCLUDED."mention_count_threshold", "mention_window_seconds" = EXCLUDED."mention_window_seconds",
        "link_count_threshold" = EXCLUDED."link_count_threshold", "link_window_seconds" = EXCLUDED."link_window_seconds",
        "cross_channel_threshold" = EXCLUDED."cross_channel_threshold", "cross_channel_window_seconds" = EXCLUDED."cross_channel_window_seconds",
        "action" = EXCLUDED."action", "ignore_bots" = EXCLUDED."ignore_bots", "ignore_admins" = EXCLUDED."ignore_admins",
        "ignored_role_ids" = EXCLUDED."ignored_role_ids", "ignored_channel_ids" = EXCLUDED."ignored_channel_ids",
        "strength" = EXCLUDED."strength", "policy_mode" = EXCLUDED."policy_mode",
        "message_burst_enabled" = EXCLUDED."message_burst_enabled", "duplicate_enabled" = EXCLUDED."duplicate_enabled",
        "mention_enabled" = EXCLUDED."mention_enabled", "link_enabled" = EXCLUDED."link_enabled",
        "cross_channel_enabled" = EXCLUDED."cross_channel_enabled",
        "updated_by" = EXCLUDED."updated_by", "updated_at" = now()
      RETURNING *
    `, [guildId, ...values])
    const changedFields = getChangedSpamPolicyFields(previous, policy)
    await client.query(`
      INSERT INTO "guild_spam_policy_audit" ("guild_id", "changed_by", "old_preset", "new_preset", "changed_fields", "changes")
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
    `, [guildId, access.session.user.id, previous?.preset ?? null, policy.preset, JSON.stringify(changedFields), JSON.stringify(getSpamPolicyAuditChanges(previous, policy))])
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
  const access = await authorizeGuild(request, guildId, 'guild-spam-policy-reset-retired')
  if ('response' in access) return access.response
  return NextResponse.json({
    code: 'SPAM_RESET_RETIRED',
    error: 'Resetは廃止されました。設定は削除されません。検知設定は通常の保存操作で変更してください。',
  }, { status: 410, headers: { 'Cache-Control': 'private, no-store' } })
}
