import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Plus_Jakarta_Sans, Noto_Sans_JP } from 'next/font/google'
import Script from 'next/script'
import { LocaleProvider } from '@/components/locale-provider'
import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

const notoJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-noto-jp',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://nuviloview-oem.vercel.app'),
  title: 'NuviloView:OEM — コミュニティを、次のステージへ。',
  description:
    'サーバーのデータ分析と、独自のブランド化（OEM）を同時に実現するダッシュボード。高度なサーバー分析、OEM専用ダッシュボード、簡単OAuth2連携。',
  generator: 'v0.app',
  robots: {
    index: true,
    follow: true,
  },
  verification: {
    google: '40Eez6fPMhjcj4fYirxbArbyuJSQmC7R_fm7bmFHT_U',
  },
  other: {
    'google-adsense-account': 'ca-pub-8557241043423909',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#09090b',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja" className={`dark ${jakarta.variable} ${notoJP.variable}`}>
      <body className="bg-background font-sans antialiased">
        <LocaleProvider>{children}</LocaleProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
        {process.env.NODE_ENV === 'production' && (
          <Script
            async
            crossOrigin="anonymous"
            src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8557241043423909"
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  )
}
