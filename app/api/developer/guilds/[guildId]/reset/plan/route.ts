import { NextResponse } from 'next/server'
import {
  assertResetMutation,
  enqueuePlanRequest,
  getResetApiContext,
  resetApiError,
} from '@/lib/guild-reset-api'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guildId: string }> },
) {
  try {
    assertResetMutation(request)
    const { guildId } = await params
    const context = await getResetApiContext(request, guildId, {
      rateScope: 'developer-guild-reset-plan',
      rateLimit: 6,
      windowSeconds: 60,
    })
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const queued = await enqueuePlanRequest(context, body as Record<string, unknown>)
    return NextResponse.json(queued, { status: 202 })
  } catch (error) {
    return resetApiError(error)
  }
}
