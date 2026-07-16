import { Bot, CheckCircle2, Database, HelpCircle, ShieldCheck } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'

const steps = [
  { icon: ShieldCheck, title: '1. Discordでログイン', text: '管理権限を持つDiscordアカウントでログインします。ダッシュボードには、あなたが管理できるサーバーだけが表示されます。' },
  { icon: Bot, title: '2. Botをサーバーへ追加', text: 'トップページの「Botを追加」から、分析したいサーバーを選択します。導入できるのは、Botを追加する権限を持つ人だけです。' },
  { icon: Database, title: '3. データを確認', text: 'NuviloChan Botがサーバー内のイベントを集計します。ダッシュボードを開いている間は15秒ごとに自動更新され、導入直後の最初の記録もそのまま反映されます。' },
]

const faqs = [
  ['誰がダッシュボードを見られますか？', 'Discord上でそのサーバーの所有者、またはサーバー管理権限を持つ利用者だけが閲覧できます。ログインしただけでは、他人のサーバー情報は見られません。'],
  ['Botに管理者権限は必要ですか？', '必要ありません。NuviloChan Botの招待では、チャンネル閲覧とメッセージ履歴の閲覧のみを要求します。キック、BAN、ロール・チャンネルの作成や削除などの権限は要求・使用しません。'],
  ['何のデータを保存しますか？', 'メンバー数、参加・退出、メッセージ数、リアクション数、発言者数、サーバー単位の通話時間を分析に使用します。メッセージ検索のため、メッセージ本文・送信者・送信日時も最大90日間保存します。'],
  ['メッセージ本文は誰でも検索できますか？', 'いいえ。検索できるのは、そのサーバーを管理できる利用者だけです。検索機能にはDiscordのMessage Content Intentを使用します。'],
  ['チャンネル権限の警告が出たら？', 'Botに「チャンネルを見る」と「メッセージ履歴を読む」の権限がないチャンネルがあります。そのチャンネルを分析対象にする場合は、Botロールまたはチャンネルごとの権限を見直してください。'],
  ['Botコマンドは何ができますか？', '/help で一覧、/tactive で今日の活動、/week で直近7日間の要約、/suc で初期設定と権限、/permissions で読み取れないチャンネル、/dashboard で分析画面へのリンクを確認できます。/privacy は誰でも実行でき、その他はサーバー管理権限が必要です。'],
  ['メッセージを翻訳できますか？', 'はい。メッセージを右クリックして「アプリ」から「NuviloChan 翻訳」を選び、翻訳先を指定できます。主要言語は国旗付きで選択でき、その他の対応言語は一覧から選択できます。翻訳はBot用PC上のLibreTranslateで処理し、本文と翻訳結果は保存しません。月間60万文字の処理枠を超えると翌月まで停止します。'],
  ['Botを外すとどうなりますか？', '以後の新しいデータ収集は止まります。保存済みデータの削除をご希望の場合は、サーバー名を添えてサポートへお問い合わせください。'],
]

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-4xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">DOCUMENTATION</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">NuviloView:OEM を始める</h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">Botとダッシュボードを接続して、コミュニティの分析を始めるためのガイドです。NuviloView:OEMはDiscord公式の提供・提携サービスではありません。</p>

        <div className="mt-12 space-y-4">
          {steps.map((step) => (
            <article key={step.title} className="flex gap-5 rounded-2xl border border-border bg-card/55 p-6">
              <step.icon className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
              <div><h2 className="font-bold">{step.title}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p></div>
            </article>
          ))}
        </div>

        <section className="mt-10 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">Botの権限と安全性</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">分析に必要な最小限の権限だけで動作する設計です。管理者権限は不要で、サーバー設定を変更したり、メンバーを追放したりする機能はありません。</p>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />チャンネルを閲覧し、メッセージ履歴を読み取る権限</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />メンバー数、リアクション、通話の開始・終了を集計するためのイベント</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />読み取れないチャンネルを検出するためのチャンネル権限の確認</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />キック・BAN・ロール変更・チャンネル削除などの管理権限は不要</li>
          </ul>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">データ収集の範囲</h2>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />メンバー数・メッセージ数・リアクション数・発言者数</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />参加・退出・メッセージ送信のアクティビティと、サーバー内通話の合計・最長時間</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />Botの最終記録時刻と、読み取り権限が不足しているチャンネルの状態</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />検索機能のため、メッセージ本文・送信者・送信日時を最大90日間保存</li>
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">詳しい取り扱いは<a className="text-primary underline" href="/privacy">プライバシーポリシー</a>をご確認ください。</p>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">テーマ設定</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">設定画面の「サーバー別テーマ」では、対象サーバーを明示的に選んでから、メインカラー・アクセントカラー・背景・カード背景・角丸・ロゴ画像を調整できます。テーマはログイン中のあなたの表示だけに保存され、同じサーバーの他の管理者やメンバーの画面を変更しません。サービス名（NuviloView:OEM）は固定です。</p>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">Guildブロックと開発者管理画面</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">開発者専用のDeveloper Consoleでは、Botの導入先Guild、接続状態、最終生存記録、ブロック状態を確認できます。ブロック操作には理由入力と確認ダイアログが必要で、実行すると対象Guildの分析データを削除し、Botは退出します。解除後も自動再参加はしません。</p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">この画面と管理APIは、ログインセッションに結び付いたDiscord IDをサーバー側で照合し、登録済みの開発者IDと一致した場合のみ利用できます。ブロック・解除の記録は追記専用で、前の記録に連結した署名付き監査ログとして保存します。</p>
        </section>

        <section className="mt-10">
          <div className="flex items-center gap-2"><HelpCircle className="h-5 w-5 text-primary" /><h2 className="font-bold">よくある質問</h2></div>
          <div className="mt-4 space-y-3">
            {faqs.map(([question, answer]) => <article key={question} className="rounded-2xl border border-border bg-card/55 p-5"><h3 className="font-bold">{question}</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{answer}</p></article>)}
          </div>
        </section>
      </section>
      <SiteFooter />
    </main>
  )
}
