import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getSecurityApiContext, SecurityApiError, securityApiError } from '@/lib/nuke-protection-api'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
    await getSecurityApiContext(request, guildId, {
      requireFeature: false,
      requireConnected: false,
      rateScope: 'security-request-read',
      rateLimit: 120,
    })
    const result = await pool.query(`
      SELECT "id", "action", "status", "result", "errorCode", "errorMessage", "createdAt", "claimedAt", "completedAt"
      FROM "security_action_request" WHERE "id" = $1 AND "guildId" = $2 LIMIT 1
    `, [id, guildId])
    if (!result.rows[0]) throw new SecurityApiError('REQUEST_NOT_FOUND', '処理リクエストが見つかりません。', 404)
    return NextResponse.json({ request: result.rows[0] }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (error) {
    return securityApiError(error)
  }
}
