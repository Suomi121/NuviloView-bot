import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getSecurityApiContext, SecurityApiError, securityApiError } from '@/lib/nuke-protection-api'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
    const context = await getSecurityApiContext(request, guildId, {
      requireFeature: false,
      requireConnected: false,
      rateScope: 'security-incident-detail',
      rateLimit: 60,
    })
    const [incident, actions, audit] = await Promise.all([
      pool.query(`
        SELECT "id", "actorId", "actorType", "actorName", "incidentType", "severity", "riskScore", "riskExplanation", "actionTaken",
               "status", "firstDetectedAt", "lastDetectedAt", "actionCount", "trustedActor", "guildOwner",
               "selfActor", "containmentStatus", "resolution", "resolutionReason"
        FROM "security_incident" WHERE "id" = $1 AND "guildId" = $2 LIMIT 1
      `, [id, guildId]),
      pool.query(`
        SELECT "id", "auditLogEntryId", "actionType", "actorId", "targetId", "occurredAt",
               "riskWeight", "destructive", "metadata"
        FROM "security_incident_action" WHERE "incidentId" = $1 AND "guildId" = $2
        ORDER BY "occurredAt" ASC LIMIT 500
      `, [id, guildId]),
      pool.query(`
        SELECT "id", "eventType", "actorId", "actorName", "source", "details", "createdAt"
        FROM "security_audit_event" WHERE "incidentId" = $1 AND "guildId" = $2
        ORDER BY "createdAt" ASC LIMIT 500
      `, [id, guildId]),
    ])
    if (!incident.rows[0]) throw new SecurityApiError('INCIDENT_NOT_FOUND', 'Incidentが見つかりません。', 404)
    return NextResponse.json({
      incident: incident.rows[0],
      actions: actions.rows,
      audit: audit.rows,
      actorProfile: {
        id: incident.rows[0].actorId,
        nameAtDetection: incident.rows[0].actorName,
        actorTypeAtDetection: incident.rows[0].actorType,
        trustedAtDetection: incident.rows[0].trustedActor,
        guildOwnerAtDetection: incident.rows[0].guildOwner,
        currentMemberStatus: 'not_checked',
        currentRoles: [],
        note: 'Current member roles are not inferred from historical evidence.',
      },
      scopes: context.scopes,
    }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (error) {
    return securityApiError(error)
  }
}
