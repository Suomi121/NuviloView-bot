import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import {
  assertResetMutation,
  getResetApiContext,
  resetApiError,
} from '@/lib/guild-reset-api'
import { isDiscordId, parseIdList } from '@/lib/guild-reset-utils.mjs'

export const dynamic = 'force-dynamic'

function optionalInteger(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : Number.NaN
}

function optionalDiscordId(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  return isDiscordId(value) ? value : undefined
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ guildId: string }> },
) {
  try {
    const { guildId } = await params
    await getResetApiContext(request, guildId, {
      requireGuildEnabled: false,
      rateScope: 'developer-guild-reset-settings-read',
      rateLimit: 60,
      windowSeconds: 60,
    })
    const result = await pool.query(
      'SELECT * FROM "guild_reset_settings" WHERE "guildId" = $1 LIMIT 1',
      [guildId],
    )
    return NextResponse.json(
      { settings: result.rows[0] ?? null },
      { headers: { 'Cache-Control': 'no-store, private' } },
    )
  } catch (error) {
    return resetApiError(error)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ guildId: string }> },
) {
  try {
    assertResetMutation(request)
    const { guildId } = await params
    const context = await getResetApiContext(request, guildId, {
      requireGuildEnabled: false,
      rateScope: 'developer-guild-reset-settings-write',
      rateLimit: 6,
      windowSeconds: 60,
    })
    if (context.registry.ownerId !== context.access.discordUserId) {
      return NextResponse.json(
        { error: '初期化設定を変更できるのはGuild所有者として登録された開発者だけです。' },
        { status: 403 },
      )
    }
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const mode =
      body.defaultMode === 'channels_only' ||
      body.defaultMode === 'channels_and_roles' ||
      body.defaultMode === 'settings_reset'
        ? body.defaultMode
        : 'channels_only'
    const resetLogChannelId = optionalDiscordId(body.resetLogChannelId)
    const backupChannelId = optionalDiscordId(body.backupChannelId)
    const maxChannelDeletes = optionalInteger(body.maxChannelDeletes, 0, 250)
    const maxRoleDeletes = optionalInteger(body.maxRoleDeletes, 0, 100)
    const maxTotalOperations = optionalInteger(body.maxTotalOperations, 1, 350)
    const guildCooldownHours = optionalInteger(body.guildCooldownHours, 0, 720)
    const developerCooldownMinutes = optionalInteger(
      body.developerCooldownMinutes,
      0,
      10_080,
    )
    if (
      resetLogChannelId === undefined ||
      backupChannelId === undefined ||
      [
        maxChannelDeletes,
        maxRoleDeletes,
        maxTotalOperations,
        guildCooldownHours,
        developerCooldownMinutes,
      ].some(Number.isNaN)
    ) {
      return NextResponse.json({ error: '設定値の形式が正しくありません。' }, { status: 400 })
    }
    const settings = {
      enabled: body.enabled === true,
      protectedChannelIds: parseIdList(body.protectedChannelIds),
      protectedRoleIds: parseIdList(body.protectedRoleIds),
      resetLogChannelId,
      backupChannelId,
      allowedAdminIds: parseIdList(body.allowedAdminIds),
      maxChannelDeletes,
      maxRoleDeletes,
      maxTotalOperations,
      guildCooldownHours,
      developerCooldownMinutes,
      defaultMode: mode,
    }
    const result = await pool.query(
      `
        INSERT INTO "guild_reset_settings" (
          "guildId", "enabled", "protectedChannelIds", "protectedRoleIds",
          "resetLogChannelId", "backupChannelId", "allowedAdminIds",
          "maxChannelDeletes", "maxRoleDeletes", "maxTotalOperations",
          "guildCooldownHours", "developerCooldownMinutes", "defaultMode",
          "createdAt", "updatedAt"
        )
        VALUES (
          $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb,
          $8, $9, $10, $11, $12, $13, now(), now()
        )
        ON CONFLICT ("guildId") DO UPDATE SET
          "enabled" = EXCLUDED."enabled",
          "protectedChannelIds" = EXCLUDED."protectedChannelIds",
          "protectedRoleIds" = EXCLUDED."protectedRoleIds",
          "resetLogChannelId" = EXCLUDED."resetLogChannelId",
          "backupChannelId" = EXCLUDED."backupChannelId",
          "allowedAdminIds" = EXCLUDED."allowedAdminIds",
          "maxChannelDeletes" = EXCLUDED."maxChannelDeletes",
          "maxRoleDeletes" = EXCLUDED."maxRoleDeletes",
          "maxTotalOperations" = EXCLUDED."maxTotalOperations",
          "guildCooldownHours" = EXCLUDED."guildCooldownHours",
          "developerCooldownMinutes" = EXCLUDED."developerCooldownMinutes",
          "defaultMode" = EXCLUDED."defaultMode",
          "updatedAt" = now()
        RETURNING *
      `,
      [
        guildId,
        settings.enabled,
        JSON.stringify(settings.protectedChannelIds),
        JSON.stringify(settings.protectedRoleIds),
        settings.resetLogChannelId,
        settings.backupChannelId,
        JSON.stringify(settings.allowedAdminIds),
        settings.maxChannelDeletes,
        settings.maxRoleDeletes,
        settings.maxTotalOperations,
        settings.guildCooldownHours,
        settings.developerCooldownMinutes,
        settings.defaultMode,
      ],
    )
    return NextResponse.json({ settings: result.rows[0] })
  } catch (error) {
    return resetApiError(error)
  }
}
