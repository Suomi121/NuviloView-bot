import 'server-only'

import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getDeveloperAccess, type DeveloperAccess } from '@/lib/developer-access'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'
import {
  GuildResetError,
  generateConfirmationCode,
  getConfirmationSecret,
  getGuildResetConfig,
  hashConfirmationCode,
  isDiscordId,
  isExpired,
  normalizeResetOptions,
  parseIdList,
  verifyConfirmationCode,
} from '@/lib/guild-reset-utils.mjs'

export type ResetApiContext = {
  access: DeveloperAccess
  guildId: string
  registry: {
    name: string
    ownerId: string | null
    isConnected: boolean
  }
  settings: {
    enabled: boolean
    allowedAdminIds: string[]
  }
}

export function resetApiError(error: unknown) {
  if (error instanceof GuildResetError) {
    const status =
      error.code === 'DEVELOPER_FORBIDDEN' || error.code === 'GUILD_CONTROL_FORBIDDEN'
        ? 403
        : error.code === 'FEATURE_DISABLED'
          ? 503
          : error.code === 'LOCKED'
            ? 409
            : 400
    return NextResponse.json({ error: error.publicMessage, code: error.code }, { status })
  }
  console.error('Guild reset API failed:', error)
  return NextResponse.json(
    { error: 'Guild reset request could not be processed', code: 'INTERNAL_ERROR' },
    { status: 500 },
  )
}

export function assertResetMutation(request: Request, maximumBytes = 16_384) {
  if (!isTrustedMutation(request) || !hasJsonBody(request, maximumBytes)) {
    throw new GuildResetError('INVALID_REQUEST', 'リクエストを確認できません。')
  }
}

export async function getResetApiContext(
  request: Request,
  guildId: string,
  {
    requireFeature = true,
    requireGuildEnabled = true,
    rateScope,
    rateLimit = 10,
    windowSeconds = 60,
  }: {
    requireFeature?: boolean
    requireGuildEnabled?: boolean
    rateScope: string
    rateLimit?: number
    windowSeconds?: number
  },
): Promise<ResetApiContext> {
  if (!isDiscordId(guildId)) {
    throw new GuildResetError('INVALID_GUILD_ID', 'Guild IDの形式が正しくありません。')
  }
  const config = getGuildResetConfig(process.env)
  if (requireFeature && !config.enabled) {
    throw new GuildResetError('FEATURE_DISABLED', 'Guild初期化機能は現在無効です。')
  }
  const access = await getDeveloperAccess(request)
  if (!access) throw new GuildResetError('DEVELOPER_FORBIDDEN', '開発者権限がありません。')
  if (
    await isRateLimited(request, {
      scope: rateScope,
      limit: rateLimit,
      windowSeconds,
      identity: access.userId,
      failClosed: true,
    })
  ) {
    throw new GuildResetError('RATE_LIMIT', 'リクエスト回数が多すぎます。少し待ってください。')
  }

  const result = await pool.query<{
    name: string
    ownerId: string | null
    isConnected: boolean
    blocked: boolean
    resetEnabled: boolean | null
    allowedAdminIds: unknown
  }>(
    `
      SELECT
        registry."name",
        registry."ownerId",
        registry."isConnected",
        (blocklist."guildId" IS NOT NULL) AS "blocked",
        settings."enabled" AS "resetEnabled",
        settings."allowedAdminIds"
      FROM "bot_guild_registry" AS registry
      LEFT JOIN "bot_guild_blocklist" AS blocklist
        ON blocklist."guildId" = registry."guildId"
      LEFT JOIN "guild_reset_settings" AS settings
        ON settings."guildId" = registry."guildId"
      WHERE registry."guildId" = $1
      LIMIT 1
    `,
    [guildId],
  )
  const row = result.rows[0]
  if (!row || !row.isConnected) {
    throw new GuildResetError('GUILD_NOT_FOUND', '対象Guildを確認できません。')
  }
  if (row.blocked) {
    throw new GuildResetError('GUILD_BLOCKED', 'ブロック中のGuildでは実行できません。')
  }
  const allowedAdminIds = parseIdList(row.allowedAdminIds)
  if (row.ownerId !== access.discordUserId && !allowedAdminIds.includes(access.discordUserId)) {
    throw new GuildResetError(
      'GUILD_CONTROL_FORBIDDEN',
      '対象Guildの所有者または明示的に許可された管理者ではありません。',
    )
  }
  if (requireGuildEnabled && row.resetEnabled !== true) {
    throw new GuildResetError(
      'GUILD_RESET_DISABLED',
      '対象Guildでは初期化機能が有効化されていません。',
    )
  }
  return {
    access,
    guildId,
    registry: {
      name: row.name,
      ownerId: row.ownerId,
      isConnected: row.isConnected,
    },
    settings: {
      enabled: row.resetEnabled === true,
      allowedAdminIds,
    },
  }
}

export async function enqueuePlanRequest(
  context: ResetApiContext,
  body: Record<string, unknown>,
) {
  const options = normalizeResetOptions({
    mode: body.mode,
    dryRun: body.dryRun,
    deleteChannels: body.deleteChannels,
    deleteRoles: body.deleteRoles,
    resetSettings: body.resetSettings,
    keepChannelIds: body.keepChannelIds,
    keepRoleIds: body.keepRoleIds,
    createDefaultChannels: body.createDefaultChannels,
    reason: body.reason,
  })
  const requestId = randomUUID()
  await pool.query(
    `
      INSERT INTO "guild_reset_request" (
        "id", "action", "guildId", "developerId", "developerName",
        "payload", "status", "createdAt"
      )
      VALUES ($1, 'plan', $2, $3, $4, $5::jsonb, 'queued', now())
    `,
    [
      requestId,
      context.guildId,
      context.access.discordUserId,
      context.access.displayName,
      JSON.stringify(options),
    ],
  )
  return { requestId, status: 'queued' }
}

export async function issueResetCode(
  context: ResetApiContext,
  planId: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(planId)) {
    throw new GuildResetError('PLAN_NOT_FOUND', 'Planが存在しません。')
  }
  const plan = await pool.query<{
    id: string
    guildId: string
    developerId: string
    status: string
    expiresAt: Date
    usedAt: Date | null
  }>(
    `
      SELECT "id", "guildId", "developerId", "status", "expiresAt", "usedAt"
      FROM "guild_reset_plan"
      WHERE "id" = $1
      LIMIT 1
    `,
    [planId],
  )
  const row = plan.rows[0]
  if (!row) throw new GuildResetError('PLAN_NOT_FOUND', 'Planが存在しません。')
  if (row.guildId !== context.guildId) {
    throw new GuildResetError('PLAN_GUILD_MISMATCH', 'PlanとGuildが一致しません。')
  }
  if (row.developerId !== context.access.discordUserId) {
    throw new GuildResetError('PLAN_OWNER_MISMATCH', 'Plan作成者と実行者が一致しません。')
  }
  if (row.status !== 'active' || row.usedAt) {
    throw new GuildResetError('PLAN_ALREADY_USED', 'このPlanはすでに使用済みです。')
  }
  if (isExpired(row.expiresAt)) {
    throw new GuildResetError('PLAN_EXPIRED', 'Planの有効期限が切れています。')
  }
  const secret = getConfirmationSecret(process.env)
  if (!secret) {
    throw new GuildResetError(
      'CONFIRMATION_SECRET_MISSING',
      '確認コード用の署名鍵が設定されていません。',
    )
  }
  const code = generateConfirmationCode()
  const confirmationId = randomUUID()
  const config = getGuildResetConfig(process.env)
  const expiresAt = new Date(Date.now() + config.codeExpiresMinutes * 60_000)
  const codeHash = hashConfirmationCode({
    code,
    planId,
    guildId: context.guildId,
    developerId: context.access.discordUserId,
    secret,
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `
        UPDATE "guild_reset_confirmation"
        SET "usedAt" = now()
        WHERE "planId" = $1 AND "usedAt" IS NULL
      `,
      [planId],
    )
    await client.query(
      `
        INSERT INTO "guild_reset_confirmation" (
          "id", "planId", "guildId", "developerId", "codeHash",
          "expiresAt", "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, now())
      `,
      [
        confirmationId,
        planId,
        context.guildId,
        context.access.discordUserId,
        codeHash,
        expiresAt,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return { confirmationId, code, expiresAt: expiresAt.toISOString() }
}

export async function enqueueConfirmedRequest(
  context: ResetApiContext,
  body: Record<string, unknown>,
) {
  const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (body.acknowledge !== true) {
    throw new GuildResetError(
      'ACKNOWLEDGEMENT_REQUIRED',
      '明示的な警告確認が必要です。',
    )
  }
  if (!/^[0-9a-f-]{36}$/i.test(planId) || !/^\d{6,12}$/.test(code)) {
    throw new GuildResetError('CODE_INVALID', '確認コードが正しくありません。')
  }
  const secret = getConfirmationSecret(process.env)
  if (!secret) {
    throw new GuildResetError(
      'CONFIRMATION_SECRET_MISSING',
      '確認コード用の署名鍵が設定されていません。',
    )
  }
  const requestId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const planResult = await client.query<{
      id: string
      guildId: string
      developerId: string
      status: string
      expiresAt: Date
      usedAt: Date | null
    }>(
      `
        SELECT "id", "guildId", "developerId", "status", "expiresAt", "usedAt"
        FROM "guild_reset_plan"
        WHERE "id" = $1
        FOR UPDATE
      `,
      [planId],
    )
    const plan = planResult.rows[0]
    if (!plan) throw new GuildResetError('PLAN_NOT_FOUND', 'Planが存在しません。')
    if (plan.guildId !== context.guildId) {
      throw new GuildResetError('PLAN_GUILD_MISMATCH', 'PlanとGuildが一致しません。')
    }
    if (plan.developerId !== context.access.discordUserId) {
      throw new GuildResetError('PLAN_OWNER_MISMATCH', 'Plan作成者と実行者が一致しません。')
    }
    if (plan.status !== 'active' || plan.usedAt) {
      throw new GuildResetError('PLAN_ALREADY_USED', 'このPlanはすでに使用済みです。')
    }
    if (isExpired(plan.expiresAt)) {
      throw new GuildResetError('PLAN_EXPIRED', 'Planの有効期限が切れています。')
    }
    const confirmationResult = await client.query<{
      id: string
      codeHash: string
      expiresAt: Date
      usedAt: Date | null
    }>(
      `
        SELECT "id", "codeHash", "expiresAt", "usedAt"
        FROM "guild_reset_confirmation"
        WHERE
          "planId" = $1
          AND "guildId" = $2
          AND "developerId" = $3
          AND "usedAt" IS NULL
        ORDER BY "createdAt" DESC
        LIMIT 1
        FOR UPDATE
      `,
      [planId, context.guildId, context.access.discordUserId],
    )
    const confirmation = confirmationResult.rows[0]
    if (
      !confirmation ||
      isExpired(confirmation.expiresAt) ||
      !verifyConfirmationCode({
        code,
        codeHash: confirmation.codeHash,
        planId,
        guildId: context.guildId,
        developerId: context.access.discordUserId,
        secret,
      })
    ) {
      throw new GuildResetError(
        'CODE_INVALID',
        '確認コードが正しくないか、有効期限が切れています。',
      )
    }
    const consumed = await client.query(
      `
        UPDATE "guild_reset_confirmation"
        SET "usedAt" = now(), "usedByRequestId" = $2
        WHERE "id" = $1 AND "usedAt" IS NULL
        RETURNING "id"
      `,
      [confirmation.id, requestId],
    )
    if (consumed.rowCount !== 1) {
      throw new GuildResetError('CODE_ALREADY_USED', '確認コードはすでに使用済みです。')
    }
    await client.query(
      `
        INSERT INTO "guild_reset_request" (
          "id", "action", "guildId", "developerId", "developerName",
          "payload", "confirmationId", "status", "createdAt"
        )
        VALUES ($1, 'confirm', $2, $3, $4, $5::jsonb, $6, 'queued', now())
      `,
      [
        requestId,
        context.guildId,
        context.access.discordUserId,
        context.access.displayName,
        JSON.stringify({ planId }),
        confirmation.id,
      ],
    )
    await client.query('COMMIT')
    return { requestId, status: 'queued' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
