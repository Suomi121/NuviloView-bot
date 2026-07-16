import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

type AuditEvent = {
  guildId: string
  action: string
  reason: string | null
  performedBy: string
  performedByName: string | null
  source: string
  createdAt: string
  previousHash: string
}

function signingKey() {
  return process.env.AUDIT_LOG_SIGNING_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim() || null
}

export function createAuditLogHash(event: AuditEvent) {
  const key = signingKey()
  if (!key) throw new Error('Audit log signing is not configured')
  return createHmac('sha256', key).update([
    'nuviloview-audit-v1', event.previousHash, event.guildId, event.action,
    event.reason ?? '', event.performedBy, event.performedByName ?? '', event.source, event.createdAt,
  ].join('\n')).digest('hex')
}

export function verifyAuditLogHash(event: AuditEvent & { entryHash: string | null }) {
  if (!event.entryHash) return null
  const expected = createAuditLogHash(event)
  const actual = Buffer.from(event.entryHash, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer)
}
