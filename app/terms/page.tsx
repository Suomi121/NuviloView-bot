import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-3xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">TERMS OF SERVICE</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">利用規約</h1>
        <p className="mt-3 text-sm text-muted-foreground">最終更新日：2026年7月18日</p>
        <div className="mt-10 space-y-8 text-sm leading-7 text-muted-foreground">
          <TermsSection title="1. 適用">
            <p>本規約は、NuviloView:OEMおよびNuviloChan Bot（以下「本サービス」）の利用条件を定めるものです。本サービスを利用した時点で、本規約およびプライバシーポリシーに同意したものとみなします。本サービスはDiscord公式の提供・提携・承認サービスではありません。</p>
          </TermsSection>
          <TermsSection title="2. サービス内容">
            <p>本サービスは、Discordコミュニティの運営を支援するため、Botが取得したメンバー数、メッセージ数、リアクション、通話時間、参加・退出、チャンネル権限状態および検索機能用のメッセージ本文などを集計・分析・表示します。翻訳、レポート出力、通知、目標管理その他の補助機能を提供する場合があります。</p>
          </TermsSection>
          <TermsSection title="3. アカウントと利用資格">
            <p>利用者は、Discordの利用条件および年齢要件を満たし、正確なアカウント情報を利用するものとします。利用者は自身のアカウント、セッションおよび端末を適切に管理し、不正利用を発見した場合は速やかにサポートへ連絡してください。</p>
          </TermsSection>
          <TermsSection title="4. サーバー管理者の責任">
            <p>Botを導入し、またはダッシュボードからサーバー情報を取り扱う利用者は、当該サーバーを管理する正当な権限を有するものとします。メッセージ本文の保存、活動状況の分析および翻訳機能を利用する場合、サーバーのルールや案内に本サービスの利用と収集範囲を記載するなど、メンバーへの必要な通知・同意取得を利用者の責任で行ってください。</p>
          </TermsSection>
          <TermsSection title="5. 投稿データ等の取扱い">
            <p>メッセージその他の投稿内容に関する権利は、投稿者または正当な権利者に留保されます。利用者は、本サービスの提供、保守、セキュリティ対策および障害対応に必要な範囲で、当該データを処理することを許諾するものとします。利用者は、第三者の個人情報、秘密情報または権利を侵害する情報の取扱いに十分注意してください。</p>
          </TermsSection>
          <TermsSection title="6. 禁止事項">
            <ul className="list-disc space-y-1 pl-5">
              <li>法令、Discordの利用規約または公序良俗に反する行為</li>
              <li>権限のないサーバーやアカウントへのアクセス、なりすまし、不正な認証回避</li>
              <li>本サービス、Bot、API、データベースへの攻撃、過剰な自動アクセス、解析または妨害</li>
              <li>取得データの無断販売、監視・嫌がらせ目的の利用、第三者の権利侵害</li>
              <li>Botトークン、APIキーその他の秘密情報を公開または不正利用する行為</li>
              <li>その他、運営者が本サービスの安全な運営を妨げると合理的に判断する行為</li>
            </ul>
          </TermsSection>
          <TermsSection title="7. 利用停止・サーバーブロック">
            <p>規約違反、不正利用、セキュリティ上の危険、第三者への重大な影響またはサービス運営上の必要がある場合、事前の通知なくアカウントまたは特定サーバーからの利用を制限・停止することがあります。緊急時にはBotのイベント処理およびコマンドを停止する場合があります。</p>
          </TermsSection>
          <TermsSection title="8. データの正確性と可用性">
            <p>本サービスは継続的な提供に努めますが、表示される分析値は運営判断を補助する参考情報であり、完全性、正確性、特定目的への適合性または継続的な提供を保証しません。Bot停止、Discord API、権限設定、通信障害、保守その他の理由により、記録・検索・翻訳・ライブ表示が遅延または欠落する場合があります。</p>
          </TermsSection>
          <TermsSection title="9. 外部サービス・知的財産権">
            <p>Discord、Vercel、Neon、Google、LibreTranslateその他の外部サービスには、各提供者の規約が適用されます。本サービスの名称、画面、文章、プログラムその他の構成要素に関する権利は、運営者または正当な権利者に帰属します。Discordの名称、商標および各サーバーのコンテンツは、それぞれの権利者に帰属します。</p>
          </TermsSection>
          <TermsSection title="10. 変更・保守・終了">
            <p>機能追加、法令対応、セキュリティ対策または運営上の必要に応じ、本サービスの全部または一部を変更、保守停止または終了することがあります。利用者に大きな影響がある場合は、可能な範囲で本サービス上に案内します。</p>
          </TermsSection>
          <TermsSection title="11. 免責・責任の制限">
            <p>運営者の故意または重大な過失がある場合その他法令により制限できない場合を除き、本サービスの利用または利用不能、データの欠落、外部サービスの障害その他本サービスに関連して生じた間接的・付随的な損害について、法令上認められる範囲で責任を負いません。</p>
          </TermsSection>
          <TermsSection title="12. 規約の改定・準拠法">
            <p>本規約は必要に応じて改定します。重要な変更は本サービス上で告知し、改定後に利用を継続した場合は変更後の規約に同意したものとみなします。本規約は日本法に準拠し、紛争が生じた場合は法令の定めに従う管轄裁判所で解決するものとします。</p>
          </TermsSection>
          <TermsSection title="13. お問い合わせ">
            <p>本規約や本サービスに関するお問い合わせは、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご連絡ください。</p>
          </TermsSection>
        </div>
      </section>
      <SiteFooter />
    </main>
  )
}

function TermsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="mb-2 text-base font-bold text-foreground">{title}</h2>{children}</section>
}
