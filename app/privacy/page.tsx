import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-3xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">PRIVACY POLICY</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">プライバシーポリシー</h1>
        <p className="mt-3 text-sm text-muted-foreground">最終更新日：2026年7月15日</p>
        <div className="mt-10 space-y-8 text-sm leading-7 text-muted-foreground">
          <PolicySection title="1. 取得する情報"><p>本サービスは、Discord OAuthによるユーザーの基本情報（DiscordユーザーID、表示名、アイコンおよびメールアドレス）、管理可能なサーバー情報、およびBotを導入したサーバー内のメンバー数・投稿数・リアクション・参加退出・発言者数を取得します。Botはサーバー単位の通話開始・終了と通話時間、分析対象チャンネルの読み取り権限状態も記録します。検索機能のため、Botが閲覧できるチャンネルのメッセージ本文、投稿者表示名、チャンネル名、投稿日時を保存します。音声の内容は取得・保存しません。</p></PolicySection>
          <PolicySection title="2. 利用目的"><p>取得した情報は、ダッシュボードの分析・ライブ更新表示、サーバー内検索、Bot接続状態および権限不足の案内、お問い合わせ対応およびサービス改善のために利用します。</p></PolicySection>
          <PolicySection title="3. 保存期間と削除"><p>検索用に保存するメッセージ本文は、原則として最大90日間保存します。Botが削除イベントを受信したメッセージは保存データからも削除します。Botをサーバーから退出させると以後の新規収集は停止しますが、既存データは自動削除されません。削除をご希望の場合はサポートページからお問い合わせください。Discord側の権限設定やBot停止状況により、反映に時間がかかる場合があります。</p></PolicySection>
          <PolicySection title="4. 第三者提供・保管・運営者アクセス"><p>本サービスは、Discord、VercelおよびNeonなどのインフラ提供事業者を利用して情報を保管・処理します。右クリック翻訳機能は、Botを稼働しているPC上のLibreTranslateで処理します。選択中のメッセージ本文は翻訳処理のため最大5分間だけBotメモリに保持され、その後破棄されます。翻訳元の本文および翻訳結果はNuviloViewのデータベースに保存せず、処理枠管理のため月ごとの翻訳文字数合計だけを記録します。運営者は、セキュリティ対応、不正利用の調査、お問い合わせ対応、障害対応およびサービス運営に必要な範囲で、保存された情報にアクセスする場合があります。法令に基づく場合を除き、取得した情報を販売しません。</p></PolicySection>
          <PolicySection title="5. 利用者の選択"><p>サーバー管理者はBotをサーバーから退出させることで新規収集を停止できます。データに関するお問い合わせは、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご連絡ください。</p></PolicySection>
          <PolicySection title="6. 改定"><p>本ポリシーは必要に応じて改定します。重要な変更がある場合は、本サービス上で告知します。</p></PolicySection>
        </div>
      </section>
      <SiteFooter />
    </main>
  )
}

function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="mb-2 text-base font-bold text-foreground">{title}</h2>{children}</section>
}
