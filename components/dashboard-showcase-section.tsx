'use client'

import { useEffect, useState } from 'react'
import {
  Activity,
  ArrowRight,
  Clock3,
  Goal,
  Hash,
  Heart,
  Languages,
  MessageSquareText,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react'

const demoSteps = [
  {
    eyebrow: '00–07秒',
    title: 'サーバー全体をひと目で確認',
    body: 'メンバー、会話量、リアクション、通話時間を一つの画面で比較します。',
    metric: '2,846',
    label: '総メンバー',
    accent: '+124 今月',
  },
  {
    eyebrow: '08–15秒',
    title: '伸びている場所を発見',
    body: 'チャンネル別インサイトから、会話が増えている場所を確認できます。',
    metric: '+38%',
    label: '# 雑談 の成長率',
    accent: '前期間との比較',
  },
  {
    eyebrow: '16–23秒',
    title: '記録状態をすぐ把握',
    body: '最終記録時刻と読み取れないチャンネルをサーバーヘルスで確認できます。',
    metric: '92',
    label: 'サーバーヘルス',
    accent: '正常に記録中',
  },
  {
    eyebrow: '24–30秒',
    title: '次の目標まで可視化',
    body: 'メンバー増加、メッセージ数、通話時間の月間目標を追跡します。',
    metric: '74%',
    label: '今月の目標',
    accent: 'あと26%',
  },
]

const featurePreviews = [
  {
    icon: Languages,
    title: 'メッセージ翻訳',
    body: 'Discordのメッセージメニューから翻訳先を選択。結果は実行した本人だけに表示されます。',
    preview: (
      <div className="space-y-2 rounded-xl border border-border bg-background/80 p-3 text-xs">
        <div className="flex items-center justify-between text-muted-foreground"><span>翻訳先の言語</span><span>日本語 🇯🇵</span></div>
        <div className="rounded-lg bg-primary/10 p-2.5 text-foreground">Welcome to our community!</div>
        <div className="rounded-lg bg-secondary p-2.5 text-foreground">コミュニティへようこそ！</div>
      </div>
    ),
  },
  {
    icon: Search,
    title: 'メッセージ検索',
    body: '管理中のサーバーを対象に、保存期間内のメッセージを本文・投稿者・チャンネル付きで検索できます。',
    preview: (
      <div className="rounded-xl border border-border bg-background/80 p-3 text-xs">
        <div className="flex items-center gap-2 rounded-lg border border-primary/40 px-3 py-2 text-muted-foreground"><Search className="h-3.5 w-3.5" />イベント</div>
        <div className="mt-2 rounded-lg bg-secondary/70 p-2.5"><b className="text-foreground">Mika</b><span className="ml-2 text-muted-foreground">#お知らせ</span><p className="mt-1 text-muted-foreground">週末イベントの参加者を募集します…</p></div>
      </div>
    ),
  },
  {
    icon: ShieldCheck,
    title: 'サーバーヘルス',
    body: 'Botの最終記録時刻と権限不足を確認。データが欠ける原因を管理者が見つけやすくします。',
    preview: (
      <div className="flex items-center gap-4 rounded-xl border border-border bg-background/80 p-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border-4 border-emerald-400 text-lg font-black">92</div>
        <div className="text-xs"><b className="text-emerald-400">正常に記録中</b><p className="mt-1 text-muted-foreground">最終記録: 1分前</p><p className="text-muted-foreground">権限不足: 0件</p></div>
      </div>
    ),
  },
  {
    icon: Sparkles,
    title: 'サーバーインサイト',
    body: '前期間との変化や、伸びている・静かなチャンネルを実データから自動で整理します。',
    preview: (
      <div className="space-y-2 rounded-xl border border-border bg-background/80 p-3 text-xs">
        <p className="font-bold text-foreground">今週のハイライト</p>
        <div className="flex justify-between rounded-lg bg-secondary/70 p-2.5"><span># 雑談</span><b className="text-emerald-400">+38%</b></div>
        <div className="flex justify-between rounded-lg bg-secondary/70 p-2.5"><span># ゲーム募集</span><b className="text-primary">1,284件</b></div>
      </div>
    ),
  },
  {
    icon: Goal,
    title: '成長目標',
    body: '今月のメンバー増加、総メッセージ、通話時間に目標を設定し、進捗を追跡できます。',
    preview: (
      <div className="space-y-3 rounded-xl border border-border bg-background/80 p-3 text-xs">
        <div className="flex justify-between"><b>月間メッセージ</b><span className="text-muted-foreground">7,420 / 10,000</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full w-[74%] rounded-full bg-primary" /></div>
        <p className="text-muted-foreground">目標まであと 2,580件</p>
      </div>
    ),
  },
]

export function DashboardShowcaseSection() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % demoSteps.length)
    }, 7500)
    return () => window.clearInterval(timer)
  }, [])

  const current = demoSteps[step]

  return (
    <section id="dashboard-demo" className="relative overflow-hidden px-6 py-24 sm:py-32">
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-primary/[0.09] blur-[150px]" />
      <div className="relative mx-auto max-w-6xl">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-bold text-primary"><Sparkles className="h-3.5 w-3.5" />実画面イメージ</span>
          <h2 className="mt-5 text-balance text-3xl font-extrabold tracking-tight sm:text-5xl">数字を見るだけで、次の一手が分かる。</h2>
          <p className="mt-5 leading-relaxed text-muted-foreground">架空のDiscordサーバー「Lunaria Lounge」を使ったサンプルです。実際のダッシュボードでは、管理できるサーバーの記録データへ自動で切り替わります。</p>
          <a href="#thirty-second-demo" className="mt-7 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-transform hover:-translate-y-0.5">ダッシュボードのデモを見る <ArrowRight className="h-4 w-4" /></a>
        </div>

        <div className="mt-14 grid items-end gap-8 lg:grid-cols-[1fr_280px]">
          <DesktopDashboardPreview />
          <MobileDashboardPreview />
        </div>

        <div className="mt-24">
          <div className="max-w-2xl">
            <p className="text-xs font-bold tracking-[0.2em] text-primary">WHAT YOU CAN DISCOVER</p>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">実際に何が分かる？</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">集計値だけで終わらず、検索・翻訳・状態確認・目標管理まで、運営の判断につながる画面を用意しています。</p>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {featurePreviews.map((feature, index) => (
              <article key={feature.title} className={`landing-feature-card rounded-2xl border border-border bg-card/55 p-5 ${index >= 3 ? 'lg:col-span-1' : ''}`}>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary"><feature.icon className="h-5 w-5" /></span>
                <h3 className="mt-4 font-bold">{feature.title}</h3>
                <p className="mt-2 min-h-14 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                <div className="mt-4">{feature.preview}</div>
              </article>
            ))}
            <article className="rounded-2xl border border-primary/25 bg-primary/[0.08] p-5 md:col-span-2 lg:col-span-1">
              <ShieldCheck className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-bold">Administrator権限は不要</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">NuviloChan Botは、分析に必要な範囲の権限だけで導入できます。Discordの「管理者」権限を付与する必要はありません。</p>
              <a href="/docs" className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-primary hover:underline">必要な権限を確認する <ArrowRight className="h-4 w-4" /></a>
            </article>
          </div>
        </div>

        <div id="thirty-second-demo" className="mt-24 scroll-mt-24 overflow-hidden rounded-3xl border border-border bg-card/65 shadow-2xl shadow-black/20">
          <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
            <div className="p-7 sm:p-10">
              <p className="text-xs font-bold tracking-[0.2em] text-primary">30 SECOND DEMO</p>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight">30秒で見るNuviloView</h2>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">4つの画面を7.5秒ずつ自動で紹介します。下の項目を押して好きな場面へ移動できます。</p>
              <div className="mt-7 space-y-2">
                {demoSteps.map((item, index) => (
                  <button key={item.title} onClick={() => setStep(index)} className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${step === index ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-secondary'}`}>
                    <span className="text-[10px] font-bold tracking-widest text-primary">{item.eyebrow}</span>
                    <span className="mt-1 block text-sm font-bold">{item.title}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="relative min-h-[430px] overflow-hidden border-t border-border bg-background/70 p-7 sm:p-10 lg:border-l lg:border-t-0">
              <div className="absolute inset-x-0 top-0 h-1 bg-secondary"><div key={step} className="landing-demo-progress h-full bg-primary" /></div>
              <div className="flex h-full flex-col justify-between">
                <div>
                  <span className="text-xs font-bold tracking-widest text-primary">{current.eyebrow}</span>
                  <h3 className="mt-3 text-2xl font-extrabold">{current.title}</h3>
                  <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{current.body}</p>
                </div>
                <div key={`metric-${step}`} className="landing-demo-card mt-10 rounded-3xl border border-primary/25 bg-gradient-to-br from-primary/20 via-card to-card p-7">
                  <div className="flex items-start justify-between gap-4">
                    <div><p className="text-xs font-bold text-muted-foreground">{current.label}</p><p className="mt-3 text-5xl font-black tracking-tight">{current.metric}</p></div>
                    <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-400">{current.accent}</span>
                  </div>
                  <div className="mt-7 flex h-24 items-end gap-2">
                    {[34, 48, 39, 66, 57, 76, 61, 88, 72, 94].map((height, index) => <span key={index} className="flex-1 rounded-t bg-primary/25" style={{ height: `${height}%`, backgroundColor: index === 9 ? 'var(--primary)' : undefined }} />)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function DesktopDashboardPreview() {
  const metrics = [
    ['総メンバー', '2,846', '+124'],
    ['アクティブ', '691', '+18%'],
    ['総送信数', '12,480', '+22%'],
    ['リアクション率', '8.4%', '+1.2pt'],
  ]
  return (
    <figure>
      <div role="img" aria-label="架空サーバーのPC版ダッシュボード画面" className="overflow-hidden rounded-2xl border border-border bg-[#0c0c12] shadow-2xl shadow-black/40">
        <div className="flex h-9 items-center gap-1.5 border-b border-white/10 px-4"><span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" /><span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" /><span className="ml-3 text-[10px] text-white/35">nuviloview-oem.vercel.app/dashboard</span></div>
        <div className="grid min-h-[440px] grid-cols-[150px_1fr]">
          <div className="border-r border-white/10 bg-white/[0.025] p-3">
            <div className="flex items-center gap-2 text-[11px] font-black"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">☕</span>NuviloView:<span className="-ml-2 text-primary">OEM</span></div>
            <div className="mt-7 rounded-lg border border-white/10 bg-white/[0.04] p-2"><p className="truncate text-[10px] font-bold">🌙 Lunaria Lounge</p><p className="mt-1 text-[8px] text-white/40">2,846 メンバー</p></div>
            <div className="mt-6 space-y-1 text-[9px] text-white/45"><p className="rounded-md bg-primary/15 px-2 py-2 font-bold text-white">▦ ダッシュボード</p><p className="px-2 py-2">✦ 成長インサイト</p><p className="px-2 py-2">⚙ 設定</p></div>
          </div>
          <div className="p-5">
            <div className="flex items-end justify-between"><div><p className="text-[9px] font-bold text-primary">OVERVIEW</p><h3 className="mt-1 text-base font-black">おかえりなさい、Mikaさん</h3></div><span className="rounded-md border border-white/10 px-2 py-1 text-[8px] text-white/45">過去14日間⌄</span></div>
            <div className="mt-4 grid grid-cols-4 gap-2">{metrics.map(([label, value, change]) => <div key={label} className="rounded-lg border border-white/10 bg-white/[0.035] p-2.5"><p className="text-[8px] text-white/40">{label}</p><p className="mt-1 text-sm font-black">{value}</p><p className="mt-1 text-[7px] font-bold text-emerald-400">{change}</p></div>)}</div>
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] p-3"><div className="flex justify-between"><div><p className="text-[9px] font-bold">メッセージ推移</p><p className="text-[7px] text-white/35">前期間と比較</p></div><TrendingUp className="h-4 w-4 text-primary" /></div><svg viewBox="0 0 500 120" className="mt-2 w-full" aria-hidden="true"><defs><linearGradient id="desktop-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity=".35"/><stop offset="100%" stopColor="var(--primary)" stopOpacity="0"/></linearGradient></defs><path d="M0 100 L0 88 L55 77 L110 82 L165 56 L220 63 L275 34 L330 47 L385 22 L440 39 L500 15 L500 100 Z" fill="url(#desktop-area)"/><path className="showcase-chart-line" pathLength="1" d="M0 88 L55 77 L110 82 L165 56 L220 63 L275 34 L330 47 L385 22 L440 39 L500 15" fill="none" stroke="var(--primary)" strokeWidth="3" strokeLinecap="round"/></svg></div>
            <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-lg border border-white/10 p-3"><p className="text-[9px] font-bold">サーバーヘルス</p><p className="mt-2 text-lg font-black text-emerald-400">92 <span className="text-[8px] text-white/35">/ 100</span></p></div><div className="rounded-lg border border-white/10 p-3"><p className="text-[9px] font-bold">今日のインサイト</p><p className="mt-2 text-[8px] leading-relaxed text-white/45">#雑談 の会話が前期間より38%増えています。</p></div></div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>PC版ダッシュボード</span><span className="rounded-full border border-border px-2 py-1">サンプルデータ</span></figcaption>
    </figure>
  )
}

function MobileDashboardPreview() {
  return (
    <figure className="mx-auto w-full max-w-[280px]">
      <div role="img" aria-label="架空サーバーのスマホ版ダッシュボード画面" className="overflow-hidden rounded-[32px] border-4 border-[#272733] bg-[#0c0c12] p-3 shadow-2xl shadow-black/45">
        <div className="mx-auto mb-4 h-1.5 w-20 rounded-full bg-white/15" />
        <div className="flex items-center justify-between"><p className="text-xs font-black">NuviloView:<span className="text-primary">OEM</span></p><span className="h-6 w-6 rounded-full bg-gradient-to-br from-pink-300 to-violet-500" /></div>
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] p-3"><p className="text-[9px] text-white/40">選択中のサーバー</p><p className="mt-1 text-xs font-bold">🌙 Lunaria Lounge</p></div>
        <div className="mt-3 flex items-end justify-between"><div><p className="text-[8px] font-bold text-primary">TODAY</p><h3 className="mt-1 text-sm font-black">概要</h3></div><span className="text-[8px] text-white/35">過去14日間⌄</span></div>
        <div className="mt-3 grid grid-cols-2 gap-2"><MiniMetric icon={<Users />} label="メンバー" value="2,846" /><MiniMetric icon={<MessageSquareText />} label="今日の送信" value="842" /><MiniMetric icon={<Activity />} label="アクティブ" value="691" /><MiniMetric icon={<Clock3 />} label="通話時間" value="182h" /></div>
        <div className="mt-3 rounded-xl border border-white/10 p-3"><div className="flex items-center justify-between text-[9px] font-bold"><span>アクティビティ</span><span className="text-primary">LIVE</span></div><div className="mt-3 space-y-2"><ActivityRow icon={<Hash />} text="#雑談で会話が増加" /><ActivityRow icon={<Heart />} text="リアクション 8.4%" /></div></div>
        <div className="mt-4 flex justify-around border-t border-white/10 pt-3 text-[8px] text-white/40"><span className="text-primary">▦ 概要</span><span>✦ 分析</span><span>⚙ 設定</span></div>
        <div className="mx-auto mt-4 h-1 w-20 rounded-full bg-white/25" />
      </div>
      <figcaption className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>スマホ版</span><span className="rounded-full border border-border px-2 py-1">レスポンシブ</span></figcaption>
    </figure>
  )
}

function MiniMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-lg border border-white/10 bg-white/[0.025] p-2.5"><span className="block h-3 w-3 text-primary [&>svg]:h-3 [&>svg]:w-3">{icon}</span><p className="mt-2 text-[7px] text-white/40">{label}</p><p className="mt-1 text-sm font-black">{value}</p></div>
}

function ActivityRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="flex items-center gap-2 rounded-lg bg-white/[0.035] p-2 text-[8px] text-white/55"><span className="text-primary [&>svg]:h-3 [&>svg]:w-3">{icon}</span>{text}</div>
}
