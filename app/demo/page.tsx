import { DashboardShowcaseSection } from '@/components/dashboard-showcase-section'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export const metadata = {
  title: 'ログイン不要のダッシュボードデモ | NuviloView:OEM',
  description: 'NuviloView:OEMのPC・スマホ向けダッシュボードを、架空サーバーのサンプルデータで確認できます。',
}

export default function DemoPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="relative overflow-hidden px-6 pb-8 pt-32 text-center">
        <div className="pointer-events-none absolute left-1/2 top-10 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/15 blur-[110px]" />
        <div className="relative mx-auto max-w-3xl">
          <p className="text-xs font-bold tracking-[.2em] text-primary">PUBLIC DASHBOARD DEMO</p>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">ログインせずに、実際の画面を確認</h1>
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">実際のダッシュボードと同じ構成を、架空サーバー「Lunaria Lounge」のサンプル数値で表示しています。Discordアカウントや実サーバーの情報は使用しません。</p>
        </div>
      </section>
      <DashboardShowcaseSection />
      <SiteFooter />
    </main>
  )
}
