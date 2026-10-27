import { NextResponse } from 'next/server'
import { getDeveloperAccess } from '@/lib/developer-access'
import { getSecurityCoordinator } from '@/lib/multi-db/web-runtime'
import { withWebReadRouter } from '@/lib/web-analytics-read'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const access = await getDeveloperAccess(request)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const runtime = await getSecurityCoordinator()
    if (!runtime) return NextResponse.json({ state: 'not_configured' }, { status: 503 })
    const controlId = process.env.SECURITY_COORDINATOR_RECOVERY_CONTROL_ID
    if (!controlId) return NextResponse.json({ state: 'not_configured' }, { status: 503 })
    await runtime.coordinator.scoped('recovery').read(controlId)
    const sync = await withWebReadRouter(router => router.readSyncStatusSnapshot()).catch(() => null)
    return NextResponse.json({ state: sync?.available && sync.metadata.freshness === 'fresh' ? 'available' : 'degraded',
      quorum: runtime.coordinator.diagnostics(), syncRead: sync?.metadata ?? null,
      applicationMode: process.env.APPLICATION_DATA_MODE === 'quorum' ? 'quorum' : 'legacy',
      // Return only safe health fields, not arbitrary snapshot payload/errors.
      retry: sync?.snapshot?.payload?.cloudComplete ?? null,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return NextResponse.json({ state: 'unavailable', code: 'APP_NO_QUORUM' }, { status: 503 }) }
}
