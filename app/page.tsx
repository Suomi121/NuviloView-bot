import { SiteHeader } from '@/components/site-header'
import { HeroSection } from '@/components/hero-section'
import { FeaturesSection } from '@/components/features-section'
import { HowItWorksSection } from '@/components/how-it-works-section'
import { SiteFooter } from '@/components/site-footer'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/dashboard')

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      <SiteHeader />
      <HeroSection />
      <FeaturesSection />
      <HowItWorksSection />
      <SiteFooter />
    </main>
  )
}
