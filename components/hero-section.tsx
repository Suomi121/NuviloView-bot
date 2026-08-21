import { ArrowRight, ArrowUpRight, Bot, Check, ShieldCheck } from 'lucide-react'
import { LoginButton } from '@/components/login-button'

export function HeroSection() {
  const clientId = process.env.NUVILOVIEW_CLIENT_ID ?? process.env.DISCORD_CLIENT_ID
  const botInviteUrl = clientId
    ? `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=1099511721094&integration_type=0&scope=bot%20applications.commands`
    : null

  return (
    <section
      id="login"
      className="relative flex min-h-[92vh] items-center justify-center overflow-hidden px-6 pt-16"
    >
      {/* Subtle blurred gradient glows for depth */}
      <div
        aria-hidden="true"
        className="landing-orb landing-orb-one pointer-events-none absolute left-1/2 top-[-10%] h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-primary/25 blur-[140px]"
      />
      <div
        aria-hidden="true"
        className="landing-orb landing-orb-two pointer-events-none absolute bottom-[-20%] right-[-5%] h-[400px] w-[400px] rounded-full bg-primary/10 blur-[130px]"
      />
      {/* faint grid */}
      <div
        aria-hidden="true"
        className="landing-grid pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
      />

      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
        <div className="landing-reveal mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
          <span className="landing-status-dot h-1.5 w-1.5 rounded-full bg-primary" />
          分析 × OEM ダッシュボード
        </div>

        <h1 className="landing-reveal landing-reveal-delay-1 text-balance text-4xl font-extrabold leading-[1.15] tracking-tight text-foreground sm:text-5xl md:text-6xl">
          あなたのDiscordコミュニティを、
          <br className="hidden sm:block" />
          <span className="text-primary">次のステージへ。</span>
        </h1>

        <p className="landing-reveal landing-reveal-delay-2 mt-6 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
          メンバーの増減、会話量、リアクション、通話時間をまとめて見える化するダッシュボード。
          Botが受信したデータを自動更新し、コミュニティの今を実データから判断できます。
        </p>

        <div className="landing-reveal landing-reveal-delay-3 mt-10 flex flex-col items-center">
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <div className="landing-login-wrap"><LoginButton /></div>
            <a href="/demo" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card/70 px-5 text-sm font-bold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10">
              デモを見る <ArrowRight className="h-4 w-4" />
            </a>
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <ShieldCheck className="h-3.5 w-3.5" />
            Discord OAuth2を利用して安全に連携します（Discord公式サービスではありません）
          </p>
        </div>

        <div className="landing-bot-card landing-reveal landing-reveal-delay-4 relative mt-10 w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-card/55 p-4 text-left shadow-2xl shadow-black/10 backdrop-blur-xl sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Bot className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-foreground">分析を始めるにはBotを追加</p>
                <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">STEP 2</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">活動を自動集計し、権限を持つ運営者向けの安全なモデレーション機能も追加します。</p>
            </div>
            {botInviteUrl ? (
              <a
                href={botInviteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2.5 text-xs font-bold text-background transition-transform hover:-translate-y-0.5"
              >
                Botを追加 <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            ) : (
              <a href="/support" className="shrink-0 rounded-lg border border-border px-3.5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">Bot招待を確認できません · サポート</a>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-primary" />検索用の本文は原則最大90日間保存</span>
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-primary" />Botはいつでもサーバーから退出可能</span>
          </div>
        </div>

      </div>
    </section>
  )
}
