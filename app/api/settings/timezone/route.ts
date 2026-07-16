import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'

const fallbackTimeZone = 'Asia/Tokyo'
const fallbackLanguage = 'ja'

function isValidTimeZone(value: unknown): value is string {
  return typeof value === 'string' && Intl.supportedValuesOf('timeZone').includes(value)
}
function isValidLanguage(value: unknown): value is 'ja' | 'en' { return value === 'ja' || value === 'en' }

async function getSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  return session
}

export async function GET(request: Request) {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await pool.query<{ timeZone: string; language: 'ja' | 'en' }>(
    'SELECT "timeZone", "language" FROM "user_preference" WHERE "userId" = $1',
    [session.user.id],
  )
  return NextResponse.json({ timeZone: result.rows[0]?.timeZone ?? fallbackTimeZone, language: result.rows[0]?.language ?? fallbackLanguage })
}

export async function PATCH(request: Request) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!hasJsonBody(request, 2_048)) return NextResponse.json({ error: 'Invalid request format' }, { status: 415 })
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await isRateLimited(request, { scope: 'preference-update', limit: 20, windowSeconds: 60, identity: session.user.id, failClosed: true })) {
    return NextResponse.json({ error: '操作回数が多すぎます。' }, { status: 429 })
  }

  const body = await request.json().catch(() => null)
  if (!isValidTimeZone(body?.timeZone) || !isValidLanguage(body?.language)) {
    return NextResponse.json({ error: 'Invalid time zone' }, { status: 400 })
  }

  await pool.query(
    `INSERT INTO "user_preference" ("userId", "timeZone", "language", "updatedAt")
     VALUES ($1, $2, $3, now())
     ON CONFLICT ("userId")
     DO UPDATE SET "timeZone" = EXCLUDED."timeZone", "language" = EXCLUDED."language", "updatedAt" = now()`,
    [session.user.id, body.timeZone, body.language],
  )
  return NextResponse.json({ timeZone: body.timeZone, language: body.language })
}
