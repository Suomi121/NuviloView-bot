import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { evaluateRuntimeSnapshot, getRuntimeMonitorConfig } from '@/lib/runtime-monitor.mjs'

export const dynamic = 'force-dynamic'

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' }

function hasValidToken(request: Request) {
  const expected = process.env.BOT_MONITOR_TOKEN
  const supplied = new URL(request.url).searchParams.get('token')
  if (!expected || !supplied) return false

  const expectedBuffer = Buffer.from(expected)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function maxHeartbeatAgeMilliseconds() {
  const configured = Number(process.env.BOT_HEARTBEAT_MAX_AGE_SECONDS)
  const seconds = Number.isFinite(configured) ? Math.min(Math.max(configured, 60), 3600) : 180
  return seconds * 1000
}

// Intended for an external monitor such as UptimeRobot. It never reveals
// Bot, server, database, or Discord account details to callers.
export async function GET(request: Request) {
  if (!hasValidToken(request)) {
    return new NextResponse('Not Found', { status: 404, headers: noStoreHeaders })
  }

  try {
    if (process.env.NUVILOVIEW_DISTRIBUTED_SINGLETON?.trim().toLowerCase() === 'true') {
      const config = getRuntimeMonitorConfig(process.env)
      const client = await pool.connect()
      try {
        await client.query('BEGIN READ ONLY')
        const clock = await client.query<{ dbNow: Date }>('SELECT CURRENT_TIMESTAMP AS "dbNow"')
        const lease = await client.query(`
          SELECT "serviceKey", "ownerInstanceId", "hostId", "fencingToken", "leaseExpiresAt", "acquiredAt", "renewedAt"
          FROM "service_lease"
          WHERE "serviceKey" = $1
          LIMIT 1
        `, [config.serviceKey])
        const heartbeats = await client.query(`
          SELECT "instanceId", "hostId", "fencingToken", "startedAt", "lastHeartbeatAt", "status", "leaseState"
          FROM "service_heartbeat"
          WHERE "serviceKey" = $1
            AND "lastHeartbeatAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
          ORDER BY "lastHeartbeatAt" DESC
          LIMIT 500
        `, [config.serviceKey])
        await client.query('COMMIT')
        const result = evaluateRuntimeSnapshot({
          dbNow: clock.rows[0]?.dbNow,
          lease: lease.rows[0] ?? null,
          heartbeats: heartbeats.rows,
          config,
        })
        const isAvailable = result.state === 'Healthy' || result.state === 'Warning'
        return NextResponse.json(
          { status: isAvailable ? 'ok' : 'down' },
          { status: isAvailable ? 200 : 503, headers: noStoreHeaders },
        )
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }

    const result = await pool.query<{ lastSeenAt: Date; stoppedAt: Date | null }>(`
      SELECT "lastSeenAt", "stoppedAt"
      FROM "bot_heartbeat"
      WHERE "id" = 'primary'
      LIMIT 1
    `)
    const heartbeat = result.rows[0]
    const lastSeenAt = heartbeat?.lastSeenAt ? new Date(heartbeat.lastSeenAt).getTime() : 0
    const isFresh = lastSeenAt > 0 && Date.now() - lastSeenAt <= maxHeartbeatAgeMilliseconds()
    const isHealthy = Boolean(heartbeat) && !heartbeat.stoppedAt && isFresh

    return NextResponse.json(
      { status: isHealthy ? 'ok' : 'down' },
      { status: isHealthy ? 200 : 503, headers: noStoreHeaders },
    )
  } catch (error) {
    console.error('Bot monitor health check failed:', error)
    return NextResponse.json({ status: 'down' }, { status: 503, headers: noStoreHeaders })
  }
}
