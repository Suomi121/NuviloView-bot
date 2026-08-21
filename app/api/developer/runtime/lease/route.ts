import { NextResponse } from 'next/server'
import { getDeveloperAccess } from '@/lib/developer-access'
import { pool } from '@/lib/db'
import { isRateLimited } from '@/lib/request-security'
import { evaluateRuntimeSnapshot, getRuntimeMonitorConfig } from '@/lib/runtime-monitor.mjs'

export const dynamic = 'force-dynamic'

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' }

export async function GET(request: Request) {
  const access = await getDeveloperAccess(request)
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (await isRateLimited(request, {
    scope: 'developer-runtime-lease-read',
    limit: 60,
    windowSeconds: 60,
    identity: access.userId,
    failClosed: true,
  })) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const config = getRuntimeMonitorConfig(process.env)
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const clock = await client.query<{ dbNow: Date }>('SELECT CURRENT_TIMESTAMP AS "dbNow"')
    const lease = await client.query<{
      serviceKey: string
      ownerInstanceId: string | null
      hostId: string | null
      fencingToken: string
      leaseExpiresAt: Date
      acquiredAt: Date | null
      renewedAt: Date | null
    }>(`
      SELECT "serviceKey", "ownerInstanceId", "hostId", "fencingToken", "leaseExpiresAt", "acquiredAt", "renewedAt"
      FROM "service_lease"
      WHERE "serviceKey" = $1
      LIMIT 1
    `, [config.serviceKey])
    const heartbeats = await client.query(`
      SELECT "instanceId", "serviceKey", "hostId", "fencingToken", "platform", "hostname", "pid",
             "startedAt", "lastHeartbeatAt", "status", "leaseState", "appVersion", "runtimeVersion",
             "commitSha", "guildCount", "stoppedAt"
      FROM "service_heartbeat"
      WHERE "serviceKey" = $1
        AND "lastHeartbeatAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
      ORDER BY "lastHeartbeatAt" DESC
      LIMIT 500
    `, [config.serviceKey])
    await client.query('COMMIT')

    const currentLease = lease.rows[0] ?? null
    const diagnostic = evaluateRuntimeSnapshot({
      dbNow: clock.rows[0]?.dbNow,
      lease: currentLease,
      heartbeats: heartbeats.rows,
      config,
    })
    return NextResponse.json({
      enabled: process.env.NUVILOVIEW_DISTRIBUTED_SINGLETON?.trim().toLowerCase() === 'true',
      dbNow: clock.rows[0]?.dbNow ?? null,
      lease: currentLease,
      diagnostic: {
        state: diagnostic.state,
        heartbeatAgeSeconds: diagnostic.heartbeatAgeSeconds,
        incidents: diagnostic.incidents,
      },
    }, { headers: noStoreHeaders })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Failed to load developer runtime lease:', error)
    return NextResponse.json({ error: 'Unable to load runtime status' }, { status: 500, headers: noStoreHeaders })
  } finally {
    client.release()
  }
}
