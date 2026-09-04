import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'アカウント接続 — NuviloView:OEM',
  robots: {
    index: false,
    follow: false,
  },
}

export default function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}
