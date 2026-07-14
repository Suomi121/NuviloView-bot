import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto max-w-3xl px-6 pb-24 pt-32">
        <p className="text-sm font-bold tracking-widest text-primary">TERMS OF SERVICE</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight">利用規約</h1>
        <p className="mt-3 text-sm text-muted-foreground">最終更新日：2026年7月14日</p>
        <div className="mt-10 space-y-8 text-sm leading-7 text-muted-foreground">
          <TermsSection title="1. 適用"><p>本規約は、NuviloView:OEMおよびNuviloChan Bot（以下「本サービス」）の利用条件を定めるものです。本サービスを利用した時点で、本規約とプライバシーポリシーに同意したものとみなします。</p></TermsSection>
          <TermsSection title="2. サービス内容"><p>本サービスは、Discordコミュニティの運営を支援するため、Botが取得したメンバー数、メッセージ数、リアクション、アクティビティおよび検索機能用のメッセージ本文を分析・表示します。</p></TermsSection>
          <TermsSection title="3. 利用者の責任"><p>利用者は、Botを導入するサーバーの管理権限を有し、サーバーメンバーに対して必要な通知や同意取得を行う責任を負います。法令またはDiscordの規約に反する利用、不正アクセス、サービス運営を妨げる行為を禁止します。</p></TermsSection>
          <TermsSection title="4. データと可用性"><p>本サービスは継続的な提供に努めますが、データの完全性、正確性、継続的な提供を保証するものではありません。Bot停止、Discord API、通信障害その他の理由により、記録や表示が遅延・欠落する場合があります。</p></TermsSection>
          <TermsSection title="5. 免責・変更"><p>本サービスの利用によって生じた損害について、法令上認められる範囲で責任を負いません。本サービスまたは本規約は、必要に応じて変更・停止することがあります。</p></TermsSection>
          <TermsSection title="6. お問い合わせ"><p>本規約や本サービスに関するお問い合わせは、<a className="font-semibold text-primary hover:underline" href="/support">サポートページ</a>からご連絡ください。</p></TermsSection>
        </div>
      </section>
      <SiteFooter />
    </main>
  )
}

function TermsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="mb-2 text-base font-bold text-foreground">{title}</h2>{children}</section>
}
