import { ArrowRight, BarChart3, MessageSquareText, UsersRound } from 'lucide-react'
import type { Metadata } from 'next'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export const metadata: Metadata = {
  title: '運営ガイド | NuviloView:OEM',
  description:
    'Discordコミュニティのメンバー推移や会話量を読み取り、改善につなげるための運営ガイドです。',
  alternates: {
    canonical: '/guides',
  },
}

const guides = [
  {
    icon: UsersRound,
    title: 'メンバーが増えた・減った理由を追う',
    lead: '人数の変化を「ただの数字」で終わらせず、運営の次の一手につなげる見方です。',
    points: ['期間を7日・30日・3か月などに切り替え、増減が起きた日を探します。', '最近のアクティビティで、参加・退出が増えた時間帯やイベントの前後を確認します。', '一時的な増加と、定着している増加を区別するため、複数期間で比較します。'],
  },
  {
    icon: MessageSquareText,
    title: '会話量から「活動しやすさ」を読む',
    lead: 'メッセージ数だけでなく、実際に話した人数とリアクションも合わせて見ます。',
    points: ['メッセージ数とアクティブメンバーを並べて、少人数だけで会話が偏っていないか確認します。', 'リアクション率が高い投稿は、参加しやすい話題や告知のヒントになります。', '急に会話が減ったときは、チャンネル構成やイベント時間を見直すきっかけにできます。'],
  },
  {
    icon: BarChart3,
    title: '数字を使った小さな改善サイクル',
    lead: '大きな施策より、仮説を一つ決めて結果を比べる運営が続きやすくなります。',
    points: ['例として「週末に質問チャンネルで話題を一つ出す」など、実施内容を小さく決めます。', '前期間と比べ、メッセージ数・アクティブメンバー・リアクション率の変化を確認します。', '良かった施策は続け、反応が薄ければ時間帯や内容を一つずつ変えて再度試します。'],
  },
]

export default function GuidesPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-4xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">COMMUNITY GUIDES</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">サーバー運営ガイド</h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">NuviloView:OEMで見えるデータを、日々のコミュニティ運営に活かすための読みものです。</p>
        <div className="mt-12 space-y-6">
          {guides.map((guide, index) => (
            <article key={guide.title} className="rounded-2xl border border-border bg-card/55 p-6 sm:p-8">
              <div className="flex items-center gap-3 text-primary"><guide.icon className="h-6 w-6" /><span className="text-xs font-bold tracking-widest">GUIDE {String(index + 1).padStart(2, '0')}</span></div>
              <h2 className="mt-5 text-2xl font-bold tracking-tight">{guide.title}</h2>
              <p className="mt-3 leading-relaxed text-muted-foreground">{guide.lead}</p>
              <ol className="mt-6 space-y-3 text-sm leading-relaxed text-muted-foreground">{guide.points.map((point, pointIndex) => <li key={point} className="flex gap-3"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">{pointIndex + 1}</span>{point}</li>)}</ol>
            </article>
          ))}
        </div>
        <a href="/docs" className="mt-10 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">Botの導入手順を見る <ArrowRight className="h-4 w-4" /></a>
      </section>
      <SiteFooter />
    </main>
  )
}
