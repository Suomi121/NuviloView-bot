'use client'

import { LoginButton } from '@/components/login-button'
import { Coffee } from 'lucide-react'
import { useLocale } from '@/components/locale-provider'

export function SiteHeader() {
  const { locale } = useLocale()
  const en = locale === 'en'
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Coffee className="h-[18px] w-[18px]" strokeWidth={2.25} />
          </span>
          <span className="text-base font-bold tracking-tight text-foreground">
            NuviloView<span className="text-primary">:OEM</span>
          </span>
        </a>
        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="/features" className="transition-colors hover:text-foreground">
            {en ? 'Features' : '機能'}
          </a>
          <a href="/docs" className="transition-colors hover:text-foreground">
            {en ? 'Documentation' : 'ドキュメント'}
          </a>
          <a href="/guides" className="transition-colors hover:text-foreground">
            {en ? 'Guides' : '運営ガイド'}
          </a>
          <a href="/support" className="transition-colors hover:text-foreground">
            {en ? 'Support' : 'サポート'}
          </a>
        </nav>
        <LoginButton compact />
      </div>
    </header>
  )
}
