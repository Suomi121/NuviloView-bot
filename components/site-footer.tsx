'use client'

import { Coffee } from 'lucide-react'
import { useLocale } from '@/components/locale-provider'

export function SiteFooter() {
  const { locale } = useLocale()
  const en = locale === 'en'
  return (
    <footer className="border-t border-border/60 px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <a href="/?landing=1" className="flex items-center gap-2" aria-label="NuviloView:OEM ランディングページへ">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary text-primary-foreground"><Coffee className="h-3 w-3" strokeWidth={2.25} /></span>
          <span className="text-sm font-semibold text-foreground">
            NuviloView<span className="text-primary">:OEM</span>
          </span>
        </a>
        <div className="flex flex-col items-center gap-1 sm:items-end">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} NuviloView:OEM. All rights reserved.
          </p>
          <p className="text-xs text-muted-foreground/60">
            {en ? 'This service is not affiliated with Discord.' : '本サービスはDiscord公式の提供ではありません。'}
          </p>
          <p className="flex gap-3 text-xs"><a href="/terms" className="text-muted-foreground hover:text-foreground">{en ? 'Terms' : '利用規約'}</a><a href="/privacy" className="text-muted-foreground hover:text-foreground">{en ? 'Privacy' : 'プライバシー'}</a></p>
        </div>
      </div>
    </footer>
  )
}
