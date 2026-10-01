import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'プライバシーポリシー | NuviloView:OEM',
  description: 'NuviloView:OEMおよびNuviloChan Botにおける情報の取得、利用、保存、管理について説明します。',
  alternates: {
    canonical: '/privacy',
  },
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-3xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">PRIVACY POLICY</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">プライバシーポリシー</h1>
        <p className="mt-3 text-sm text-muted-foreground">最終更新日：2026年9月3日</p>
        <div className="mt-10 space-y-8 text-sm leading-7 text-muted-foreground">
          <PolicySection title="1. 運営者と適用範囲">
            <p>NuviloView:OEM運営者（以下「運営者」）は、本サービスで取り扱う情報を本ポリシーに従って管理します。本ポリシーはNuviloView:OEM、NuviloChan Bot、サポートフォームおよび関連機能に適用されます。本サービスはDiscord公式の提供・提携サービスではありません。</p>
            <p className="mt-3">個人情報取扱事業者の氏名または名称、住所、および法人の場合の代表者名について確認を希望する場合は、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご請求ください。法令に従い、本人が確認できる方法で遅滞なく回答します。</p>
          </PolicySection>
          <PolicySection title="2. 取得する情報">
            <ul className="list-disc space-y-2 pl-5">
              <li><strong className="text-foreground">アカウント・認証情報：</strong>DiscordユーザーID、表示名、アイコン、管理可能なサーバー情報、セッション情報、およびDiscord連携の維持に必要なアクセストークン・リフレッシュトークン等</li>
              <li><strong className="text-foreground">サーバー・チャンネル情報：</strong>サーバー名・ID・アイコン・所有者ID、メンバー数、チャンネル名・ID・種類、Botの読み取り権限状態、およびロールID・ロール変更等</li>
              <li><strong className="text-foreground">メッセージ情報：</strong>Botが閲覧できるサーバーチャンネルのメッセージ本文、メッセージID、投稿者のDiscord ID・表示名・ロールID、チャンネル名・ID、投稿・編集・削除時刻、イベント種別、および返信先を識別するためのID等。DMの本文は対象にしません</li>
              <li><strong className="text-foreground">リアクション情報：</strong>リアクションの追加・削除、絵文字、リアクションした利用者のDiscord ID、対象メッセージ・チャンネル・サーバーのID、対象投稿者のID、時刻、および集計に必要なロールID等</li>
              <li><strong className="text-foreground">通話接続情報：</strong>通話時間の集計に必要な参加者のDiscord ID・ロールID、チャンネルID、参加・移動・退出時刻、セッションID、継続時間、および障害復旧時の状態情報。音声そのものは取得しません</li>
              <li><strong className="text-foreground">メンバー活動情報：</strong>DiscordユーザーID、Botかどうか、参加・退出・ロール変更等のイベント、ロールID、参加・退出時刻、および現在の在籍状態</li>
              <li><strong className="text-foreground">履歴取り込み情報：</strong>権限を持つサーバー管理者が指定したチャンネルの過去メッセージ本文と上記メタデータ、取込範囲、進捗、カーソル、件数、依頼者およびジョブ状態</li>
              <li><strong className="text-foreground">分析・集計情報：</strong>投稿・リアクション・通話・参加退出等の件数、活動メンバー、継続時間、傾向、チャンネル・ユーザー別集計、週間インサイト、目標の進捗、更新時刻、スナップショットの版および整合性確認値</li>
              <li><strong className="text-foreground">Snipe用の一時情報：</strong>直近に削除された最大999,999件のメッセージ本文、投稿者、削除日時、およびDiscord監査ログで確認できた削除実行者を、対象チャンネルごとにBotメモリ上で最大90日間（約3か月）保持し、上限超過時は古い履歴から切り捨て</li>
              <li><strong className="text-foreground">設定・運営情報：</strong>言語、タイムゾーン、サーバー別テーマ、成長目標、通知、履歴取込の依頼者・範囲・進捗、管理操作ログ、およびモデレーションの実行者・対象・理由・件数・成否</li>
              <li><strong className="text-foreground">運営者向け管理情報：</strong>機能の有効・無効、保護対象や許可対象のID、実行計画・確認・結果・エラー等の操作履歴、および必要な場合に作成するサーバー構成のバックアップ（チャンネル、ロール、権限、主要設定等）</li>
              <li><strong className="text-foreground">廃止済みセキュリティ機能の履歴情報：</strong>過去の障害調査、説明責任およびロールバックに必要なDiscordユーザーID、サーバーID、監査ログエントリID、管理操作の種類・対象・発生日時、評価結果、対応状態、および当時保存されたサーバー構成情報。これらは新規収集せず、既存記録のみを隔離して保持します</li>
              <li><strong className="text-foreground">技術・問い合わせ情報：</strong>Bot・同期処理・ストレージの稼働状態と時刻、IPアドレス、ユーザーエージェント、アクセス・エラーログ、レート制限用にハッシュ化した識別子・時刻・回数、お名前、返信先メールアドレスおよびお問い合わせ内容</li>
            </ul>
            <p className="mt-3">Discord OAuthではメールアドレスの権限を要求せず、Discordに登録されたメールアドレスは取得・保存しません。認証基盤の内部互換性のため、DiscordユーザーIDから生成した送信不能な識別子（<code className="rounded bg-secondary px-1 py-0.5 text-xs text-foreground">@users.invalid</code>）を保存します。サポートフォームで利用者が自ら入力した返信先メールアドレスは、お問い合わせ対応のためにのみ使用します。</p>
            <p className="mt-3">DMの本文、音声通話の音声、映像、画面共有、添付ファイル本体、埋め込みおよびスタンプの内容は保存しません。</p>
          </PolicySection>
          <PolicySection title="3. 利用目的">
            <ul className="list-disc space-y-1 pl-5">
              <li>本人確認、Discord OAuth連携およびログイン状態の維持</li>
              <li>ダッシュボードの分析、集計スナップショットの作成・同期、レポート出力、目標・テーマ設定</li>
              <li>サーバー内検索、翻訳、通知、Bot接続・権限不足の案内</li>
              <li>権限を持つサーバー運営者による個別BAN、Kick、Timeout、BAN解除、メッセージ整理、自動スパム検知およびその監査</li>
              <li>サービスの安全管理、品質維持および安定した運用</li>
              <li>お問い合わせへの回答、重要なお知らせおよびサービス改善</li>
              <li>利用状況の把握および広告配信。ただしメッセージ本文を広告目的で販売・提供しません</li>
            </ul>
            <p className="mt-3">運営者は、Discord APIから取得したユーザー・サーバー情報やメッセージ本文を、広告プロファイルの作成、データブローカーへの提供・販売、またはAI・機械学習モデルの学習のために意図的に提供・使用しません。Webページ上で広告・アクセス解析事業者が処理する情報については、第8項をご確認ください。</p>
          </PolicySection>
          <PolicySection title="4. 取得方法と閲覧範囲">
            <p>アカウント情報はDiscord OAuthの<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs text-foreground">identify</code>および<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs text-foreground">guilds</code>権限を通じて取得し、サーバー活動情報はBotが付与された権限の範囲で取得します。ダッシュボードには、Discord上で所有または管理権限を持つと確認できたサーバーだけを表示します。サーバー管理者は、メンバーに対して本サービスの導入と収集範囲を適切に案内してください。</p>
            <p className="mt-3">通常の分析経路では、メッセージ・リアクション・通話・メンバー活動の個別イベントをBotの稼働環境にあるSQLiteへ保存して集計し、本文を含まない集計スナップショットをSupabaseおよびTursoへ同期します。これらの集計情報にはサーバー・チャンネル・ユーザーを区別するIDが含まれるため、完全に匿名化された情報ではありません。認証、設定、履歴取込の制御、サポート、モデレーション監査、旧経路の互換データ等は、目的に応じてクラウド側へ保存する場合があります。</p>
            <p className="mt-3">zx?snipeの結果はコマンドを実行したチャンネルへ投稿され、そのチャンネルを閲覧できるメンバーは削除本文、投稿者および確認できた削除実行者等を閲覧できます。結果メッセージの削除操作は、コマンド実行者、サーバー所有者またはAdministratorに限定します。翻訳結果はコマンド実行者だけに表示します。</p>
            <p className="mt-3">サービスの安定運用、サポートおよび安全管理のため、権限を限定した運営者向け管理機能を使用する場合があります。管理設定、操作履歴および構成バックアップの閲覧は許可された運営者に限定し、アクセス制御や操作記録などの安全管理措置を講じます。</p>
          </PolicySection>
          <PolicySection title="5. 保存期間と削除">
            <p>メッセージ・リアクション・通話・メンバー活動および履歴取り込みの個別イベントは、検索、再集計、データ整合性の確認およびサービス運用に必要な期間、Botのローカルストレージに保存します。現時点では、これらすべてに共通する90日以内の自動削除を保証する機能は本番運用されていません。一部の旧クラウド保存経路には90日を目安とする整理処理がありますが、ローカル保存データの保持期間を保証するものではありません。</p>
            <p className="mt-3">Botが削除イベントを受信したメッセージは、通常のメッセージ保存では本文を削除済みとして扱います。ただし、zx?snipeで直近最大999,999件の削除を確認するため、削除本文と関連情報をBotメモリ上に最大90日間（約3か月）保持します。上限を超えた場合は古い履歴から切り捨て、この一時情報はクラウドデータベースへ追加保存しません。認証情報、設定、集計、監査ログおよび問い合わせ情報は、機能提供、法令対応、不正利用防止または紛争対応に必要な期間保存します。</p>
            <p className="mt-3">スパム判定用の送信時刻・件数は短時間だけBotメモリで処理し、判定用として本文を追加保存しません。Web APIのレート制限記録はIPアドレスまたはユーザーIDから生成したハッシュを用い、古い記録を7日経過後に順次削除します。ログインセッションの有効期間は原則7日間です。期限切れまたは利用目的を終えた一時情報は順次無効化・削除します。</p>
            <p className="mt-3">運営者向け管理機能の設定、監査ログおよび構成バックアップは、安全な運用、復元、法令対応または紛争対応に必要な期間保存し、目的を終えたものは削除します。確認コードは平文保存せずハッシュ化し、有効期限後は実行に使用できません。</p>
            <p className="mt-3">廃止済みセキュリティ機能の既存記録は新規収集せず、過去の障害調査、説明責任、ロールバックまたは法令対応に必要な期間、Legacyデータとして隔離して保持する場合があります。</p>
            <p className="mt-3">Botをサーバーから退出させると新規収集は停止しますが、既存データは直ちには自動削除されません。履歴取り込みには、権限を持つサーバー管理者がジョブと取り込み済みデータの削除を依頼できる機能があります。その他のデータやアカウントの削除を希望する場合はサポートページからご連絡ください。本人またはサーバー管理権限の確認後、法令上の保存義務、第三者の権利および技術上の制約を確認し、対応可能な範囲で削除します。現時点では、利用者がWeb画面だけでアカウントと関連データの完全削除を開始・完了できる機能はありません。</p>
          </PolicySection>
          <PolicySection title="6. 翻訳機能">
            <p>翻訳機能（右クリック翻訳および/translate）は、Botの稼働環境上のLibreTranslateで処理します。選択または入力した本文は翻訳処理のため最大5分間だけBotメモリに保持され、その後破棄されます。翻訳元本文と翻訳結果はNuviloViewのデータベースへ保存せず、処理枠管理のため月ごとの翻訳文字数合計のみ記録します。機械翻訳の正確性は保証されません。</p>
          </PolicySection>
          <PolicySection title="7. 外部委託・第三者提供・国外処理">
            <p>本サービスは、Discord（認証・Bot API）、Vercel（Webサイト配信・アクセス解析）、Supabase（認証・設定・集計情報等の保存）、Turso（集計情報の同期先・障害時の読み取り先）、Neon（旧経路・互換機能のデータベース）、Resend（サポートメール送信）、Google（広告）等のサービスを利用します。メッセージ等の個別イベントは主としてBot稼働環境のSQLiteで処理し、通常の分析同期では本文を含まない集計スナップショットをSupabaseおよびTursoへ送信します。Neonは現在の主要な分析同期先ではありませんが、旧経路または一部の互換機能が利用する場合があります。</p>
            <p className="mt-3">翻訳本文はBot稼働環境上のLibreTranslateで処理し、外部の翻訳APIへ送信しません。各事業者はサービス提供に必要な範囲で情報を処理し、日本国外の設備で処理・保管する場合があります。処理地域は各事業者の提供構成により変わる場合があり、各事業者による取扱いにはそれぞれのプライバシーポリシーが適用されます。</p>
            <p className="mt-3">法令に基づく場合、人の生命・財産の保護に必要な場合、または事業承継等に伴う場合を除き、本人の同意なく情報を目的外で第三者へ販売しません。</p>
          </PolicySection>
          <PolicySection title="8. Cookie・アクセス解析・広告">
            <p>本サービスはログイン状態の維持、セキュリティ、利用状況の把握および広告配信のため、Cookieまたは類似技術を利用します。WebページではVercel Analyticsがページ、参照元、おおまかな地域、OS、ブラウザ、端末種別等を集計のために処理します。また、Google AdSenseの広告タグにより、Googleへ閲覧URL、IPアドレス、広告の表示・操作情報等が送信され、広告Cookieや端末・ブラウザを区別する識別子が使用される場合があります。Googleの設定や利用者の選択に応じて、他のサイト等で得た情報と組み合わせた広告のパーソナライズまたは広告効果測定に利用される場合があります。</p>
            <p className="mt-3">Googleによる広告情報の利用と設定変更については、<a className="font-semibold text-primary hover:underline" href="https://policies.google.com/technologies/partner-sites" rel="noreferrer" target="_blank">Googleサービスを利用するサイト等からの情報の利用</a>および<a className="font-semibold text-primary hover:underline" href="https://adssettings.google.com/" rel="noreferrer" target="_blank">広告設定</a>をご確認ください。ブラウザでCookieを制限できますが、ログインなど一部機能が正常に動作しない場合があります。</p>
          </PolicySection>
          <PolicySection title="9. 安全管理措置">
            <p>運営者は、アクセス制御、認可確認、レート制限、秘密情報の分離、監査ログ、バックアップおよび脆弱性対応など、取り扱う情報の性質に応じた安全管理措置を講じます。ただし、インターネット上の送信・保存に完全な安全性を保証することはできません。</p>
          </PolicySection>
          <PolicySection title="10. 開示・訂正・削除等の請求">
            <p>ご自身に関する情報の開示、訂正、利用停止または削除を希望する場合は、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご連絡ください。なりすまし防止のため本人確認またはサーバー管理権限の確認を行い、法令および技術上対応可能な範囲で回答します。法令上保存が必要な情報、第三者の権利に影響する情報、または複数利用者に関係するサーバー集計は、請求どおりに対応できない場合があります。アカウント削除は現在サポートへの申請が必要であり、アプリ内の自己操作だけで完結しません。</p>
          </PolicySection>
          <PolicySection title="11. 年齢要件">
            <p>Discordが定める年齢要件を満たさない方は本サービスを利用しないでください。サーバー管理者は、参加者の年齢や地域に応じて必要な案内・同意を行う責任を負います。</p>
          </PolicySection>
          <PolicySection title="12. 漏えい等への対応">
            <p>情報の漏えい、滅失または毀損などが発生し、利用者への影響が大きいと判断した場合、原因調査、拡大防止および必要な通知・報告を法令に従って行います。</p>
          </PolicySection>
          <PolicySection title="13. 改定・お問い合わせ">
            <p>本ポリシーは機能追加や法令変更に応じて改定します。重要な変更がある場合は本サービス上で告知します。情報の取扱いに関するお問い合わせは、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご連絡ください。</p>
          </PolicySection>
        </div>
      </section>
      <SiteFooter />
    </main>
  )
}

function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="mb-2 text-base font-bold text-foreground">{title}</h2>{children}</section>
}
