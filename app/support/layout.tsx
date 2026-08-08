import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'サポート | NuviloView:OEM',
  description: 'NuviloView:OEMとNuviloChan Botに関するお問い合わせ窓口です。',
  alternates: {
    canonical: '/support',
  },
}

export default function SupportLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}
