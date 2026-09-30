"use client";

import { ChevronLeft, ShieldAlert } from 'lucide-react';
import { useLocale } from '@/components/locale-provider';
import { GuildSpamPolicyPanel } from '@/components/guild-spam-policy-panel';

export default function DashboardSpamSecurityPage() {
  const { locale } = useLocale();
  const en = locale === 'en';
  return <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 sm:py-12">
    <div className="mx-auto max-w-4xl">
      <a href="/dashboard" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" />{en ? 'Dashboard' : 'ダッシュボード'}</a>
      <header className="mb-6 mt-8 flex items-center gap-3"><span className="rounded-xl bg-primary/15 p-3 text-primary"><ShieldAlert className="h-6 w-6" /></span><div><p className="text-xs font-bold uppercase tracking-widest text-primary">Security</p><h1 className="text-2xl font-black">Spam Detection</h1><p className="mt-1 text-sm text-muted-foreground">{en ? 'Per-server spam detection and response settings.' : 'サーバー別のスパム検知と対応設定'}</p></div></header>
      <GuildSpamPolicyPanel />
    </div>
  </main>;
}
