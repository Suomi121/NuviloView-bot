import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { hasJsonBody, isRateLimited, isTrustedMutation } from '@/lib/request-security'

const SUPPORT_RECIPIENT = 'nuviloview00a@gmail.com'
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function formatSupportEmail({ name, email, message }: { name: string; email: string; message: string }) {
  return [
    'NuviloView:OEM に新しいお問い合わせが届きました。',
    '',
    `お名前: ${name}`,
    `メールアドレス: ${email}`,
    '',
    'お問い合わせ内容:',
    message,
  ].join('\n')
}

export async function POST(request: Request) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!hasJsonBody(request, 16_384)) return NextResponse.json({ error: 'Invalid request format' }, { status: 415 })
  if (await isRateLimited(request, { scope: 'support', limit: 3, windowSeconds: 15 * 60, failClosed: true })) {
    return NextResponse.json({ error: 'しばらく待ってから再度お試しください。' }, { status: 429 })
  }
  const body = await request.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!name || !email || !emailPattern.test(email) || !message || name.length > 100 || email.length > 254 || message.length > 5000) {
    return NextResponse.json({ error: '入力内容を確認してください。' }, { status: 400 })
  }
  const session = await auth.api.getSession({ headers: request.headers })
  await pool.query(
    `INSERT INTO "support_request" ("userId", "name", "email", "message") VALUES ($1, $2, $3, $4)`,
    [session?.user?.id ?? null, name, email, message],
  )

  const resendApiKey = process.env.RESEND_API_KEY
  const sender = process.env.SUPPORT_FROM_EMAIL
  if (!resendApiKey || !sender) {
    console.error('Support email was not sent: RESEND_API_KEY or SUPPORT_FROM_EMAIL is missing.')
  } else {
    try {
      const emailResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'NuviloView-OEM-Support/1.0',
        },
        body: JSON.stringify({
          from: sender,
          to: [SUPPORT_RECIPIENT],
          reply_to: email,
          subject: `【NuviloView:OEM】お問い合わせ: ${name}`,
          text: formatSupportEmail({ name, email, message }),
        }),
      })
      if (!emailResponse.ok) console.error('Support email delivery failed:', emailResponse.status, await emailResponse.text())
    } catch (error) {
      console.error('Support email delivery failed:', error)
    }
  }

  return NextResponse.json({ ok: true })
}
