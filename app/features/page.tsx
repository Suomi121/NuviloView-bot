import { Activity, ArrowRight, Bot, ChartNoAxesCombined, LockKeyhole, Sparkles, Users } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'

const features = [
  { icon: ChartNoAxesCombined, title: '日次アナリティクス', body: '総メンバー数、送信数、リアクション率を日ごとに集計し、推移グラフで確認できます。' },
  { icon: Users, title: '今日の活動状況', body: '当日のユニーク発言者、非アクティブメンバー、今日の送信数をライブ表示します。' },
  { icon: Activity, title: '最近のアクティビティ', body: 'メッセージ送信・参加・退出を時系列で表示します。検索機能のため、閲覧可能なチャンネルの本文を保存します。' },
  { icon: Sparkles, title: '成長インサイト', body: '直近の実績と前期間を比較し、メンバーと会話量の変化を自動で要約します。' },
  { icon: LockKeyhole, title: '権限ベースの閲覧', body: 'Discordで管理権限を持つサーバーだけを表示。Botが読み取れないチャンネルもダッシュボードで確認できます。' },
  { icon: Bot, title: '軽量な分析Bot', body: 'Botはメンバー数・件数・リアクション・通話時間を集計。/tactive、/week、/suc、/permissions などの運営コマンドも使えます。' },
]

export default function FeaturesPage() {
  return <main className="min-h-screen bg-background text-foreground"><SiteHeader /><section className="relative overflow-hidden px-6 pb-24 pt-32"><div className="pointer-events-none absolute left-1/2 top-0 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/15 blur-[140px]" /><div className="relative mx-auto max-w-6xl"><p className="text-sm font-bold tracking-widest text-primary">FEATURES</p><h1 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">実データで、コミュニティの今を知る。</h1><p className="mt-5 max-w-2xl leading-relaxed text-muted-foreground">NuviloView:OEMはBotとダッシュボードを連携し、運営に必要な数字をプライバシーに配慮して見える化します。</p><div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">{features.map((feature) => <article key={feature.title} className="rounded-2xl border border-border bg-card/55 p-6"><feature.icon className="h-6 w-6 text-primary" /><h2 className="mt-5 font-bold">{feature.title}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.body}</p></article>)}</div><a href="/docs" className="mt-12 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">セットアップを見る <ArrowRight className="h-4 w-4" /></a></div></section><SiteFooter /></main>
}
