import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { normalizeTrustedActorInput } from '@/lib/nuke-security-api-utils.mjs'
import {
  assertSecurityMutation,
  getSecurityApiContext,
  SecurityApiError,
  SECURITY_SCOPES,
  securityApiError,
} from '@/lib/nuke-protection-api'

export async function POST(request: Request) {
  try {
    assertSecurityMutation(request, 4_096)
    const body = await request.json() as Record<string, unknown> & { guildId?: string }
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.policy,
      rateScope: 'security-trusted-write',
      rateLimit: 15,
    })
    const actor = normalizeTrustedActorInput(body)
    if (!actor) throw new SecurityApiError('INVALID_ACTOR', 'Actor IDの形式が正しくありません。')
    await pool.query(`
      INSERT INTO "security_trusted_actor" ("guildId", "actorId", "label", "actorType", "trustedBy", "createdAt")
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT ("guildId", "actorId") DO UPDATE SET
        "label" = EXCLUDED."label", "actorType" = EXCLUDED."actorType", "trustedBy" = EXCLUDED."trustedBy"
    `, [context.guildId, actor.actorId, actor.label, actor.actorType, context.discordUserId])
    await pool.query(`
      INSERT INTO "security_audit_event" ("guildId", "eventType", "actorId", "actorName", "source", "details")
      VALUES ($1, 'ActorTrusted', $2, $3, 'dashboard', $4::jsonb)
    `, [context.guildId, context.discordUserId, context.displayName, JSON.stringify({ trustedActorId: actor.actorId, label: actor.label })])
    return NextResponse.json({ trustedActor: actor })
  } catch (error) {
    return securityApiError(error)
  }
}
export async function DELETE(request: Request) {
  try {
    assertSecurityMutation(request, 4_096)
    const body = await request.json() as { guildId?: string; actorId?: string }
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.policy,
      rateScope: 'security-trusted-delete',
      rateLimit: 15,
    })
    const actor = normalizeTrustedActorInput(body)
    if (!actor) throw new SecurityApiError('INVALID_ACTOR', 'Actor IDの形式が正しくありません。')
    await pool.query(`DELETE FROM "security_trusted_actor" WHERE "guildId" = $1 AND "actorId" = $2`, [context.guildId, actor.actorId])
    await pool.query(`
      INSERT INTO "security_audit_event" ("guildId", "eventType", "actorId", "actorName", "source", "details")
      VALUES ($1, 'ActorUntrusted', $2, $3, 'dashboard', $4::jsonb)
    `, [context.guildId, context.discordUserId, context.displayName, JSON.stringify({ trustedActorId: actor.actorId })])
    return NextResponse.json({ removed: true })
  } catch (error) {
    return securityApiError(error)
  }
}
