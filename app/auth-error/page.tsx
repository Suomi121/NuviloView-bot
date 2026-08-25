import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'

export default function AuthErrorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-9 w-9 text-amber-500" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-bold">ログインサービスが一時的に利用できません</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          認証用データベースへ接続できませんでした。少し時間をおいてから、もう一度お試しください。
        </p>
        <Link href="/" className="mt-6 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground">
          トップへ戻る
        </Link>
      </section>
    </main>
  )
}
