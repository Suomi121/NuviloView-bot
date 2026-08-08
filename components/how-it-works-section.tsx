import { ArrowRight, Bot, ChartNoAxesCombined, LogIn, ShieldCheck } from "lucide-react";

const steps = [
  {
    icon: LogIn,
    number: "01",
    title: "Discordでログイン",
    body: "管理権限を持つDiscordアカウントでログインします。表示されるのは管理できるサーバーだけです。",
  },
  {
    icon: Bot,
    number: "02",
    title: "Botを追加",
    body: "分析したいサーバーへNuviloChan Botを追加。Administratorではなく、分析とモデレーションに必要な個別権限だけを使用します。",
  },
  {
    icon: ChartNoAxesCombined,
    number: "03",
    title: "データを確認",
    body: "メンバー・会話・リアクション・通話状況を、ダッシュボードで自動更新しながら確認できます。",
  },
];

export function HowItWorksSection() {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const botInviteUrl = clientId
    ? `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=1099511721094&integration_type=0&scope=bot%20applications.commands`
    : null;

  return (
    <section id="getting-started" className="relative overflow-hidden px-6 py-24 sm:py-32">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[120px]" />
      <div className="relative mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Getting started
          </p>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            分析を始めるまで、3ステップ。
          </h2>
          <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
            導入後はBotがサーバー内の活動を記録し、ダッシュボードを開いている間は自動で最新状態を表示します。
          </p>
        </div>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {steps.map((step) => (
            <article
              key={step.number}
              className="landing-feature-card relative overflow-hidden rounded-2xl border border-border bg-card/55 p-7"
            >
              <span className="absolute right-5 top-4 text-5xl font-black tracking-tighter text-primary/[0.09]">
                {step.number}
              </span>
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <step.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-6 text-lg font-bold text-foreground">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-center justify-between gap-5 rounded-2xl border border-primary/20 bg-primary/[0.08] p-6 sm:flex-row sm:p-7">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Administrator権限は不要です。モデレーションは実行者とBotの個別権限・ロール階層を毎回確認し、操作を監査ログへ保存します。
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <a
              href="#login"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition-transform hover:-translate-y-0.5"
            >
              Discordで始める <ArrowRight className="h-4 w-4" />
            </a>
            {botInviteUrl && (
              <a
                href={botInviteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-secondary"
              >
                Botを追加
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
