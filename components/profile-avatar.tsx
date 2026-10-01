'use client'

import { useState } from 'react'

export function ProfileAvatar({ image, name }: { image?: string | null; name: string }) {
  const [failedImage, setFailedImage] = useState<string | null>(null)
  if (image && image !== failedImage) return <img src={image} alt="" referrerPolicy="no-referrer" onError={() => setFailedImage(image)} className="h-9 w-9 rounded-full object-cover" />
  return <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">{name.slice(0, 2).toUpperCase() || '?'}</span>
}
