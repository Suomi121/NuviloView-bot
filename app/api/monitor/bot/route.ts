import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'

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
