import 'server-only'
import { getSecurityCoordinator } from './web-runtime'
import { createApplicationStore } from './application-store.mjs'
import { validateApplicationConfiguration } from './application-config.mjs'

export function applicationHaEnabled() { return process.env.APPLICATION_DATA_MODE === 'quorum' }
export async function getApplicationStore(userId: string, guildIds: string[]) {
  if (!applicationHaEnabled()) return null
  validateApplicationConfiguration(process.env)
  const runtime = await getSecurityCoordinator()
  if (!runtime) throw Object.assign(new Error('Application quorum is not configured'), { code: 'APP_CONFIGURATION' })
  const encoded = process.env.APPLICATION_DATA_ENCRYPTION_KEY
  const key = encoded && /^[a-f0-9]{64}$/.test(encoded) ? Buffer.from(encoded, 'hex') : null
  return createApplicationStore({ ...runtime, key, keyId: process.env.APPLICATION_DATA_ENCRYPTION_KEY_ID,
    authorize: async ({ guildId, ownerId, operation, domain }: { guildId: string; ownerId: string; operation: string; domain: string }) =>
      guildIds.includes(guildId) && (!ownerId || ownerId === userId) &&
      (operation === 'read' || ['goals', 'notification-receipts'].includes(domain)),
  })
}
export function applicationError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'APP_UNAVAILABLE'
  const conflict = /CONFLICT|CONFIRMATION|REVISION_REQUIRED/.test(code)
  return { status: conflict ? 409 : code === 'APP_FORBIDDEN' ? 403 : /^APP_(GOALS|RECEIPTS|DATA|CAPACITY|INPUT)$/.test(code) ? 400 : 503,
    body: { error: conflict ? '設定が変更されたか、未確認です。再読み込みして確認してください。' : 'データを取得できません。', code: /^[A-Z_]+$/.test(code) ? code : 'APP_UNAVAILABLE', state: conflict ? 'conflict' : 'unavailable' } }
}
