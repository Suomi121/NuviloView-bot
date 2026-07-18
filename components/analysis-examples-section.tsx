import { ArrowRight, BarChart3, Users, Zap } from 'lucide-react'

export function AnalysisExamplesSection() {
  return (
    <section aria-labelledby="analysis-examples" className="relative px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 text-center">
          <p className="text-xs font-bold tracking-[0.2em] text-primary">WHAT YOU CAN ANALYZE</p>
          <h2 id="analysis-examples" className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">何を分析できる？</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <article className="landing-analysis-card rounded-2xl border border-border/80 bg-card/50 p-6 backdrop-blur-sm">
            <Users className="h-5 w-5 text-primary" />
            <h3 className="mt-4 font-bold">コミュニティの成長</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">今日の総メンバーと前期間を比べ、参加・退出の流れを確認できます。</p>
          </article>
          <article className="landing-analysis-card rounded-2xl border border-border/80 bg-card/50 p-6 backdrop-blur-sm">
            <BarChart3 className="h-5 w-5 text-primary" />
            <h3 className="mt-4 font-bold">会話の活発さ</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">総送信数、今日のアクティブメッセージ、アクティブ・非アクティブメンバーを追えます。</p>
          </article>
          <article className="landing-analysis-card rounded-2xl border border-border/80 bg-card/50 p-6 backdrop-blur-sm">
            <Zap className="h-5 w-5 text-primary" />
            <h3 className="mt-4 font-bold">通話の盛り上がり</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">サーバー内の通話合計・最長連続通話に加え、Botの接続状態と読み取れないチャンネルも確認できます。</p>
          </article>
        </div>
        <a href="/guides" className="mx-auto mt-7 flex w-fit items-center gap-2 text-sm font-bold text-primary hover:underline">サーバー運営ガイドを読む <ArrowRight className="h-4 w-4" /></a>
      </div>
    </section>
  )
}
