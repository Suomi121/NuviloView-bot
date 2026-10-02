import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { AuthErrorDiscordButton } from '@/components/auth-error-discord-button'

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; provider?: string }>
}) {
  const { error, provider } = await searchParams
  const identityConflict = error === 'account_already_linked_to_different_user'
  const discordConflict = identityConflict && provider === 'discord'
  // Same-email, unlinked Google identities are also rejected (no auto-merge).
  // Give both cases the same onboarding guidance without revealing ownership.
  const googleFirstBlocked = error === 'signup_disabled' || (provider === 'google' && error === 'account_not_linked')
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-9 w-9 text-amber-500" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-bold">
          {identityConflict ? 'アカウントを連携できませんでした' : googleFirstBlocked ? '初回利用にはDiscordが必要です' : 'ログインサービスが一時的に利用できません'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {discordConflict
            ? 'このDiscordアカウントには既存のNuviloViewアカウントがあります。Discordでログインして既存アカウントを使用してください。'
            : identityConflict
              ? 'このGoogleアカウントには既存のNuviloViewアカウントがあります。Googleでログインして既存アカウントを使用してください。'
              : googleFirstBlocked
                ? 'Googleは追加のログイン方法です。初回利用にはDiscordアカウントが必要です。'
                : 'ログインを完了できませんでした。通信状態を確認し、少し時間をおいてから、もう一度お試しください。'}
        </p>
        {googleFirstBlocked ? <AuthErrorDiscordButton /> : <Link href={identityConflict ? '/account' : '/'} className="mt-6 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground">
          {identityConflict ? 'アカウントへ戻る' : 'トップへ戻る'}
        </Link>}
      </section>
    </main>
  )
}
