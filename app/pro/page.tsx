import { SiteHeader } from '@/components/site-header'
import { ArrowRight, Check, Crown, ShieldCheck, Sparkles } from 'lucide-react'
import Link from 'next/link'

const previewItems = [
  '高度な分析を見つけやすくする専用ページ',
  '既存のDiscord認可とGuild境界をそのまま維持',
  '今後のPro機能を安全に追加できる表示シェル',
]

export default function ProPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <SiteHeader />
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-20 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-primary/20 blur-[150px]" />
      <section className="relative mx-auto max-w-4xl px-6 pb-24 pt-32 sm:pt-40">
        <div className="overflow-hidden rounded-3xl border border-primary/25 bg-card/70 shadow-2xl shadow-black/20 backdrop-blur-xl">
          <div className="border-b border-border/70 bg-gradient-to-br from-primary/[0.16] to-transparent px-6 py-10 text-center sm:px-10 sm:py-14">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
              <Crown className="h-7 w-7" />
            </span>
            <p className="mt-6 text-xs font-bold tracking-[0.18em] text-primary">NUVILOVIEW PRO</p>
            <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">Proの準備ページ</h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
              将来の拡張機能を整理するためのプレビューシェルです。現在は課金、決済、サブスクリプション、Pro権限の付与を行いません。
            </p>
          </div>
          <div className="grid gap-6 p-6 sm:p-10 md:grid-cols-[1fr_0.8fr]">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <h2 className="font-bold">このShellに含まれるもの</h2>
              </div>
              <ul className="mt-5 space-y-3">
                {previewItems.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <aside className="rounded-2xl border border-border bg-background/40 p-5">
              <div className="flex items-center gap-2 text-sm font-bold">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Billingなし
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                購入ボタン、価格、決済情報の入力、請求処理はありません。このページを開いても料金は発生しません。
              </p>
              <Link href="/dashboard" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90">
                ダッシュボードへ
                <ArrowRight className="h-4 w-4" />
              </Link>
            </aside>
          </div>
        </div>
      </section>
    </main>
  )
}
