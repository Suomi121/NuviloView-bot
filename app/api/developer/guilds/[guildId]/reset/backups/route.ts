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
    await getResetApiContext(request, guildId, {
      requireGuildEnabled: false,
      rateScope: 'developer-guild-reset-backups',
      rateLimit: 60,
      windowSeconds: 60,
    })
    const result = await pool.query(
      `
        SELECT
          "id", "executionId", "planId", "guildId", "fileName", "filePath",
          "fileSize", "checksum", "schemaVersion", "createdAt"
        FROM "guild_reset_backup"
        WHERE "guildId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 50
      `,
      [guildId],
    )
    return NextResponse.json(
      { backups: result.rows },
      { headers: { 'Cache-Control': 'no-store, private' } },
    )
  } catch (error) {
    return resetApiError(error)
  }
}
