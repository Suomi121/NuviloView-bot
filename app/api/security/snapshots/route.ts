import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import {
  assertSecurityMutation,
  enqueueSecurityAction,
  getSecurityApiContext,
  SECURITY_SCOPES,
  securityApiError,
} from '@/lib/nuke-protection-api'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
    await getSecurityApiContext(request, guildId, {
      requireFeature: false,
      requireConnected: false,
      rateScope: 'security-snapshots-read',
      rateLimit: 60,
    })
    const result = await pool.query(`
      SELECT "id", "source", "schemaVersion", "checksum", "createdBy", "createdAt",
             jsonb_array_length(COALESCE("data"->'channels', '[]'::jsonb))::int AS "channelCount",
             jsonb_array_length(COALESCE("data"->'roles', '[]'::jsonb))::int AS "roleCount"
      FROM "security_snapshot" WHERE "guildId" = $1
      ORDER BY "createdAt" DESC LIMIT 30
    `, [guildId])
    return NextResponse.json({ snapshots: result.rows }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (error) {
    return securityApiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertSecurityMutation(request, 4_096)
    const body = await request.json() as { guildId?: string }
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.restore,
      rateScope: 'security-snapshot-create',
      rateLimit: 5,
    })
    const requestId = await enqueueSecurityAction(context, 'snapshot')
    return NextResponse.json({ requestId, status: 'queued' }, { status: 202 })
  } catch (error) {
    return securityApiError(error)
  }
}
