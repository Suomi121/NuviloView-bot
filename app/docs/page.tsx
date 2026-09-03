import { Bot, CheckCircle2, Database, HelpCircle, ShieldCheck } from 'lucide-react'
import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'ドキュメント | NuviloView:OEM',
  description:
    'NuviloView:OEMとNuviloChan Botの導入方法、必要な権限、保存データ、コマンドについて確認できます。',
  alternates: {
    canonical: '/docs',
  },
}

const steps = [
  { icon: ShieldCheck, title: '1. Discordでログイン', text: '管理権限を持つDiscordアカウントでログインします。ダッシュボードには、あなたが管理できるサーバーだけが表示されます。' },
  { icon: Bot, title: '2. Botをサーバーへ追加', text: 'トップページの「Botを追加」から、分析したいサーバーを選択します。導入できるのは、Botを追加する権限を持つ人だけです。' },
  { icon: Database, title: '3. データを確認', text: 'NuviloChan Botがサーバー内のイベントを集計します。ダッシュボードを開いている間は60秒ごとに集計表示が更新され、導入直後の最初の記録もそのまま反映されます。' },
]

const faqs = [
  ['誰がダッシュボードを見られますか？', 'Discord上でそのサーバーの所有者、またはサーバー管理権限を持つ利用者だけが閲覧できます。ログインしただけでは、他人のサーバー情報は見られません。'],
  ['BotにAdministrator権限は必要ですか？', '必要ありません。分析用のチャンネル閲覧・履歴閲覧に加え、通知用のメッセージ送信・埋め込みリンク、削除者確認用の監査ログ閲覧、セキュリティ機能用のメッセージ管理、Kick、BAN、メンバーのタイムアウト権限だけを要求します。ロール・チャンネルの作成や全削除などの権限は要求しません。'],
  ['何のデータを保存しますか？', 'メンバー数、参加・退出、メッセージ、リアクション、発言者、通話時間に関する個別イベントをBotのローカルストレージで処理し、本文を含まない集計情報をダッシュボードに使用します。メッセージ本文・送信者・送信日時は検索や再集計等のためにも保存します。現在、ローカル保存データすべてに共通する90日以内の自動削除は保証していません。'],
  ['メッセージ本文は誰でも検索できますか？', 'いいえ。検索できるのは、そのサーバーを管理できる利用者だけです。検索機能にはDiscordのMessage Content Intentを使用します。'],
  ['チャンネル権限の警告が出たら？', 'Botに「チャンネルを見る」と「メッセージ履歴を読む」の権限がないチャンネルがあります。そのチャンネルを分析対象にする場合は、Botロールまたはチャンネルごとの権限を見直してください。'],
  ['Botコマンドは何ができますか？', '/help で分析コマンドの一覧、/tactive で今日の活動、/week で直近7日間の要約、/suc で初期設定と権限、/permissions で読み取れないチャンネル、/dashboard で分析画面へのリンクを確認できます。セキュリティ機能は独立した r? コマンドとして、r?ban、r?unban、r?kick、r?timeout、r?untimeout、r?banlist、r?clear、r?ping、r?perm_check を利用できます。r?perm_checkでは、実行者とBotの権限を照合し、利用可能なセキュリティ機能を機能別に確認できます。娯楽機能のzx?help、zx?dice、zx?snipeは全メンバーが利用でき、Discordの候補欄に表示される/zxからもhelp、dice、snipeを選べます。zx?snipeは自分だけでなく、同じチャンネルで他メンバーや管理者が削除した投稿も最大90日（約3か月）・999,999件までカードと前後ボタンで表示し、削除者を確認できます。上限を超えた場合は古い履歴から切り捨てます。結果は実行者または管理者だけが削除できます。'],
  ['ダイスはどう使いますか？', 'zx?dice 10d、または/zx diceのdice欄に10dと入力するとロールリンクが表示されます。Discord標準対応のD4・D6・D8・D10・D12・D20は、リンクを押したユーザー本人の投稿として結果と再ロールボタンが生成され、過去の結果を上書きしません。Discord標準の対象外となる個数・面数はBotが従来形式で処理します。Bot形式では1回1〜50個、2〜1000面まで指定できます。'],
  ['自動スパム検知はどう動きますか？', '同一ユーザーまたはBotが5秒以内に3件のメッセージを送信すると検知し、既定5分間のタイムアウトを試行します。サーバー所有者と人間の管理・モデレーション権限保有者は自動処分しません。Administrator権限を持つ対象やDiscordの権限・ロール階層で操作できない対象は検知と監査のみ行います。サーバー所有者、Administrator、または対応権限を持つ運営者は、検知通知からタイムアウト解除・Kick・BANを選択できます。KickとBANには各権限と二段階確認が必要です。'],
  ['メッセージを翻訳できますか？', 'はい。/translate text:<本文> language:<翻訳先> で入力したテキストを翻訳できます。languageを省略すると国旗付きの言語一覧が表示されます。メッセージを右クリックして「アプリ」から「NuviloChan 翻訳」を選ぶ方法も引き続き利用できます。翻訳はBot用PC上のLibreTranslateで処理し、入力本文と翻訳結果は保存しません。月間60万文字の処理枠を超えると翌月まで停止します。'],
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
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Administrator権限を使わず、分析と各モデレーション操作に必要な個別権限だけで動作します。セキュリティコマンドは実行者の権限、Bot権限、対象者とのロール階層を毎回検証します。</p>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />チャンネルを閲覧し、メッセージ履歴を読み取る権限</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />メンバー数、リアクション、通話の開始・終了を集計するためのイベント</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />読み取れないチャンネルを検出するためのチャンネル権限の確認</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />zx?snipeでモデレーターによる削除者を確認するためのDiscord監査ログ閲覧</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />メッセージ管理・Kick・BANは対応する管理操作時に、タイムアウトは管理操作または自動スパム検知時に使用</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />ロール作成・チャンネル作成・全チャンネル削除・Administrator権限は不使用</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />BAN・Kick・メッセージ削除は明示的な確認と理由が必須。すべて監査ログへ記録</li>
          </ul>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">データ収集の範囲</h2>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />メンバー数・メッセージ数・リアクション数・発言者数</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />参加・退出・メッセージ送信のアクティビティと、サーバー内通話の合計・最長時間</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />Botの最終記録時刻と、読み取り権限が不足しているチャンネルの状態</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />検索・再集計等のため、メッセージ本文・送信者・送信日時をローカル保存（現在は一律90日以内の自動削除を保証していません）</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />モデレーションの実行者・対象・理由・件数・結果を監査ログとして保存</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />スパム判定はユーザー別の送信時刻と件数を短時間だけメモリ上で比較し、判定用に本文を追加保存しない</li>
            <li className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />zx?snipe用の最大999,999件の削除本文・投稿者・削除者は最大90日間（約3か月）Botメモリに保持し、上限超過時は古い履歴から切り捨て、クラウドデータベースへ追加保存しない</li>
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">詳しい取り扱いは<a className="text-primary underline" href="/privacy">プライバシーポリシー</a>をご確認ください。</p>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">テーマ設定</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">設定画面の「サーバー別テーマ」では、対象サーバーを明示的に選んでから、メインカラー・アクセントカラー・背景・カード背景・角丸・ロゴ画像を調整できます。テーマはログイン中のあなたの表示だけに保存され、同じサーバーの他の管理者やメンバーの画面を変更しません。サービス名（NuviloView:OEM）は固定です。</p>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card/55 p-6">
          <h2 className="font-bold">サービス運用のための管理機能</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">サービスを安定して提供するため、運営者向けの管理機能を設けています。接続状態や利用状況を確認し、必要に応じてサービスの提供範囲を調整できる仕組みです。</p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">管理機能へのアクセスは許可された運営者に限定され、重要な操作は適切に記録・管理されます。</p>
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
