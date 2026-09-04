export type AuthRedirectProvider = 'discord' | 'google'

const DEFAULT_AUTH_CALLBACKS: Record<AuthRedirectProvider, string> = {
  discord: '/dashboard',
  google: '/account',
}

function isUnsafeDecodedPath(value: string) {
  return (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
}

/**
 * Accept only same-site relative callback paths. OAuth state and origin checks
 * remain owned by Better Auth; this is an additional client-side boundary that
 * keeps accidental or encoded external redirects out of the sign-in request.
 */
export function sanitizeAuthCallbackPath(value: unknown, fallback = '/dashboard') {
  if (typeof value !== 'string') return fallback

  const candidate = value.trim()
  if (!candidate || isUnsafeDecodedPath(candidate)) return fallback

  let decoded = candidate
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      return fallback
    }
  }

  if (isUnsafeDecodedPath(decoded)) return fallback

  try {
    const parsed = new URL(candidate, 'https://nuviloview.invalid')
    if (parsed.origin !== 'https://nuviloview.invalid') return fallback
    if (parsed.pathname.startsWith('/api/auth') || parsed.pathname === '/auth-error') return fallback
  } catch {
    return fallback
  }

  return candidate
}

export function getAuthCallbackPath(provider: AuthRedirectProvider, currentPath: unknown) {
  const fallback = DEFAULT_AUTH_CALLBACKS[provider]
  const candidate = sanitizeAuthCallbackPath(currentPath, fallback)

  try {
    const parsed = new URL(candidate, 'https://nuviloview.invalid')
    return parsed.pathname === '/' ? fallback : candidate
  } catch {
    return fallback
  }
}
