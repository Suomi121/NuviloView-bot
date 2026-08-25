import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { authStorage } from '@/lib/auth-storage'
import { hasJsonBody, isTrustedMutation } from '@/lib/request-security'

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

  const preference = await authStorage.settings.getPreference(session.user.id)
  return NextResponse.json({ timeZone: preference?.timeZone ?? fallbackTimeZone, language: preference?.language ?? fallbackLanguage })
}

export async function PATCH(request: Request) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!hasJsonBody(request, 2_048)) return NextResponse.json({ error: 'Invalid request format' }, { status: 415 })
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await authStorage.rateLimit.isLimited({ scope: 'preference-update', limit: 20, windowSeconds: 60, identity: session.user.id })) {
    return NextResponse.json({ error: '操作回数が多すぎます。' }, { status: 429 })
  }

  const body = await request.json().catch(() => null)
  if (!isValidTimeZone(body?.timeZone) || !isValidLanguage(body?.language)) {
    return NextResponse.json({ error: 'Invalid time zone' }, { status: 400 })
  }

  await authStorage.settings.upsertPreference(session.user.id, {
    timeZone: body.timeZone,
    language: body.language,
  })
  return NextResponse.json({ timeZone: body.timeZone, language: body.language })
}
