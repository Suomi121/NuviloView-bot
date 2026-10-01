export type DisplayIdentity = { name?: string | null; image?: string | null }

export function selectDisplayIdentity(profiles: { discord?: DisplayIdentity; google?: DisplayIdentity }, fallback: DisplayIdentity) {
  const candidates = [profiles.discord, profiles.google, fallback]
  return {
    name: candidates.find(p => p?.name?.trim())?.name || 'NuviloView user',
    image: candidates.find(p => p?.image)?.image || null,
  }
}
