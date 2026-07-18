import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-3xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">PRIVACY POLICY</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">プライバシーポリシー</h1>
        <p className="mt-3 text-sm text-muted-foreground">最終更新日：2026年7月18日</p>
        <div className="mt-10 space-y-8 text-sm leading-7 text-muted-foreground">
          <PolicySection title="1. 運営者と適用範囲">
            <p>NuviloView:OEM運営者（以下「運営者」）は、本サービスで取り扱う情報を本ポリシーに従って管理します。本ポリシーはNuviloView:OEM、NuviloChan Bot、サポートフォームおよび関連機能に適用されます。本サービスはDiscord公式の提供・提携サービスではありません。</p>
          </PolicySection>
          <PolicySection title="2. 取得する情報">
            <ul className="list-disc space-y-2 pl-5">
              <li><strong className="text-foreground">アカウント・認証情報：</strong>DiscordユーザーID、表示名、アイコン、管理可能なサーバー情報、セッション情報、およびDiscord連携の維持に必要なアクセストークン・リフレッシュトークン等</li>
              <li><strong className="text-foreground">サーバー活動情報：</strong>サーバー名・ID・アイコン、メンバー数、投稿数、リアクション、参加・退出、発言者数、通話開始・終了・通話時間、チャンネル名およびBotの読み取り権限状態</li>
              <li><strong className="text-foreground">検索用メッセージ情報：</strong>Botが閲覧できるチャンネルのメッセージ本文、投稿者のDiscord ID・表示名、チャンネル名、投稿日時およびメッセージID</li>
              <li><strong className="text-foreground">設定・運営情報：</strong>言語、タイムゾーン、サーバー別テーマ、成長目標、通知、履歴取込状況、管理操作ログ</li>
              <li><strong className="text-foreground">技術・問い合わせ情報：</strong>IPアドレス、ユーザーエージェント、アクセス・エラーログ、レート制限に必要な情報、お名前、返信先メールアドレスおよびお問い合わせ内容</li>
            </ul>
            <p className="mt-3">Discord OAuthではメールアドレスの権限を要求せず、Discordに登録されたメールアドレスは取得・保存しません。認証基盤の内部互換性のため、DiscordユーザーIDから生成した送信不能な識別子（<code className="rounded bg-secondary px-1 py-0.5 text-xs text-foreground">@users.invalid</code>）を保存します。サポートフォームで利用者が自ら入力した返信先メールアドレスは、お問い合わせ対応のためにのみ使用します。</p>
            <p className="mt-3">音声通話の内容、映像および画面共有の内容は取得・保存しません。</p>
          </PolicySection>
          <PolicySection title="3. 利用目的">
            <ul className="list-disc space-y-1 pl-5">
              <li>本人確認、Discord OAuth連携およびログイン状態の維持</li>
              <li>ダッシュボードの分析、ライブ更新、レポート出力、目標・テーマ設定</li>
              <li>サーバー内検索、翻訳、通知、Bot接続・権限不足の案内</li>
              <li>不正利用の防止、レート制限、監査、障害調査およびセキュリティ対応</li>
              <li>お問い合わせへの回答、重要なお知らせおよびサービス改善</li>
              <li>利用状況の把握および広告配信。ただしメッセージ本文を広告目的で販売・提供しません</li>
            </ul>
          </PolicySection>
          <PolicySection title="4. 取得方法と閲覧範囲">
            <p>アカウント情報はDiscord OAuthの<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs text-foreground">identify</code>および<code className="mx-1 rounded bg-secondary px-1 py-0.5 text-xs text-foreground">guilds</code>権限を通じて取得し、サーバー活動情報はBotが付与された権限の範囲で取得します。ダッシュボードには、Discord上で所有または管理権限を持つと確認できたサーバーを表示します。サーバー管理者は、メンバーに対して本サービスの導入と収集範囲を適切に案内してください。</p>
          </PolicySection>
          <PolicySection title="5. 保存期間と削除">
            <p>検索用に保存するメッセージ本文は原則として最大90日間保存し、保存期間を過ぎたデータは順次削除します。履歴取り込みで取得した本文にも同じ保存期間を適用します。Botが削除イベントを受信したメッセージは保存データからも削除します。認証情報、設定、統計、監査ログおよび問い合わせ情報は、機能提供、法令対応、不正利用防止または紛争対応に必要な期間保存します。</p>
            <p className="mt-3">Botをサーバーから退出させると新規収集は停止しますが、既存データは直ちには自動削除されません。削除を希望する場合はサポートページからご連絡ください。本人またはサーバー管理権限の確認後、対応可能な範囲で削除します。</p>
          </PolicySection>
          <PolicySection title="6. 翻訳機能">
            <p>右クリック翻訳機能は、Botの稼働環境上のLibreTranslateで処理します。選択したメッセージ本文は翻訳処理のため最大5分間だけBotメモリに保持され、その後破棄されます。翻訳元本文と翻訳結果はNuviloViewのデータベースへ保存せず、処理枠管理のため月ごとの翻訳文字数合計のみ記録します。機械翻訳の正確性は保証されません。</p>
          </PolicySection>
          <PolicySection title="7. 外部委託・第三者提供・国外処理">
            <p>本サービスは、Discord、Vercel、Neon、Resend、Googleその他のクラウド・認証・メール・広告・解析サービスを利用する場合があります。これらの事業者は、サービス提供に必要な範囲で情報を処理し、日本国外の設備で処理・保管する場合があります。各事業者による取扱いには、それぞれのプライバシーポリシーが適用されます。</p>
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
