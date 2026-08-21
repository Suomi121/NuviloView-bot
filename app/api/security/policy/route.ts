import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { normalizeNukeProtectionPolicy, resolveNukeProtectionMode } from '@/lib/nuke-protection.mjs'
import {
  assertSecurityMutation,
  getSecurityApiContext,
  SecurityApiError,
  SECURITY_SCOPES,
  securityApiError,
} from '@/lib/nuke-protection-api'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const guildId = new URL(request.url).searchParams.get('guildId') ?? ''
    const context = await getSecurityApiContext(request, guildId, {
      requireFeature: false,
      requireConnected: false,
      rateScope: 'security-policy-read',
      rateLimit: 60,
    })
    const [policy, trusted] = await Promise.all([
      pool.query(`SELECT * FROM "security_policy" WHERE "guildId" = $1 LIMIT 1`, [guildId]),
      pool.query(`
        SELECT "actorId", "label", "actorType", "trustedBy", "createdAt"
        FROM "security_trusted_actor" WHERE "guildId" = $1 ORDER BY "createdAt" ASC
      `, [guildId]),
    ])
    const normalizedPolicy = normalizeNukeProtectionPolicy(policy.rows[0] ?? {})
    return NextResponse.json({
      policy: {
        ...normalizedPolicy,
        protectionStatus: policy.rows[0]?.protectionStatus ?? (context.featureEnabled ? 'Limited' : 'Disabled'),
        statusReason: policy.rows[0]?.statusReason ?? null,
        missingPermissions: Array.isArray(policy.rows[0]?.missingPermissions) ? policy.rows[0].missingPermissions : [],
      },
      trustedActors: trusted.rows,
      guildOwner: context.ownerId ? { actorId: context.ownerId, trustedAutomatically: true } : null,
      scopes: context.scopes,
      globalKillSwitchEnabled: context.featureEnabled,
      effectiveMode: resolveNukeProtectionMode({ globallyEnabled: context.featureEnabled, guildEnabled: normalizedPolicy.enabled, mode: normalizedPolicy.nukeProtectionMode }),
    }, { headers: { 'Cache-Control': 'no-store, private' } })
  } catch (error) {
    return securityApiError(error)
  }
}

export async function PUT(request: Request) {
  try {
    assertSecurityMutation(request, 32_768)
    const body = await request.json() as Record<string, unknown> & { guildId?: string }
    if ('nukeProtectionMode' in body && !['off', 'shadow', 'active'].includes(String(body.nukeProtectionMode))) {
      throw new SecurityApiError('INVALID_NUKE_MODE', 'Nuke Protection modeが正しくありません。')
    }
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.policy,
      requireFeature: false,
      rateScope: 'security-policy-write',
      rateLimit: 10,
    })
    const current = await pool.query(`SELECT * FROM "security_policy" WHERE "guildId" = $1 LIMIT 1`, [context.guildId])
    const currentPolicy = current.rows[0] ?? {}
    const normalized = normalizeNukeProtectionPolicy({
      ...currentPolicy,
      ...body,
      riskWeights: { ...(currentPolicy.riskWeights ?? {}), ...(typeof body.riskWeights === 'object' ? body.riskWeights : {}) },
      thresholds: { ...(currentPolicy.thresholds ?? {}), ...(typeof body.thresholds === 'object' ? body.thresholds : {}) },
      detectorThresholds: { ...(currentPolicy.detectorThresholds ?? {}), ...(typeof body.detectorThresholds === 'object' ? body.detectorThresholds : {}) },
    })
    await pool.query(`
      INSERT INTO "security_policy" (
        "guildId", "enabled", "nukeProtectionMode", "mode", "sensitivity", "alertEnabled", "alertChannelId",
        "manualContainment", "automaticContainment", "channelProtection", "roleProtection", "autoRestore",
        "webhookProtection", "botSpamProtection", "botDuplicateSpam", "botEveryoneSpam",
        "snapshotEnabled", "riskWeights", "thresholds", "detectorThresholds",
        "snapshotRetentionCount", "snapshotRetentionDays", "incidentRetentionDays", "updatedBy", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21, $22, $23, $24, now(), now())
      ON CONFLICT ("guildId") DO UPDATE SET
        "enabled" = EXCLUDED."enabled", "nukeProtectionMode" = EXCLUDED."nukeProtectionMode",
        "mode" = EXCLUDED."mode", "sensitivity" = EXCLUDED."sensitivity",
        "alertEnabled" = EXCLUDED."alertEnabled", "alertChannelId" = EXCLUDED."alertChannelId",
        "manualContainment" = EXCLUDED."manualContainment", "automaticContainment" = EXCLUDED."automaticContainment",
        "channelProtection" = EXCLUDED."channelProtection", "roleProtection" = EXCLUDED."roleProtection",
        "autoRestore" = EXCLUDED."autoRestore", "webhookProtection" = EXCLUDED."webhookProtection",
        "botSpamProtection" = EXCLUDED."botSpamProtection", "botDuplicateSpam" = EXCLUDED."botDuplicateSpam",
        "botEveryoneSpam" = EXCLUDED."botEveryoneSpam",
        "snapshotEnabled" = EXCLUDED."snapshotEnabled", "riskWeights" = EXCLUDED."riskWeights",
        "thresholds" = EXCLUDED."thresholds", "detectorThresholds" = EXCLUDED."detectorThresholds",
        "snapshotRetentionCount" = EXCLUDED."snapshotRetentionCount",
        "snapshotRetentionDays" = EXCLUDED."snapshotRetentionDays", "incidentRetentionDays" = EXCLUDED."incidentRetentionDays",
        "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = now()
    `, [
      context.guildId, normalized.enabled, normalized.nukeProtectionMode, normalized.mode, normalized.sensitivity,
      normalized.alertEnabled, normalized.alertChannelId, normalized.manualContainment,
      normalized.automaticContainment, normalized.channelProtection, normalized.roleProtection,
      normalized.autoRestore, normalized.webhookProtection, normalized.botSpamProtection,
      normalized.botDuplicateSpam, normalized.botEveryoneSpam, normalized.snapshotEnabled,
      JSON.stringify(normalized.riskWeights), JSON.stringify(normalized.thresholds), JSON.stringify(normalized.detectorThresholds),
      normalized.snapshotRetentionCount, normalized.snapshotRetentionDays, normalized.incidentRetentionDays,
      context.discordUserId,
    ])
    await pool.query(`
      INSERT INTO "security_audit_event" ("guildId", "eventType", "actorId", "actorName", "source", "details")
      VALUES ($1, 'PolicyUpdated', $2, $3, 'dashboard', $4::jsonb)
    `, [context.guildId, context.discordUserId, context.displayName, JSON.stringify({
      enabled: normalized.enabled,
      nukeProtectionMode: normalized.nukeProtectionMode,
      mode: normalized.mode,
      sensitivity: normalized.sensitivity,
      alertEnabled: normalized.alertEnabled,
      manualContainment: normalized.manualContainment,
      automaticContainment: normalized.automaticContainment,
      channelProtection: normalized.channelProtection,
      roleProtection: normalized.roleProtection,
      autoRestore: normalized.autoRestore,
      webhookProtection: normalized.webhookProtection,
      botSpamProtection: normalized.botSpamProtection,
      botDuplicateSpam: normalized.botDuplicateSpam,
      botEveryoneSpam: normalized.botEveryoneSpam,
      detectorThresholds: normalized.detectorThresholds,
      snapshotEnabled: normalized.snapshotEnabled,
    })])
    const previousMode = normalizeNukeProtectionPolicy(currentPolicy).nukeProtectionMode
    if (previousMode !== normalized.nukeProtectionMode) {
      const stateEvent = normalized.nukeProtectionMode === 'off'
        ? 'NUKE_PROTECTION_DISABLED'
        : normalized.nukeProtectionMode === 'shadow'
          ? 'NUKE_PROTECTION_SHADOW_ENABLED'
          : 'NUKE_PROTECTION_ACTIVE'
      await pool.query(`
        INSERT INTO "security_audit_event" ("guildId", "eventType", "actorId", "actorName", "source", "details")
        VALUES ($1, 'NUKE_PROTECTION_MODE_CHANGED', $2, $3, 'dashboard', $4::jsonb)
      `, [context.guildId, context.discordUserId, context.displayName, JSON.stringify({
        from: previousMode,
        to: normalized.nukeProtectionMode,
        stateEvent,
      })])
    }
    return NextResponse.json({
      policy: normalized,
      globalKillSwitchEnabled: context.featureEnabled,
      effectiveMode: resolveNukeProtectionMode({ globallyEnabled: context.featureEnabled, guildEnabled: normalized.enabled, mode: normalized.nukeProtectionMode }),
    })
  } catch (error) {
    return securityApiError(error)
  }
}
