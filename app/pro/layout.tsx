import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'NuviloView Pro',
  description: 'NuviloView Proのプレビューシェルです。現在、課金・決済機能はありません。',
  robots: {
    index: false,
    follow: false,
  },
}

export default function ProLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}
