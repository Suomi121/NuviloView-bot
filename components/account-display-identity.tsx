'use client'
import { ProfileAvatar } from '@/components/profile-avatar'
import { useDisplayIdentity } from '@/components/use-display-identity'
import type { DisplayIdentity } from '@/lib/display-identity'

export function AccountDisplayIdentity({ user }: { user: DisplayIdentity & { id: string } }) {
  const profile = useDisplayIdentity(user)
  return <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
    <ProfileAvatar image={profile?.image} name={profile?.name || 'NuviloView user'} />
    <span>{profile?.name || 'NuviloView user'}</span>
  </div>
}
