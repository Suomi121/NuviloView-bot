import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { isRateLimited, isTrustedMutation } from '@/lib/request-security'
import { getManagedGuilds } from '@/lib/discord'
import { applicationHaEnabled, getApplicationStore, applicationError } from '@/lib/multi-db/application-web'
import { dismissApplicationNotification } from '@/lib/multi-db/notifications.mjs'

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isTrustedMutation(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await isRateLimited(request, { scope: 'notification-delete', limit: 30, windowSeconds: 60, identity: session.user.id, failClosed: true })) {
    return NextResponse.json({ error: '操作回数が多すぎます。' }, { status: 429 })
  }

  const { id } = await params
  if (applicationHaEnabled()) {
    try {
      const body = await request.json().catch(() => null)
      const guilds = await getManagedGuilds(session.user.id)
      if (!guilds.some(g => g.id === body?.guildId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      const store = await getApplicationStore(session.user.id, [body.guildId])
      await dismissApplicationNotification({ store: store!, userId: session.user.id, guildId: body.guildId, id, token: body.token, requestId: body.requestId })
      return NextResponse.json({ ok: true })
    } catch (error) { const failure = applicationError(error); return NextResponse.json(failure.body, { status: failure.status }) }
  }
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Invalid notification id' }, { status: 400 })

  await pool.query(`
    UPDATE "user_notification" SET "deletedAt" = now()
    WHERE "id" = $1 AND "userId" = $2 AND "deletedAt" IS NULL
  `, [Number(id), session.user.id])
  return NextResponse.json({ ok: true })
}
