import { ArrowUpRight, BarChart3, LayoutDashboard, KeyRound } from 'lucide-react'

const features = [
  {
    icon: BarChart3,
    title: '高度なサーバー分析',
    description:
      '総メンバー、アクティブ・非アクティブメンバー、総送信数、今日のメッセージ、リアクションをBotが集計します。',
  },
  {
    icon: LayoutDashboard,
    title: 'サーバー別ダッシュボード',
    description:
      '管理権限のあるサーバーだけを選択して閲覧可能。接続状況・チャンネル権限・アクティビティを一画面で確認できます。',
  },
  {
    icon: KeyRound,
    title: '簡単OAuth2連携',
    description:
      'Discord OAuth2による安全なログイン。時間帯の表示設定もユーザーごとに保存されます。',
  },
]

export function FeaturesSection() {
  return (
    <section id="features" className="relative px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Features
          </p>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            コミュニティ運営に必要な、すべてを一つに。
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-muted-foreground">
            分析から安全なログインまで。NuviloView:OEMが提供する3つのコア機能。
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-3">
          {features.map((feature, index) => (
            <a
              href="/features"
              key={feature.title}
              className={`landing-feature-card group relative rounded-2xl border border-border bg-card/50 p-8 transition-colors hover:border-primary/40 landing-feature-delay-${index + 1}`}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary text-primary transition-colors group-hover:border-primary/40">
                <feature.icon className="h-6 w-6" />
              </div>
              <h3 className="mt-6 text-lg font-semibold text-foreground">
                {feature.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
              <span className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-primary">詳しく見る <ArrowUpRight className="h-4 w-4" /></span>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}
