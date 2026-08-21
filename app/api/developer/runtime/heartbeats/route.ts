import { NextResponse } from 'next/server'
import { getDeveloperAccess } from '@/lib/developer-access'
import { pool } from '@/lib/db'
import { isRateLimited } from '@/lib/request-security'
import { getRuntimeMonitorConfig } from '@/lib/runtime-monitor.mjs'

export const dynamic = 'force-dynamic'

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' }

export async function GET(request: Request) {
  const access = await getDeveloperAccess(request)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, {
    scope: 'developer-runtime-heartbeats-read',
    limit: 60,
    windowSeconds: 60,
    identity: access.userId,
    failClosed: true,
  })) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const config = getRuntimeMonitorConfig(process.env)
  const requestedLimit = Number(new URL(request.url).searchParams.get('limit'))
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100
  try {
    const result = await pool.query(`
      SELECT "instanceId", "serviceKey", "hostId", "fencingToken", "platform", "hostname", "pid",
             "startedAt", "lastHeartbeatAt", "status", "leaseState", "appVersion", "runtimeVersion",
             "commitSha", "guildCount", "stoppedAt"
      FROM "service_heartbeat"
      WHERE "serviceKey" = $1
      ORDER BY "lastHeartbeatAt" DESC
      LIMIT $2
    `, [config.serviceKey, limit])
    return NextResponse.json({ heartbeats: result.rows }, { headers: noStoreHeaders })
  } catch (error) {
    console.error('Failed to load developer runtime heartbeats:', error)
    return NextResponse.json({ error: 'Unable to load runtime heartbeats' }, { status: 500, headers: noStoreHeaders })
  }
}
