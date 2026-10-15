"use client";

import { Activity, Hash, LayoutDashboard, LineChart, Settings, ShieldCheck, Sparkles, UserRound, Users } from 'lucide-react'
import { dashboardNavigation, navigationGroups, type DashboardView, type NavigationItem } from '@/lib/dashboard-navigation'
import { SecurityNavigationLink } from './security-navigation-link'

const icons = { overview: LayoutDashboard, retention: Users, health: Activity, diagnostics: LineChart, channels: Hash, roles: ShieldCheck, insights: Sparkles, settings: Settings, account: UserRound }

export function DashboardNavigation({ activeView, en, onNavigate }: { activeView: DashboardView; en: boolean; onNavigate: (item: NavigationItem) => void }) {
  return <nav aria-label={en ? 'Dashboard navigation' : 'ダッシュボードナビゲーション'} className="space-y-5">
    {navigationGroups.map(group => <div key={group.id}>
      <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.14em] text-muted-foreground">{group.label[en ? 1 : 0]}</p>
      <div className="space-y-1">{dashboardNavigation.filter(item => item.group === group.id).map(item => {
        if (item.id === 'security') return <SecurityNavigationLink key={item.id} en={en} onNavigate={() => onNavigate(item)} />
        const Icon = icons[item.id as keyof typeof icons] ?? LayoutDashboard
        const active = item.view === activeView
        const content = <><Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{item.label[en ? 1 : 0]}</span></>
        const className = `flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-secondary'}`
        return item.view ? <button key={item.id} type="button" aria-current={active ? 'page' : undefined} className={className} onClick={() => onNavigate(item)}>{content}</button>
          : <a key={item.id} href={item.href} className={className} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate(item) } }}>{content}</a>
      })}</div>
    </div>)}
  </nav>
}
