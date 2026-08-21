import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getSecurityApiContext, securityApiError } from '@/lib/nuke-protection-api'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const guildId = url.searchParams.get('guildId') ?? ''
    const status = url.searchParams.get('status')
    await getSecurityApiContext(request, guildId, {
      requireFeature: false,
      requireConnected: false,
      rateScope: 'security-incidents',
      rateLimit: 60,
    })
    const statuses = status && ['Open', 'Contained', 'Monitoring', 'Resolved', 'FalsePositive'].includes(status)
      ? [status]
      : ['Open', 'Contained', 'Monitoring', 'Resolved', 'FalsePositive']
    const result = await pool.query(`
      SELECT "id", "actorId", "actorType", "actorName", "incidentType", "severity", "riskScore", "riskExplanation", "actionTaken",
             "status", "firstDetectedAt", "lastDetectedAt", "actionCount", "trustedActor", "guildOwner",
             "selfActor", "containmentStatus", "resolutionReason"
      FROM "security_incident"
      WHERE "guildId" = $1 AND "status" = ANY($2::text[])
      ORDER BY "lastDetectedAt" DESC
      LIMIT 100
    `, [guildId, statuses])
    return NextResponse.json({ incidents: result.rows }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (error) {
    return securityApiError(error)
  }
}
