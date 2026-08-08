import { NextResponse } from 'next/server'
import {
  assertResetMutation,
  getResetApiContext,
  issueResetCode,
  resetApiError,
} from '@/lib/guild-reset-api'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guildId: string }> },
) {
  try {
    assertResetMutation(request, 4_096)
    const { guildId } = await params
    const context = await getResetApiContext(request, guildId, {
      rateScope: 'developer-guild-reset-code',
      rateLimit: 4,
      windowSeconds: 60,
    })
    const body = await request.json().catch(() => null)
    const planId = typeof body?.planId === 'string' ? body.planId.trim() : ''
    const issued = await issueResetCode(context, planId)
    // The plaintext code exists only in this authenticated response.
    return NextResponse.json(issued, {
      headers: { 'Cache-Control': 'no-store, private' },
    })
  } catch (error) {
    return resetApiError(error)
  }
}
