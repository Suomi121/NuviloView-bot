import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getSecurityApiContext, securityApiError } from '@/lib/nuke-protection-api'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
    const context = await getSecurityApiContext(request, guildId, {
      requireFeature: false,
      requireConnected: false,
      rateScope: 'security-overview',
      rateLimit: 60,
    })
    const result = await pool.query(`
      SELECT
        policy."enabled", policy."mode", policy."protectionStatus", policy."statusReason",
        policy."lastDiagnosticAt", policy."lastIncidentAt", policy."missingPermissions",
        COALESCE((SELECT count(*)::int FROM "security_incident" incident
          WHERE incident."guildId" = $1 AND incident."status" IN ('Open', 'Contained', 'Monitoring')), 0) AS "openIncidents",
        COALESCE((SELECT count(*)::int FROM "security_incident" incident
          WHERE incident."guildId" = $1 AND incident."lastDetectedAt" >= now() - interval '24 hours'), 0) AS "last24HoursIncidents",
        COALESCE((SELECT count(*)::int FROM "security_incident" incident
          WHERE incident."guildId" = $1 AND incident."lastDetectedAt" >= now() - interval '7 days'), 0) AS "last7DaysIncidents",
        COALESCE((SELECT count(*)::int FROM "security_incident" incident
          WHERE incident."guildId" = $1 AND incident."severity" = 'Critical'), 0) AS "criticalIncidents",
        COALESCE((SELECT count(*)::int FROM "security_incident_action" action
          WHERE action."guildId" = $1 AND action."occurredAt" >= now() - interval '24 hours'), 0) AS "last24HoursActions",
        COALESCE((SELECT max(incident."riskScore")::int FROM "security_incident" incident
          WHERE incident."guildId" = $1 AND incident."status" IN ('Open', 'Contained', 'Monitoring')), 0) AS "riskScore"
      FROM (SELECT $1::text AS "guildId") input
      LEFT JOIN "security_policy" policy ON policy."guildId" = input."guildId"
    `, [guildId])
    const row = result.rows[0] ?? {}
    return NextResponse.json({
      guild: { id: guildId, name: context.guildName, connected: context.connected },
      featureEnabled: context.featureEnabled,
      scopes: context.scopes,
      protection: {
        enabled: row.enabled ?? true,
        mode: row.mode ?? 'shadow',
        status: !context.connected ? 'Error' : context.featureEnabled ? (row.protectionStatus ?? 'Limited') : 'Disabled',
        reason: !context.connected ? 'Protection offline: Bot is no longer present in this Guild' : context.featureEnabled ? (row.statusReason ?? 'Bot diagnostics have not completed yet') : 'Feature flag is disabled',
        lastDiagnosticAt: row.lastDiagnosticAt ?? null,
        missingPermissions: Array.isArray(row.missingPermissions) ? row.missingPermissions : [],
      },
      riskScore: row.riskScore ?? 0,
      openIncidents: row.openIncidents ?? 0,
      last24HoursIncidents: row.last24HoursIncidents ?? 0,
      last7DaysIncidents: row.last7DaysIncidents ?? 0,
      criticalIncidents: row.criticalIncidents ?? 0,
      last24HoursActions: row.last24HoursActions ?? 0,
      lastIncidentAt: row.lastIncidentAt ?? null,
    }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (error) {
    return securityApiError(error)
  }
}
