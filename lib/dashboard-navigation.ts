export type DashboardView = 'overview' | 'analytics' | 'members' | 'messages' | 'retention' | 'health' | 'diagnostics' | 'channels' | 'roles' | 'insights'
export type NavigationTarget = { view: DashboardView; href?: never } | { href: string; view?: never }
export type NavigationItem = NavigationTarget & {
  id: string
  group: 'overview' | 'analytics' | 'manage' | 'personal' | 'help'
  label: [string, string]
  description: [string, string]
  aliases?: string
}

// Destinations are independent of rendering; Phase 2 can map view targets to URLs.
export const dashboardNavigation: NavigationItem[] = [
  { id: 'overview', group: 'overview', view: 'overview', label: ['ダッシュボード', 'Dashboard'], description: ['サーバー全体の概要', 'Server overview'] },
  { id: 'retention', group: 'analytics', view: 'retention', label: ['定着率', 'Retention'], description: ['参加後のアクティビティ定着率', 'Activity retention after joining'] },
  { id: 'health', group: 'analytics', view: 'health', label: ['Health v2 プレビュー', 'Health v2 Preview'], description: ['サーバーヘルスのプレビュー', 'Server health preview'] },
  { id: 'diagnostics', group: 'analytics', view: 'diagnostics', label: ['変化の要因', 'Diagnostics'], description: ['指標の変化を分析', 'Explore metric changes'] },
  { id: 'channels', group: 'analytics', view: 'channels', label: ['チャンネル', 'Channels'], description: ['チャンネル別の活動', 'Channel activity'] },
  { id: 'roles', group: 'analytics', view: 'roles', label: ['ロール', 'Roles'], description: ['ロール別の活動', 'Role activity'] },
  { id: 'insights', group: 'manage', view: 'insights', label: ['成長インサイト', 'Growth insights'], description: ['確認すべき変化', 'Changes worth reviewing'] },
  { id: 'settings', group: 'manage', href: '/settings', label: ['設定', 'Settings'], description: ['表示設定・サーバー別設定', 'Display and per-server settings'] },
  { id: 'security', group: 'manage', href: '/dashboard/security/spam', label: ['セキュリティー', 'Security'], description: ['サーバー別スパム対策', 'Per-server spam protection'] },
  { id: 'account', group: 'personal', href: '/account', label: ['アカウント接続', 'Account connections'], description: ['自分のGoogle・Discord連携', 'Your Google and Discord connections'] },
  { id: 'pro', group: 'help', href: '/pro', label: ['NuviloView Pro', 'NuviloView Pro'], description: ['Proプレビュー', 'Pro preview'] },
  { id: 'docs', group: 'help', href: '/docs', label: ['ドキュメント', 'Documentation'], description: ['使い方', 'How to use NuviloView'] },
  { id: 'support', group: 'help', href: '/support', label: ['サポート', 'Support'], description: ['お問い合わせ', 'Contact support'] },
  // Existing detail view, previously listed in search but routed to overview.
  { id: 'analytics', group: 'help', view: 'analytics', label: ['アナリティクス', 'Analytics'], description: ['メッセージ・メンバーの推移', 'Message and member trends'] },
]

export const navigationGroups = [
  { id: 'overview', label: ['概要', 'Overview'] },
  { id: 'analytics', label: ['分析', 'Analytics'] },
  { id: 'manage', label: ['管理', 'Manage'] },
  { id: 'personal', label: ['個人アカウント', 'Personal account'] },
] as const

export function searchNavigation(query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  return dashboardNavigation.filter(item => [...item.label, ...item.description, item.aliases ?? ''].join(' ').toLocaleLowerCase().includes(normalized))
}
