import { SiteHeader } from '@/components/site-header'
import { HeroSection } from '@/components/hero-section'
import { FeaturesSection } from '@/components/features-section'
import { HowItWorksSection } from '@/components/how-it-works-section'
import { SiteFooter } from '@/components/site-footer'
import { DashboardShowcaseSection } from '@/components/dashboard-showcase-section'
import { AnalysisExamplesSection } from '@/components/analysis-examples-section'
import { auth } from '@/lib/auth'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'NuviloView:OEM — コミュニティを、次のステージへ。',
  description:
    'Discordサーバーのメンバー、会話量、リアクション、通話時間を見える化する分析ダッシュボード。',
  alternates: {
    canonical: '/',
  },
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ landing?: string }>
}) {
  const { landing } = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user && landing !== '1') redirect('/dashboard')

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      <SiteHeader />
      <HeroSection />
      <DashboardShowcaseSection />
      <AnalysisExamplesSection />
      <FeaturesSection />
      <HowItWorksSection />
      <SiteFooter />
    </main>
  )
}
