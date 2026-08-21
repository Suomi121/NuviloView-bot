import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getResetApiContext, resetApiError } from '@/lib/guild-reset-api'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ guildId: string }> },
) {
  try {
    const { guildId } = await params
    const includeItems = new URL(request.url).searchParams.get('includeItems') !== 'false'
    const context = await getResetApiContext(request, guildId, {
      requireGuildEnabled: false,
      rateScope: 'developer-guild-reset-history',
      rateLimit: 60,
      windowSeconds: 60,
    })
    const [settings, plans, executions, requests] = await Promise.all([
      pool.query(
        `
          SELECT
            "guildId", "enabled", "protectedChannelIds", "protectedRoleIds",
            "resetLogChannelId", "backupChannelId", "allowedAdminIds",
            "maxChannelDeletes", "maxRoleDeletes", "maxTotalOperations",
            "guildCooldownHours", "developerCooldownMinutes", "defaultMode",
            "createdAt", "updatedAt"
          FROM "guild_reset_settings"
          WHERE "guildId" = $1
          LIMIT 1
        `,
        [guildId],
      ),
      pool.query(
        `
          SELECT
            "id", "mode", "dryRun", "targetSummary", "status",
            "expiresAt", "createdAt", "usedAt", "developerId", "developerName"
          FROM "guild_reset_plan"
          WHERE "guildId" = $1
          ORDER BY "createdAt" DESC
          LIMIT 30
        `,
        [guildId],
      ),
      pool.query(
        `
          SELECT
            "id", "planId", "developerId", "developerName", "mode", "dryRun",
            "reason", "source", "status", "requestedCount",
            "successCount", "failedCount", "skippedCount", "operationStarted",
            "beforeSummary", "afterSummary", "errorSummary",
            "startedAt", "finishedAt", "createdAt"
          FROM "guild_reset_execution"
          WHERE "guildId" = $1
          ORDER BY "createdAt" DESC
          LIMIT 30
        `,
        [guildId],
      ),
      pool.query(
        `
          SELECT
            "id", "action", "status", "result", "errorCode", "errorMessage",
            "createdAt", "claimedAt", "completedAt"
          FROM "guild_reset_request"
          WHERE "guildId" = $1
          ORDER BY "createdAt" DESC
          LIMIT 30
        `,
        [guildId],
      ),
    ])
    const executionIds = includeItems ? executions.rows.map((row) => row.id) : []
    const items = executionIds.length
      ? await pool.query(
          `
            SELECT
              "id", "executionId", "targetType", "targetId", "targetName",
              "action", "status", "errorCode", "errorMessage", "createdAt"
            FROM "guild_reset_execution_item"
            WHERE "executionId" = ANY($1::text[])
            ORDER BY "id" ASC
          `,
          [executionIds],
        )
      : { rows: [] }
    return NextResponse.json(
      {
        guild: { guildId, ...context.registry },
        settings: settings.rows[0] ?? null,
        plans: plans.rows,
        executions: includeItems
          ? executions.rows.map((execution) => ({
              ...execution,
              items: items.rows.filter((item) => item.executionId === execution.id),
            }))
          : executions.rows,
        requests: requests.rows,
      },
      { headers: { 'Cache-Control': 'no-store, private' } },
    )
  } catch (error) {
    return resetApiError(error)
  }
}
