import { ArrowRight, ArrowUpRight, BarChart3, Bot, Check, ShieldCheck, Users, Zap } from 'lucide-react'
import { LoginButton } from '@/components/login-button'

export function HeroSection() {
  const clientId = process.env.DISCORD_CLIENT_ID
  const botInviteUrl = clientId
    ? `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=66560&integration_type=0&scope=bot`
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
            <a href="#dashboard-demo" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card/70 px-5 text-sm font-bold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10">
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
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">メッセージ・メンバー・リアクション・通話時間を自動集計します。</p>
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
              <span className="shrink-0 rounded-lg border border-border px-3.5 py-2.5 text-xs font-medium text-muted-foreground">Bot設定を準備中</span>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-primary" />検索用の本文は原則最大90日間保存</span>
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-primary" />Botはいつでもサーバーから退出可能</span>
          </div>
        </div>

        <section aria-labelledby="analysis-examples" className="mt-16 w-full max-w-5xl text-left">
          <div className="mb-6 text-center">
            <p className="text-xs font-bold tracking-[0.2em] text-primary">WHAT YOU CAN ANALYZE</p>
            <h2 id="analysis-examples" className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">何を分析できる？</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <article className="landing-analysis-card landing-reveal landing-reveal-delay-5 rounded-2xl border border-border/80 bg-card/50 p-5 backdrop-blur-sm">
              <Users className="h-5 w-5 text-primary" />
              <h3 className="mt-4 font-bold">コミュニティの成長</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">今日の総メンバーと前期間を比べ、参加・退出の流れを確認できます。</p>
            </article>
            <article className="landing-analysis-card landing-reveal landing-reveal-delay-6 rounded-2xl border border-border/80 bg-card/50 p-5 backdrop-blur-sm">
              <BarChart3 className="h-5 w-5 text-primary" />
              <h3 className="mt-4 font-bold">会話の活発さ</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">総送信数、今日のアクティブメッセージ、アクティブ・非アクティブメンバーを追えます。</p>
            </article>
            <article className="landing-analysis-card landing-reveal landing-reveal-delay-7 rounded-2xl border border-border/80 bg-card/50 p-5 backdrop-blur-sm">
              <Zap className="h-5 w-5 text-primary" />
              <h3 className="mt-4 font-bold">通話の盛り上がり</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">サーバー内の通話合計・最長連続通話に加え、Botの接続状態と読み取れないチャンネルも確認できます。</p>
            </article>
          </div>
          <a href="/guides" className="mx-auto mt-6 inline-flex w-fit items-center gap-2 text-sm font-bold text-primary hover:underline">サーバー運営ガイドを読む <ArrowRight className="h-4 w-4" /></a>
        </section>
      </div>
    </section>
  )
}
