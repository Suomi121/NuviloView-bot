import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { normalizeResolutionReason } from '@/lib/nuke-security-api-utils.mjs'
import {
  assertSecurityMutation,
  getSecurityApiContext,
  SecurityApiError,
  SECURITY_SCOPES,
  securityApiError,
} from '@/lib/nuke-protection-api'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSecurityMutation(request, 4_096)
    const { id } = await params
    const body = await request.json() as { guildId?: string; reason?: unknown }
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.policy,
      rateScope: 'security-false-positive',
      rateLimit: 20,
    })
    const reason = normalizeResolutionReason(body.reason)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const updated = await client.query(`
        UPDATE "security_incident" SET "status" = 'FalsePositive', "resolution" = 'false_positive',
          "resolutionReason" = $1, "updatedAt" = now()
        WHERE "id" = $2 AND "guildId" = $3 RETURNING "id"
      `, [reason, id, context.guildId])
      if (!updated.rows[0]) throw new SecurityApiError('INCIDENT_NOT_FOUND', 'Incidentが見つかりません。', 404)
      await client.query(`
        INSERT INTO "security_audit_event" ("guildId", "incidentId", "eventType", "actorId", "actorName", "source", "details")
        VALUES ($1, $2, 'IncidentFalsePositive', $3, $4, 'dashboard', $5::jsonb)
      `, [context.guildId, id, context.discordUserId, context.displayName, JSON.stringify({ reasonPresent: Boolean(reason) })])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return NextResponse.json({ status: 'FalsePositive' })
  } catch (error) {
    return securityApiError(error)
  }
}
