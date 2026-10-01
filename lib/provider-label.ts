export type ProviderLabel = { name: string | null; detail: string | null }

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Provider-specific data only: never substitute the shared Better Auth user.
export function providerLabel(provider: 'google' | 'discord', info: unknown): ProviderLabel {
  const profile = info as { user?: { name?: unknown; email?: unknown }; data?: { username?: unknown } } | null
  return {
    name: text(profile?.user?.name),
    detail: provider === 'google' ? text(profile?.user?.email) : text(profile?.data?.username),
  }
}
