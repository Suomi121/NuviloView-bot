import 'server-only'

import { createHash } from 'node:crypto'
import { pool } from '@/lib/db'

function normalizeOrigin(value: string | undefined) {
  if (!value) return null
  try {
    return new URL(value.startsWith('http') ? value : `https://${value}`).origin
  } catch {
    return null
  }
}

const trustedOrigins = new Set([
  normalizeOrigin(process.env.BETTER_AUTH_URL),
  ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',').map((origin) => normalizeOrigin(origin.trim())),
  ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),
].filter((origin): origin is string => Boolean(origin)))

export function isTrustedMutation(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return true
  return trustedOrigins.has(origin)
}

export function hasJsonBody(request: Request, maximumBytes: number) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) return false

  const rawContentLength = request.headers.get('content-length')
  if (!rawContentLength) return false
  const contentLength = Number(rawContentLength)
  return Number.isFinite(contentLength) && contentLength >= 0 && contentLength <= maximumBytes
}

function requestIdentity(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwardedFor || request.headers.get('x-real-ip') || 'unknown-client'
}

export async function isRateLimited(request: Request, options: {
  scope: string
  limit: number
  windowSeconds: number
  identity?: string
  failClosed?: boolean
}) {
  const identity = options.identity ?? requestIdentity(request)
  const secret = process.env.BETTER_AUTH_SECRET ?? 'local-development-rate-limit-key'
  const identityHash = createHash('sha256').update(`${secret}:${identity}`).digest('hex')
  const bucketMilliseconds = options.windowSeconds * 1000
  const bucketStart = new Date(Math.floor(Date.now() / bucketMilliseconds) * bucketMilliseconds)
  const key = `${options.scope}:${identityHash}`

  try {
    const result = await pool.query<{ count: number }>(`
      INSERT INTO "api_rate_limit" ("key", "bucketStart", "count")
      VALUES ($1, $2, 1)
      ON CONFLICT ("key", "bucketStart") DO UPDATE
      SET "count" = "api_rate_limit"."count" + 1
      WHERE "api_rate_limit"."count" < $3
      RETURNING "count"
    `, [key, bucketStart, options.limit])

    if (Math.random() < 0.01) {
      void pool.query('DELETE FROM "api_rate_limit" WHERE "bucketStart" < now() - interval \'7 days\'')
    }
    return result.rowCount === 0
  } catch (error) {
    console.error('Rate-limit check failed:', error)
    // State-changing endpoints should not become an abuse vector during a database outage.
    return options.failClosed ?? false
  }
}
