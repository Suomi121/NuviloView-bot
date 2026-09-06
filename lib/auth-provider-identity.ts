import { createAuthMiddleware } from 'better-auth/api'

export const PROVIDER_IDENTITY_CONSTRAINT = 'account_provider_identity_unique'

export function isProviderIdentityConflict(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) return false
    seen.add(current)
    const item = current as { code?: unknown; constraint?: unknown; table?: unknown; cause?: unknown }
    if (item.code === '23505' && item.constraint === PROVIDER_IDENTITY_CONSTRAINT &&
        (item.table === undefined || item.table === 'account')) return true
    current = item.cause
  }
  return false
}

// Request-local wrapper only. Better Auth still validates OAuth state, PKCE,
// session ownership and redirects. The database, not this hook, prevents races.
export const providerIdentityConflictHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== '/callback/:id' ||
      (ctx.params?.id !== 'google' && ctx.params?.id !== 'discord')) return
  const adapter = ctx.context.internalAdapter
  return {
    context: {
      context: {
        internalAdapter: {
          ...adapter,
          createAccount: async (...args: Parameters<typeof adapter.createAccount>) => {
            try {
              return await adapter.createAccount(...args)
            } catch (error) {
              if (!isProviderIdentityConflict(error)) throw error
              // Fixed same-site destination; never expose driver details or claim
              // a failed link succeeded. Do not update the winning account.
              throw ctx.redirect('/auth-error?error=account_already_linked_to_different_user')
            }
          },
        },
      },
    },
  }
})
