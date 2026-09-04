import { AccountConnections } from '@/components/account-connections'
import { auth } from '@/lib/auth'
import { getAuthProviderAvailability } from '@/lib/auth-provider-config'
import { ChevronLeft, Link2 } from 'lucide-react'
import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export default async function AccountPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/?landing=1')

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-1/3 top-0 h-96 w-96 rounded-full bg-primary/[0.1] blur-[130px]" />
      </div>
      <section className="relative mx-auto max-w-2xl px-5 py-10 sm:py-16">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          ダッシュボードに戻る
        </Link>
        <div className="mt-10 rounded-2xl border border-border bg-card/65 p-6 shadow-2xl shadow-black/10 backdrop-blur-xl sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Link2 className="h-5 w-5" />
          </div>
          <h1 className="mt-5 text-2xl font-extrabold tracking-tight">アカウント接続</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {session.user.name}さんのログイン方法とDiscord認可の連携状態を確認できます。
          </p>
          <AccountConnections providerAvailability={getAuthProviderAvailability()} />
        </div>
      </section>
    </main>
  )
}
