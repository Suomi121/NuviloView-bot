import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import {
  assertSecurityMutation,
  enqueueSecurityAction,
  getSecurityApiContext,
  SecurityApiError,
  SECURITY_SCOPES,
  securityApiError,
} from '@/lib/nuke-protection-api'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSecurityMutation(request, 4_096)
    const { id } = await params
    const body = await request.json() as { guildId?: string; confirmation?: boolean }
    if (body.confirmation !== true) throw new SecurityApiError('CONFIRMATION_REQUIRED', '確認チェックが必要です。')
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.contain,
      rateScope: 'security-contain',
      rateLimit: 5,
    })
    const result = await pool.query(`
      SELECT incident."id", incident."guildOwner", incident."trustedActor", incident."selfActor",
             incident."containmentStatus", policy."nukeProtectionMode", policy."mode", policy."manualContainment"
      FROM "security_incident" incident
      LEFT JOIN "security_policy" policy ON policy."guildId" = incident."guildId"
      WHERE incident."id" = $1 AND incident."guildId" = $2 LIMIT 1
    `, [id, context.guildId])
    const incident = result.rows[0]
    if (!incident) throw new SecurityApiError('INCIDENT_NOT_FOUND', 'Incidentが見つかりません。', 404)
    if (incident.guildOwner || incident.trustedActor || incident.selfActor) {
      throw new SecurityApiError('CONTAINMENT_PROTECTED', '保護対象のActorは封じ込めできません。', 409)
    }
    if ((incident.nukeProtectionMode ?? 'shadow') !== 'active') {
      throw new SecurityApiError('SHADOW_MODE', 'Shadow Modeでは封じ込めを実行できません。', 409)
    }
    if ((incident.mode ?? 'shadow') === 'shadow' || incident.mode === 'monitor') {
      throw new SecurityApiError('RESPONSE_MODE', '現在の応答方針では封じ込めを実行できません。', 409)
    }
    if (incident.manualContainment === false) {
      throw new SecurityApiError('CONTAINMENT_DISABLED', '手動封じ込めは無効です。', 409)
    }
    const requestId = await enqueueSecurityAction(context, 'contain', { incidentId: id })
    return NextResponse.json({ requestId, status: 'queued' }, { status: 202 })
  } catch (error) {
    return securityApiError(error)
  }
}
