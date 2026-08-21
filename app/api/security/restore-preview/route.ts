import { NextResponse } from 'next/server'
import {
  assertSecurityMutation,
  enqueueSecurityAction,
  getSecurityApiContext,
  SECURITY_SCOPES,
  securityApiError,
} from '@/lib/nuke-protection-api'

export async function POST(request: Request) {
  try {
    assertSecurityMutation(request, 4_096)
    const body = await request.json() as { guildId?: string; snapshotId?: string }
    const context = await getSecurityApiContext(request, body.guildId ?? '', {
      requiredScope: SECURITY_SCOPES.restore,
      rateScope: 'security-restore-preview',
      rateLimit: 10,
    })
    const requestId = await enqueueSecurityAction(context, 'restore_preview', {
      payload: { snapshotId: typeof body.snapshotId === 'string' ? body.snapshotId.slice(0, 100) : null },
    })
    return NextResponse.json({ requestId, status: 'queued' }, { status: 202 })
  } catch (error) {
    return securityApiError(error)
  }
}
