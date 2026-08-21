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
        <p className="mt-3 text-sm text-muted-foreground">最終更新日：2026年8月14日</p>
        <div className="mt-10 space-y-8 text-sm leading-7 text-muted-foreground">
          <PolicySection title="1. 運営者と適用範囲">
            <p>NuviloView:OEM運営者（以下「運営者」）は、本サービスで取り扱う情報を本ポリシーに従って管理します。本ポリシーはNuviloView:OEM、NuviloChan Bot、サポートフォームおよび関連機能に適用されます。本サービスはDiscord公式の提供・提携サービスではありません。</p>
            <p className="mt-3">個人情報取扱事業者の氏名または名称、住所、および法人の場合の代表者名について確認を希望する場合は、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご請求ください。法令に従い、本人が確認できる方法で遅滞なく回答します。</p>
          </PolicySection>
          <PolicySection title="2. 取得する情報">
            <ul className="list-disc space-y-2 pl-5">
              <li><strong className="text-foreground">アカウント・認証情報：</strong>DiscordユーザーID、表示名、アイコン、管理可能なサーバー情報、セッション情報、およびDiscord連携の維持に必要なアクセストークン・リフレッシュトークン等</li>
              <li><strong className="text-foreground">サーバー活動情報：</strong>サーバー名・ID・アイコン・所有者ID、メンバー数、投稿数、リアクション数、参加・退出時の表示名、日別の発言者Discord ID、チャンネル名・IDおよびBotの読み取り権限状態。個々のリアクション内容やリアクションした利用者は保存せず、件数だけを集計します</li>
              <li><strong className="text-foreground">通話接続情報：</strong>通話時間の集計に必要な参加者のDiscord ID、チャンネルID、参加・退出時刻、およびサーバー内で人が通話していた時間</li>
              <li><strong className="text-foreground">検索用メッセージ情報：</strong>Botが閲覧できるチャンネルのメッセージ本文、投稿者のDiscord ID・表示名、チャンネル名、投稿日時およびメッセージID</li>
              <li><strong className="text-foreground">Snipe用の一時情報：</strong>直近に削除された最大10件のメッセージ本文、投稿者、削除日時、およびDiscord監査ログで確認できた削除実行者を、対象チャンネルごとにBotメモリ上で最大3日間保持</li>
              <li><strong className="text-foreground">設定・運営情報：</strong>言語、タイムゾーン、サーバー別テーマ、成長目標、通知、履歴取込の依頼者・範囲・進捗、管理操作ログ、およびモデレーションの実行者・対象・理由・件数・成否</li>
              <li><strong className="text-foreground">運営者向け管理情報：</strong>機能の有効・無効、保護対象や許可対象のID、実行計画・確認・結果・エラー等の操作履歴、および必要な場合に作成するサーバー構成のバックアップ（チャンネル、ロール、権限、主要設定等）</li>
              <li><strong className="text-foreground">Nuke Protection情報：</strong>DiscordユーザーID、サーバーID、監査ログエントリID、管理操作の種類、対象ID、発生日時、危険度、インシデント状態、許可対象ID、および復元プレビュー用のチャンネル・ロール・権限構成スナップショット。Webhook Token、Bot Token、Credential、メッセージ本文はこの機能のためには保存しません</li>
              <li><strong className="text-foreground">技術・問い合わせ情報：</strong>IPアドレス、ユーザーエージェント、アクセス・エラーログ、レート制限用にハッシュ化した識別子・時刻・回数、お名前、返信先メールアドレスおよびお問い合わせ内容</li>
            </ul>
            <p className="mt-3">Discord OAuthではメールアドレスの権限を要求せず、Discordに登録されたメールアドレスは取得・保存しません。認証基盤の内部互換性のため、DiscordユーザーIDから生成した送信不能な識別子（<code className="rounded bg-secondary px-1 py-0.5 text-xs text-foreground">@users.invalid</code>）を保存します。サポートフォームで利用者が自ら入力した返信先メールアドレスは、お問い合わせ対応のためにのみ使用します。</p>
            <p className="mt-3">DMの本文、音声通話の音声、映像、画面共有、添付ファイル本体、埋め込みおよびスタンプの内容は保存しません。</p>
          </PolicySection>
          <PolicySection title="3. 利用目的">
            <ul className="list-disc space-y-1 pl-5">
              <li>本人確認、Discord OAuth連携およびログイン状態の維持</li>
              <li>ダッシュボードの分析、ライブ更新、レポート出力、目標・テーマ設定</li>
              <li>サーバー内検索、翻訳、通知、Bot接続・権限不足の案内</li>
              <li>権限を持つサーバー運営者による個別BAN、Kick、Timeout、BAN解除、メッセージ整理、自動スパム検知およびその監査</li>
              <li>短時間に発生した破壊的なサーバー管理操作の検知、危険度評価、通知、証拠保全、管理者による手動封じ込め、および構造復元プレビュー</li>
              <li>サービスの安全管理、品質維持および安定した運用</li>
              <li>お問い合わせへの回答、重要なお知らせおよびサービス改善</li>
              <li>利用状況の把握および広告配信。ただしメッセージ本文を広告目的で販売・提供しません</li>
            </ul>
            <p className="mt-3">Discord APIから取得したユーザー・サーバー情報やメッセージ本文は、広告のターゲティング、データブローカーへの提供・販売、またはAI・機械学習モデルの学習には使用しません。広告・アクセス解析事業者へは、広告表示やサイト利用状況の把握に必要な端末・閲覧情報だけが送信される場合があります。</p>
          </PolicySection>
          <PolicySection title="4. 取得方法と閲覧範囲">
            <p>アカウント情報はDiscord OAuthの<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs text-foreground">identify</code>および<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs text-foreground">guilds</code>権限を通じて取得し、サーバー活動情報はBotが付与された権限の範囲で取得します。ダッシュボードには、Discord上で所有または管理権限を持つと確認できたサーバーを表示します。サーバー管理者は、メンバーに対して本サービスの導入と収集範囲を適切に案内してください。</p>
            <p className="mt-3">zx?snipeの結果はコマンドを実行したチャンネルへ投稿され、そのチャンネルを閲覧できるメンバーは削除本文、投稿者および確認できた削除実行者等を閲覧できます。結果メッセージの削除操作は、コマンド実行者、サーバー所有者またはAdministratorに限定します。翻訳結果はコマンド実行者だけに表示します。</p>
            <p className="mt-3">サービスの安定運用、サポートおよび安全管理のため、権限を限定した運営者向け管理機能を使用する場合があります。必要な範囲でBotがアクセスできる情報を一時的に表示する場合がありますが、一時表示したメッセージ本文や添付内容を管理機能のDB・監査ログへ追加保存しません。管理設定、操作履歴および構成バックアップの閲覧は許可された運営者に限定し、アクセス制御や操作記録などの安全管理措置を講じます。</p>
          </PolicySection>
          <PolicySection title="5. 保存期間と削除">
            <p>検索用に保存するメッセージ本文は原則として最大90日間保存し、保存期間を過ぎたデータは順次削除します。履歴取り込みで取得した本文にも同じ保存期間を適用します。Botが削除イベントを受信したメッセージは保存データから削除しますが、zx?snipeで直近最大10件の削除を確認するため、削除本文と関連情報をBotメモリ上に最大3日間だけ保持します。この一時情報はNeonDBへ追加保存しません。認証情報、設定、統計、監査ログおよび問い合わせ情報は、機能提供、法令対応、不正利用防止または紛争対応に必要な期間保存します。</p>
            <p className="mt-3">スパム判定用の送信時刻・件数は短時間だけBotメモリで処理し、判定用として本文を追加保存しません。Web APIのレート制限記録はIPアドレスまたはユーザーIDから生成したハッシュを用い、古い記録を7日経過後に順次削除します。ログインセッションの有効期間は原則7日間です。期限切れまたは利用目的を終えた一時情報は順次無効化・削除します。</p>
            <p className="mt-3">運営者向け管理機能の設定、監査ログおよび構成バックアップは、安全な運用、復元、法令対応または紛争対応に必要な期間保存し、目的を終えたものは削除します。確認コードは平文保存せずハッシュ化し、有効期限後は実行に使用できません。</p>
            <p className="mt-3">Nuke Protectionの解決済みインシデントと証拠は原則90日間保存します。構造スナップショットはGuildごとに原則最新7件かつ30日以内を保持し、処理済み操作リクエストは原則30日後に削除します。未解決のインシデントおよびSecurity監査記録は、対応と説明責任に必要な期間保持する場合があります。</p>
            <p className="mt-3">Botをサーバーから退出させると新規収集は停止しますが、既存データは直ちには自動削除されません。削除を希望する場合はサポートページからご連絡ください。本人またはサーバー管理権限の確認後、対応可能な範囲で削除します。</p>
          </PolicySection>
          <PolicySection title="6. 翻訳機能">
            <p>翻訳機能（右クリック翻訳および/translate）は、Botの稼働環境上のLibreTranslateで処理します。選択または入力した本文は翻訳処理のため最大5分間だけBotメモリに保持され、その後破棄されます。翻訳元本文と翻訳結果はNuviloViewのデータベースへ保存せず、処理枠管理のため月ごとの翻訳文字数合計のみ記録します。機械翻訳の正確性は保証されません。</p>
          </PolicySection>
          <PolicySection title="7. 外部委託・第三者提供・国外処理">
            <p>本サービスは、Discord（認証・Bot API）、Vercel（Webサイト配信・アクセス解析）、Neon（データベース）、Resend（サポートメール送信）、Google（広告）等のサービスを利用します。翻訳本文はBot稼働環境上のLibreTranslateで処理し、外部の翻訳APIへ送信しません。各事業者はサービス提供に必要な範囲で情報を処理し、日本国外の設備で処理・保管する場合があります。処理地域は各事業者の提供構成により変わる場合があり、各事業者による取扱いにはそれぞれのプライバシーポリシーが適用されます。</p>
            <p className="mt-3">法令に基づく場合、人の生命・財産の保護に必要な場合、または事業承継等に伴う場合を除き、本人の同意なく情報を目的外で第三者へ販売しません。</p>
          </PolicySection>
          <PolicySection title="8. Cookie・アクセス解析・広告">
            <p>本サービスはログイン状態の維持、セキュリティ、利用状況の把握および広告配信のため、Cookieまたは類似技術を利用します。公開ページではVercel AnalyticsおよびGoogle AdSense等が端末情報や閲覧情報を処理する場合があります。ブラウザでCookieを制限できますが、ログインなど一部機能が正常に動作しない場合があります。</p>
          </PolicySection>
          <PolicySection title="9. 安全管理措置">
            <p>運営者は、アクセス制御、認可確認、レート制限、秘密情報の分離、監査ログ、バックアップおよび脆弱性対応など、取り扱う情報の性質に応じた安全管理措置を講じます。ただし、インターネット上の送信・保存に完全な安全性を保証することはできません。</p>
          </PolicySection>
          <PolicySection title="10. 開示・訂正・削除等の請求">
            <p>ご自身に関する情報の開示、訂正、利用停止または削除を希望する場合は、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご連絡ください。なりすまし防止のため本人確認またはサーバー管理権限の確認を行い、法令および技術上対応可能な範囲で回答します。法令上保存が必要な情報や、第三者の権利に影響する情報は、請求どおりに対応できない場合があります。</p>
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
