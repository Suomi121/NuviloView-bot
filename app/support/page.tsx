'use client'

import { LifeBuoy, LoaderCircle, Send } from 'lucide-react'
import { FormEvent, useState } from 'react'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'

export default function SupportPage() {
  const [status, setStatus] = useState('')
  const [sending, setSending] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSending(true); setStatus('')
    const form = new FormData(event.currentTarget)
    const response = await fetch('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) })
    setStatus(response.ok ? 'お問い合わせを受け付けました。' : '送信できませんでした。入力内容を確認してください。')
    if (response.ok) event.currentTarget.reset()
    setSending(false)
  }
  return <main className="min-h-screen bg-background text-foreground"><SiteHeader /><section className="mx-auto max-w-2xl px-6 pb-24 pt-32"><div className="rounded-2xl border border-border bg-card/60 p-6 shadow-2xl shadow-black/10 sm:p-8"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary"><LifeBuoy className="h-5 w-5" /></span><h1 className="mt-5 text-3xl font-extrabold tracking-tight">サポート</h1><p className="mt-3 text-sm leading-relaxed text-muted-foreground">Botの追加、表示設定、ダッシュボードについて困ったことがあればお知らせください。</p><form onSubmit={submit} className="mt-8 space-y-5"><label className="block text-sm font-bold">お名前<input required name="name" maxLength={100} className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 font-normal outline-none focus:border-primary" /></label><label className="block text-sm font-bold">メールアドレス<input required type="email" name="email" maxLength={254} className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 font-normal outline-none focus:border-primary" /></label><label className="block text-sm font-bold">お問い合わせ内容<textarea required name="message" maxLength={5000} rows={6} className="mt-2 w-full rounded-lg border border-border bg-background p-3 font-normal outline-none focus:border-primary" /></label><div className="flex items-center justify-between gap-4"><p className="text-sm text-primary">{status}</p><button disabled={sending} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-60">{sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}送信する</button></div></form></div></section><SiteFooter /></main>
}
