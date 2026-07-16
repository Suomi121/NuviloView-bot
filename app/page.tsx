import { SiteHeader } from '@/components/site-header'
import { HeroSection } from '@/components/hero-section'
import { FeaturesSection } from '@/components/features-section'
import { HowItWorksSection } from '@/components/how-it-works-section'
import { SiteFooter } from '@/components/site-footer'

export default function Page() {
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
